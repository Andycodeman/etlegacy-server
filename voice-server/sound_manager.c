/**
 * @file sound_manager.c
 * @brief Server-side custom sound storage and playback management
 */

#include "sound_manager.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <dirent.h>
#include <sys/stat.h>
#include <errno.h>
#include <time.h>

#ifdef _WIN32
    #include <winsock2.h>
    #include <windows.h>
    #include <direct.h>
    #define mkdir(path, mode) _mkdir(path)
    #define PATH_SEP '\\'
#else
    #include <unistd.h>
    #include <sys/wait.h>
    #include <sys/socket.h>
    #include <netinet/in.h>
    #include <arpa/inet.h>
    #define PATH_SEP '/'
#endif

/* Include minimp3 for MP3 decoding */
#define MINIMP3_IMPLEMENTATION
#include "../src/libs/minimp3/minimp3.h"

/* Include Opus for encoding */
#include <opus/opus.h>

/*
 * Constants
 */
#define SOUNDS_DIR_NAME     "sounds"
#define PENDING_DIR_NAME    "pending_shares"
#define OPUS_SAMPLE_RATE    48000
#define OPUS_CHANNELS       1
#define OPUS_FRAME_MS       20
#define OPUS_FRAME_SIZE     (OPUS_SAMPLE_RATE * OPUS_FRAME_MS / 1000)  /* 960 */
#define OPUS_BITRATE        24000
#define MAX_PENDING_DOWNLOADS   4
#define MAX_PENDING_SHARES      64

/*
 * Module state
 */
static struct {
    bool            initialized;
    char            baseDir[256];

    /* Active playback */
    SoundPlayback   playback;

    /* Pending downloads */
    DownloadRequest downloads[MAX_PENDING_DOWNLOADS];
    int             numDownloads;

    /* Pending shares */
    PendingShare    shares[MAX_PENDING_SHARES];
    int             numShares;

    /* MP3 decoder */
    mp3dec_t        mp3Decoder;

    /* Cooldown tracking per GUID */
    struct {
        char    guid[SOUND_GUID_LEN + 1];
        time_t  lastAddTime;
    } cooldowns[MAX_PENDING_DOWNLOADS * 4];
    int             numCooldowns;

} g_soundMgr;


/*
 * Forward declarations
 */
static bool ensureDir(const char *path);
static bool getPlayerDir(const char *guid, char *outPath, int outLen);
static bool getSoundPath(const char *guid, const char *name, char *outPath, int outLen);
static bool checkCooldown(const char *guid);
static void updateCooldown(const char *guid);
static bool decodeMP3(const char *filepath, int16_t **outPcm, int *outSamples);
extern void sendResponseToClient(uint32_t clientId, uint8_t respType,
                                 const char *message);
extern void broadcastOpusPacket(uint8_t fromClient, uint8_t channel,
                                uint32_t sequence, const uint8_t *opus, int opusLen);


/*
 * Initialize the sound manager
 */
bool SoundMgr_Init(const char *baseDir) {
    if (g_soundMgr.initialized) {
        return true;
    }

    memset(&g_soundMgr, 0, sizeof(g_soundMgr));

    if (baseDir && baseDir[0]) {
        snprintf(g_soundMgr.baseDir, sizeof(g_soundMgr.baseDir), "%s", baseDir);
    } else {
        snprintf(g_soundMgr.baseDir, sizeof(g_soundMgr.baseDir), ".%c%s",
                 PATH_SEP, SOUNDS_DIR_NAME);
    }

    /* Create base sounds directory */
    if (!ensureDir(g_soundMgr.baseDir)) {
        fprintf(stderr, "SoundMgr: Failed to create sounds directory: %s\n",
                g_soundMgr.baseDir);
        return false;
    }

    /* Create pending shares directory */
    char pendingDir[512];
    snprintf(pendingDir, sizeof(pendingDir), "%s%c%s",
             g_soundMgr.baseDir, PATH_SEP, PENDING_DIR_NAME);
    if (!ensureDir(pendingDir)) {
        fprintf(stderr, "SoundMgr: Failed to create pending shares directory\n");
        return false;
    }

    /* Initialize MP3 decoder */
    mp3dec_init(&g_soundMgr.mp3Decoder);

    /* Create Opus encoder for playback */
    int opusErr;
    g_soundMgr.playback.opusEncoder = opus_encoder_create(
        OPUS_SAMPLE_RATE, OPUS_CHANNELS, OPUS_APPLICATION_AUDIO, &opusErr);
    if (opusErr != OPUS_OK) {
        fprintf(stderr, "SoundMgr: Failed to create Opus encoder: %s\n",
                opus_strerror(opusErr));
        return false;
    }

    opus_encoder_ctl((OpusEncoder*)g_soundMgr.playback.opusEncoder,
                     OPUS_SET_BITRATE(OPUS_BITRATE));
    opus_encoder_ctl((OpusEncoder*)g_soundMgr.playback.opusEncoder,
                     OPUS_SET_COMPLEXITY(5));

    g_soundMgr.initialized = true;
    printf("SoundMgr: Initialized, storage at %s\n", g_soundMgr.baseDir);

    return true;
}

/*
 * Shutdown the sound manager
 */
void SoundMgr_Shutdown(void) {
    if (!g_soundMgr.initialized) {
        return;
    }

    SoundMgr_StopSound();

    if (g_soundMgr.playback.opusEncoder) {
        opus_encoder_destroy((OpusEncoder*)g_soundMgr.playback.opusEncoder);
        g_soundMgr.playback.opusEncoder = NULL;
    }

    memset(&g_soundMgr, 0, sizeof(g_soundMgr));
    printf("SoundMgr: Shutdown complete\n");
}

/*
 * Process pending operations
 */
void SoundMgr_Frame(void) {
    if (!g_soundMgr.initialized) {
        return;
    }

    /* Check download worker processes */
#ifndef _WIN32
    for (int i = 0; i < g_soundMgr.numDownloads; i++) {
        DownloadRequest *dl = &g_soundMgr.downloads[i];
        if (dl->state == DOWNLOAD_IN_PROGRESS && dl->workerPid > 0) {
            int status;
            pid_t result = waitpid(dl->workerPid, &status, WNOHANG);
            if (result > 0) {
                /* Worker finished */
                if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
                    dl->state = DOWNLOAD_COMPLETE;
                    sendResponseToClient(dl->clientId, VOICE_RESP_SUCCESS,
                        "Sound downloaded successfully!");
                    printf("SoundMgr: Download complete for %s/%s\n",
                           dl->guid, dl->name);
                } else {
                    dl->state = DOWNLOAD_FAILED;
                    /* Read error message from error file if it exists */
                    char errMsg[256] = "Download failed";
                    if (dl->errorMsg[0]) {
                        FILE *errFile = fopen(dl->errorMsg, "r");
                        if (errFile) {
                            if (fgets(errMsg, sizeof(errMsg), errFile)) {
                                /* Remove newline if present */
                                char *nl = strchr(errMsg, '\n');
                                if (nl) *nl = '\0';
                            }
                            fclose(errFile);
                            remove(dl->errorMsg);  /* Clean up error file */
                        }
                    }
                    sendResponseToClient(dl->clientId, VOICE_RESP_ERROR, errMsg);
                    printf("SoundMgr: Download failed for %s/%s: %s\n",
                           dl->guid, dl->name, errMsg);
                }
                dl->workerPid = 0;

                /* Remove from queue */
                memmove(&g_soundMgr.downloads[i],
                        &g_soundMgr.downloads[i + 1],
                        (g_soundMgr.numDownloads - i - 1) * sizeof(DownloadRequest));
                g_soundMgr.numDownloads--;
                i--;
            } else if (result == 0) {
                /* Still running - check timeout */
                if (time(NULL) - dl->startTime > SOUND_DOWNLOAD_TIMEOUT) {
                    kill(dl->workerPid, SIGTERM);
                    dl->state = DOWNLOAD_FAILED;
                    snprintf(dl->errorMsg, sizeof(dl->errorMsg), "Download timed out");
                    sendResponseToClient(dl->clientId, VOICE_RESP_ERROR,
                        "Download timed out (2 min limit)");
                }
            }
        }
    }
#endif

    /* Clean up expired share requests (5 minute timeout) */
    time_t now = time(NULL);
    for (int i = 0; i < g_soundMgr.numShares; i++) {
        if (now - g_soundMgr.shares[i].requestTime > 300) {
            memmove(&g_soundMgr.shares[i],
                    &g_soundMgr.shares[i + 1],
                    (g_soundMgr.numShares - i - 1) * sizeof(PendingShare));
            g_soundMgr.numShares--;
            i--;
        }
    }
}

/*
 * Handle incoming sound command packet
 */
void SoundMgr_HandlePacket(uint32_t clientId, struct sockaddr_in *clientAddr,
                           const uint8_t *data, int dataLen) {
    if (!g_soundMgr.initialized || dataLen < 6) {  /* type + clientId + at least 1 byte */
        return;
    }

    uint8_t cmdType = data[0];
    /* Skip type (1) and clientId (4) - clientId already extracted by caller */
    const uint8_t *payload = data + 5;
    int payloadLen = dataLen - 5;

    switch (cmdType) {
        case VOICE_CMD_SOUND_LIST: {
            /* Payload: <guid[32]> */
            if (payloadLen < SOUND_GUID_LEN) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid list request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            SoundInfo sounds[SOUND_MAX_PER_USER];
            int count = SoundMgr_ListSounds(guid, sounds, SOUND_MAX_PER_USER);

            if (count < 0) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Failed to list sounds");
                return;
            }

            /* Build response message */
            char response[2048];
            int offset = snprintf(response, sizeof(response),
                "You have %d sound%s:", count, count == 1 ? "" : "s");

            for (int i = 0; i < count && offset < (int)sizeof(response) - 64; i++) {
                offset += snprintf(response + offset, sizeof(response) - offset,
                    "\n  %s (%.1f KB)", sounds[i].name,
                    (float)sounds[i].fileSize / 1024.0f);
            }

            if (count == 0) {
                snprintf(response, sizeof(response),
                    "No sounds. Use /etman add <url> <name> to add one!");
            }

            sendResponseToClient(clientId, VOICE_RESP_LIST, response);
            break;
        }

        case VOICE_CMD_SOUND_ADD: {
            /* Payload: <guid[32]><urlLen[2]><url><name> */
            if (payloadLen < SOUND_GUID_LEN + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid add request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            uint16_t urlLen;
            memcpy(&urlLen, payload + SOUND_GUID_LEN, 2);
            urlLen = ntohs(urlLen);

            if (payloadLen < SOUND_GUID_LEN + 2 + urlLen + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid add request");
                return;
            }

            char url[512] = {0};
            char name[SOUND_MAX_NAME_LEN + 1] = {0};

            if (urlLen > sizeof(url) - 1) urlLen = sizeof(url) - 1;
            memcpy(url, payload + SOUND_GUID_LEN + 2, urlLen);

            int nameLen = payloadLen - SOUND_GUID_LEN - 2 - urlLen;
            if (nameLen > SOUND_MAX_NAME_LEN) nameLen = SOUND_MAX_NAME_LEN;
            memcpy(name, payload + SOUND_GUID_LEN + 2 + urlLen, nameLen);

            /* Validate and queue download */
            char errorMsg[128];
            if (!SoundMgr_ValidateUrl(url, errorMsg, sizeof(errorMsg))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, errorMsg);
                return;
            }

            char safeName[SOUND_MAX_NAME_LEN + 1];
            if (!SoundMgr_ValidateName(name, safeName, sizeof(safeName))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Invalid name. Use only letters, numbers, underscore.");
                return;
            }

            if (!SoundMgr_QueueDownload(clientId, guid, url, safeName)) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Could not queue download. Try again later.");
                return;
            }

            sendResponseToClient(clientId, VOICE_RESP_SUCCESS,
                "Download started. Please wait...");
            break;
        }

        case VOICE_CMD_SOUND_PLAY: {
            /* Payload: <guid[32]><name> */
            if (payloadLen < SOUND_GUID_LEN + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid play request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            char name[SOUND_MAX_NAME_LEN + 1] = {0};
            int nameLen = payloadLen - SOUND_GUID_LEN;
            if (nameLen > SOUND_MAX_NAME_LEN) nameLen = SOUND_MAX_NAME_LEN;
            memcpy(name, payload + SOUND_GUID_LEN, nameLen);

            /* Check state directly - don't rely on IsPlaying() which has extra conditions */
            if (g_soundMgr.playback.state == PLAYBACK_PLAYING ||
                g_soundMgr.playback.state == PLAYBACK_LOADING) {
                /* Force reset if stuck (position >= samples means it should be done) */
                if (g_soundMgr.playback.pcmPosition >= g_soundMgr.playback.pcmSamples) {
                    printf("SoundMgr: Forcing reset of stuck playback state\n");
                    SoundMgr_StopSound();
                } else {
                    sendResponseToClient(clientId, VOICE_RESP_ERROR,
                        "A sound is already playing. Wait or use /etman stopsnd");
                    return;
                }
            }

            if (!SoundMgr_PlaySound(clientId, guid, name)) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Failed to play sound. Does it exist?");
                return;
            }
            break;
        }

        case VOICE_CMD_SOUND_DELETE: {
            /* Payload: <guid[32]><name> */
            if (payloadLen < SOUND_GUID_LEN + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid delete request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            char name[SOUND_MAX_NAME_LEN + 1] = {0};
            int nameLen = payloadLen - SOUND_GUID_LEN;
            if (nameLen > SOUND_MAX_NAME_LEN) nameLen = SOUND_MAX_NAME_LEN;
            memcpy(name, payload + SOUND_GUID_LEN, nameLen);

            if (SoundMgr_DeleteSound(guid, name)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Deleted sound: %s", name);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Failed to delete sound. Does it exist?");
            }
            break;
        }

        case VOICE_CMD_SOUND_RENAME: {
            /* Payload: <guid[32]><oldNameLen[1]><oldName><newName> */
            if (payloadLen < SOUND_GUID_LEN + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid rename request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            uint8_t oldLen = payload[SOUND_GUID_LEN];
            if (payloadLen < SOUND_GUID_LEN + 1 + oldLen + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid rename request");
                return;
            }

            char oldName[SOUND_MAX_NAME_LEN + 1] = {0};
            char newName[SOUND_MAX_NAME_LEN + 1] = {0};

            if (oldLen > SOUND_MAX_NAME_LEN) oldLen = SOUND_MAX_NAME_LEN;
            memcpy(oldName, payload + SOUND_GUID_LEN + 1, oldLen);

            int newLen = payloadLen - SOUND_GUID_LEN - 1 - oldLen;
            if (newLen > SOUND_MAX_NAME_LEN) newLen = SOUND_MAX_NAME_LEN;
            memcpy(newName, payload + SOUND_GUID_LEN + 1 + oldLen, newLen);

            char safeNewName[SOUND_MAX_NAME_LEN + 1];
            if (!SoundMgr_ValidateName(newName, safeNewName, sizeof(safeNewName))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Invalid new name. Use only letters, numbers, underscore.");
                return;
            }

            if (SoundMgr_RenameSound(guid, oldName, safeNewName)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Renamed %s to %s", oldName, safeNewName);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Failed to rename sound. Check names.");
            }
            break;
        }

        case VOICE_CMD_SOUND_STOP: {
            /* Check state directly - don't use IsPlaying() which has extra conditions */
            if (g_soundMgr.playback.state == PLAYBACK_PLAYING ||
                g_soundMgr.playback.state == PLAYBACK_LOADING) {
                SoundMgr_StopSound();
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, "Sound stopped");
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "No sound is playing");
            }
            break;
        }

        case VOICE_CMD_SOUND_SHARE:
        case VOICE_CMD_SOUND_ACCEPT:
        case VOICE_CMD_SOUND_REJECT:
            /* TODO: Implement in Phase 6 */
            sendResponseToClient(clientId, VOICE_RESP_ERROR, "Sharing not yet implemented");
            break;

        default:
            sendResponseToClient(clientId, VOICE_RESP_ERROR, "Unknown command");
            break;
    }
}

/*
 * Count sounds for a player
 */
int SoundMgr_GetSoundCount(const char *guid) {
    char playerDir[512];
    if (!getPlayerDir(guid, playerDir, sizeof(playerDir))) {
        return 0;  /* No directory = no sounds */
    }

    DIR *dir = opendir(playerDir);
    if (!dir) {
        return 0;
    }

    int count = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_name[0] == '.') continue;

        /* Check for .mp3 extension */
        int len = strlen(entry->d_name);
        if (len > 4 && strcasecmp(entry->d_name + len - 4, ".mp3") == 0) {
            count++;
        }
    }

    closedir(dir);
    return count;
}

/*
 * List all sounds for a player
 */
int SoundMgr_ListSounds(const char *guid, SoundInfo *outList, int maxCount) {
    char playerDir[512];
    if (!getPlayerDir(guid, playerDir, sizeof(playerDir))) {
        return 0;
    }

    DIR *dir = opendir(playerDir);
    if (!dir) {
        return 0;
    }

    int count = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL && count < maxCount) {
        if (entry->d_name[0] == '.') continue;

        int len = strlen(entry->d_name);
        if (len > 4 && strcasecmp(entry->d_name + len - 4, ".mp3") == 0) {
            /* Copy name without extension */
            int nameLen = len - 4;
            if (nameLen > SOUND_MAX_NAME_LEN) nameLen = SOUND_MAX_NAME_LEN;
            memcpy(outList[count].name, entry->d_name, nameLen);
            outList[count].name[nameLen] = '\0';

            /* Get file size */
            char filepath[1024];
            snprintf(filepath, sizeof(filepath), "%s%c%s",
                     playerDir, PATH_SEP, entry->d_name);
            struct stat st;
            if (stat(filepath, &st) == 0) {
                outList[count].fileSize = st.st_size;
                outList[count].addedTime = st.st_mtime;
            }

            count++;
        }
    }

    closedir(dir);
    return count;
}

/*
 * Delete a sound
 */
bool SoundMgr_DeleteSound(const char *guid, const char *name) {
    char filepath[1024];
    if (!getSoundPath(guid, name, filepath, sizeof(filepath))) {
        return false;
    }

    if (remove(filepath) == 0) {
        printf("SoundMgr: Deleted %s/%s\n", guid, name);
        return true;
    }

    return false;
}

/*
 * Rename a sound
 */
bool SoundMgr_RenameSound(const char *guid, const char *oldName, const char *newName) {
    char oldPath[1024], newPath[1024];

    if (!getSoundPath(guid, oldName, oldPath, sizeof(oldPath))) {
        return false;
    }

    if (!getSoundPath(guid, newName, newPath, sizeof(newPath))) {
        return false;
    }

    /* Check if old exists and new doesn't */
    struct stat st;
    if (stat(oldPath, &st) != 0) {
        return false;  /* Old doesn't exist */
    }
    if (stat(newPath, &st) == 0) {
        return false;  /* New already exists */
    }

    if (rename(oldPath, newPath) == 0) {
        printf("SoundMgr: Renamed %s/%s to %s\n", guid, oldName, newName);
        return true;
    }

    return false;
}

/*
 * Queue a download
 */
bool SoundMgr_QueueDownload(uint32_t clientId, const char *guid,
                            const char *url, const char *name) {
    /* Check cooldown */
    if (!checkCooldown(guid)) {
        return false;
    }

    /* Check sound count limit */
    if (SoundMgr_GetSoundCount(guid) >= SOUND_MAX_PER_USER) {
        return false;
    }

    /* Check if download queue is full */
    if (g_soundMgr.numDownloads >= MAX_PENDING_DOWNLOADS) {
        return false;
    }

    /* Ensure player directory exists */
    char playerDir[512];
    snprintf(playerDir, sizeof(playerDir), "%s%c%s",
             g_soundMgr.baseDir, PATH_SEP, guid);
    if (!ensureDir(playerDir)) {
        return false;
    }

    /* Check if sound with this name already exists */
    char filepath[1024];
    getSoundPath(guid, name, filepath, sizeof(filepath));
    struct stat st;
    if (stat(filepath, &st) == 0) {
        /* Already exists - could overwrite or reject */
        /* For now, reject */
        return false;
    }

    /* Create download request */
    DownloadRequest *dl = &g_soundMgr.downloads[g_soundMgr.numDownloads];
    memset(dl, 0, sizeof(*dl));
    dl->state = DOWNLOAD_PENDING;
    dl->clientId = clientId;
    strncpy(dl->guid, guid, SOUND_GUID_LEN);
    strncpy(dl->name, name, SOUND_MAX_NAME_LEN);
    strncpy(dl->url, url, sizeof(dl->url) - 1);
    dl->startTime = time(NULL);

    g_soundMgr.numDownloads++;
    updateCooldown(guid);

    /* Fork worker process to handle download */
#ifndef _WIN32
    /* Create error file path for child to write error messages */
    char errorFile[1024];
    snprintf(errorFile, sizeof(errorFile), "%s.error", filepath);

    pid_t pid = fork();
    if (pid == 0) {
        /* Child process - do the download */
        /* Use curl to download, capture stderr for error details */
        char curlErr[512];
        snprintf(curlErr, sizeof(curlErr), "%s.curlerr", filepath);

        char cmd[2048];
        snprintf(cmd, sizeof(cmd),
            "curl -fsSL --max-filesize %d --max-time %d -o \"%s\" \"%s\" 2>\"%s\"",
            SOUND_MAX_FILESIZE, SOUND_DOWNLOAD_TIMEOUT, filepath, url, curlErr);
        int result = system(cmd);
        int curlExit = WEXITSTATUS(result);

        /* Write specific error message based on curl exit code */
        if (curlExit != 0) {
            FILE *errFile = fopen(errorFile, "w");
            if (errFile) {
                switch (curlExit) {
                    case 22: fprintf(errFile, "URL not found (404) or server error"); break;
                    case 28: fprintf(errFile, "Download timed out (2 min limit)"); break;
                    case 63: fprintf(errFile, "File too large (max 2MB)"); break;
                    case 6:  fprintf(errFile, "Could not resolve host"); break;
                    case 7:  fprintf(errFile, "Could not connect to server"); break;
                    case 35: fprintf(errFile, "SSL/TLS connection error"); break;
                    case 56: fprintf(errFile, "Network error during download"); break;
                    default: fprintf(errFile, "Download failed (curl error %d)", curlExit); break;
                }
                fclose(errFile);
            }
            remove(curlErr);
            _exit(curlExit);
        }

        remove(curlErr);

        /* Validate downloaded file is MP3 */
        FILE *f = fopen(filepath, "rb");
        if (f) {
            uint8_t header[3];
            if (fread(header, 1, 3, f) == 3) {
                /* Check MP3 magic bytes (ID3 or sync word) */
                bool isMP3 = (header[0] == 'I' && header[1] == 'D' && header[2] == '3') ||
                             (header[0] == 0xFF && (header[1] & 0xE0) == 0xE0);
                if (!isMP3) {
                    fclose(f);
                    remove(filepath);
                    FILE *errFile = fopen(errorFile, "w");
                    if (errFile) {
                        fprintf(errFile, "Not a valid MP3 file");
                        fclose(errFile);
                    }
                    _exit(100);
                }
            }
            fclose(f);
        }

        _exit(0);
    } else if (pid > 0) {
        dl->workerPid = pid;
        dl->state = DOWNLOAD_IN_PROGRESS;
        /* Store error file path for later reading */
        snprintf(dl->errorMsg, sizeof(dl->errorMsg), "%s", errorFile);
    } else {
        /* Fork failed */
        g_soundMgr.numDownloads--;
        return false;
    }
#else
    /* Windows: synchronous download (TODO: thread) */
    char cmd[2048];
    snprintf(cmd, sizeof(cmd),
        "curl -fsSL --max-filesize %d --max-time %d -o \"%s\" \"%s\"",
        SOUND_MAX_FILESIZE, SOUND_DOWNLOAD_TIMEOUT, filepath, url);
    int result = system(cmd);
    if (result == 0) {
        dl->state = DOWNLOAD_COMPLETE;
    } else {
        dl->state = DOWNLOAD_FAILED;
        g_soundMgr.numDownloads--;
        return false;
    }
#endif

    printf("SoundMgr: Queued download for %s/%s from %s\n", guid, name, url);
    return true;
}

/*
 * Play a sound
 */
bool SoundMgr_PlaySound(uint32_t clientId, const char *guid, const char *name) {
    /* State check is now done by caller - but double-check anyway */
    if (g_soundMgr.playback.state == PLAYBACK_PLAYING) {
        printf("SoundMgr: PlaySound called while state=PLAYING (should not happen)\n");
        return false;
    }

    char filepath[1024];
    if (!getSoundPath(guid, name, filepath, sizeof(filepath))) {
        printf("SoundMgr: PlaySound failed - getSoundPath returned false for guid='%s' name='%s'\n", guid, name);
        return false;
    }

    printf("SoundMgr: PlaySound trying filepath: %s\n", filepath);

    /* Check file exists */
    struct stat st;
    if (stat(filepath, &st) != 0) {
        printf("SoundMgr: PlaySound failed - file not found: %s (errno=%d)\n", filepath, errno);
        return false;
    }

    printf("SoundMgr: PlaySound file exists, size=%ld\n", (long)st.st_size);

    /* Decode MP3 to PCM */
    int16_t *pcmData = NULL;
    int pcmSamples = 0;
    if (!decodeMP3(filepath, &pcmData, &pcmSamples)) {
        printf("SoundMgr: PlaySound failed - decodeMP3 failed\n");
        return false;
    }

    /* Check duration limit */
    int durationSec = pcmSamples / OPUS_SAMPLE_RATE;
    if (durationSec > SOUND_MAX_DURATION_SEC) {
        /* Truncate to max duration */
        pcmSamples = SOUND_MAX_DURATION_SEC * OPUS_SAMPLE_RATE;
        printf("SoundMgr: Truncated sound to %d seconds\n", SOUND_MAX_DURATION_SEC);
    }

    /* Setup playback */
    if (g_soundMgr.playback.pcmBuffer) {
        free(g_soundMgr.playback.pcmBuffer);
    }

    g_soundMgr.playback.pcmBuffer = pcmData;
    g_soundMgr.playback.pcmSamples = pcmSamples;
    g_soundMgr.playback.pcmPosition = 0;
    g_soundMgr.playback.clientId = clientId;
    g_soundMgr.playback.sequence = 0;
    g_soundMgr.playback.state = PLAYBACK_PLAYING;
    strncpy(g_soundMgr.playback.guid, guid, SOUND_GUID_LEN);
    strncpy(g_soundMgr.playback.name, name, SOUND_MAX_NAME_LEN);

    printf("SoundMgr: Playing %s/%s (%d samples, %.1f sec)\n",
           guid, name, pcmSamples, (float)pcmSamples / OPUS_SAMPLE_RATE);

    return true;
}

/*
 * Stop playback
 */
void SoundMgr_StopSound(void) {
    if (g_soundMgr.playback.pcmBuffer) {
        free(g_soundMgr.playback.pcmBuffer);
        g_soundMgr.playback.pcmBuffer = NULL;
    }
    g_soundMgr.playback.state = PLAYBACK_IDLE;
    g_soundMgr.playback.pcmPosition = 0;
}

/*
 * Check if playing
 */
bool SoundMgr_IsPlaying(void) {
    return g_soundMgr.playback.state == PLAYBACK_PLAYING &&
           g_soundMgr.playback.pcmPosition < g_soundMgr.playback.pcmSamples;
}

/*
 * Get the client ID of who initiated playback
 */
uint32_t SoundMgr_GetPlaybackClientId(void) {
    if (g_soundMgr.playback.state == PLAYBACK_PLAYING) {
        return g_soundMgr.playback.clientId;
    }
    return 255;  /* No playback active */
}

/*
 * Get next Opus packet
 */
bool SoundMgr_GetNextOpusPacket(uint8_t *outBuffer, int *outLen) {
    /* Debug: log state on first call */
    static int debugCounter = 0;
    if (debugCounter == 0 && g_soundMgr.playback.state == PLAYBACK_PLAYING) {
        printf("SoundMgr: GetNextOpusPacket starting, state=%d, pos=%d, samples=%d\n",
               g_soundMgr.playback.state,
               g_soundMgr.playback.pcmPosition,
               g_soundMgr.playback.pcmSamples);
    }

    if (!SoundMgr_IsPlaying()) {
        if (debugCounter > 0) {
            printf("SoundMgr: GetNextOpusPacket done after %d packets\n", debugCounter);
            debugCounter = 0;
        }
        return false;
    }

    int remaining = g_soundMgr.playback.pcmSamples - g_soundMgr.playback.pcmPosition;
    if (remaining <= 0) {
        printf("SoundMgr: Playback complete, sent %d packets\n", debugCounter);
        debugCounter = 0;
        g_soundMgr.playback.state = PLAYBACK_IDLE;
        return false;
    }

    debugCounter++;

    int16_t frame[OPUS_FRAME_SIZE];
    int samplesToEncode = (remaining >= OPUS_FRAME_SIZE) ? OPUS_FRAME_SIZE : remaining;

    /* Copy samples, zero-pad if needed */
    memcpy(frame, g_soundMgr.playback.pcmBuffer + g_soundMgr.playback.pcmPosition,
           samplesToEncode * sizeof(int16_t));
    if (samplesToEncode < OPUS_FRAME_SIZE) {
        memset(frame + samplesToEncode, 0,
               (OPUS_FRAME_SIZE - samplesToEncode) * sizeof(int16_t));
    }

    g_soundMgr.playback.pcmPosition += samplesToEncode;

    /* Encode to Opus */
    int encoded = opus_encode((OpusEncoder*)g_soundMgr.playback.opusEncoder,
                              frame, OPUS_FRAME_SIZE, outBuffer, 512);
    if (encoded < 0) {
        printf("SoundMgr: Opus encode error: %s\n", opus_strerror(encoded));
        /* Reset state on error so we don't get stuck */
        g_soundMgr.playback.state = PLAYBACK_IDLE;
        return false;
    }

    *outLen = encoded;
    g_soundMgr.playback.sequence++;

    return true;
}

/*
 * Validate sound name
 */
bool SoundMgr_ValidateName(const char *name, char *outName, int outLen) {
    if (!name || name[0] == '\0') {
        return false;
    }

    int i = 0, o = 0;
    while (name[i] && o < outLen - 1) {
        char c = name[i];
        /* Allow alphanumeric and underscore only */
        if ((c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            c == '_') {
            outName[o++] = tolower(c);
        }
        i++;
    }
    outName[o] = '\0';

    /* Must have at least 1 character */
    return o > 0;
}

/*
 * Validate download URL
 */
bool SoundMgr_ValidateUrl(const char *url, char *errorMsg, int errorLen) {
    if (!url || url[0] == '\0') {
        snprintf(errorMsg, errorLen, "No URL provided");
        return false;
    }

    /* Check scheme */
    if (strncmp(url, "http://", 7) != 0 && strncmp(url, "https://", 8) != 0) {
        snprintf(errorMsg, errorLen, "URL must start with http:// or https://");
        return false;
    }

    /* Check length */
    if (strlen(url) > 500) {
        snprintf(errorMsg, errorLen, "URL too long (max 500 chars)");
        return false;
    }

    /* Block private/local IPs */
    const char *host = strstr(url, "://") + 3;
    if (strncmp(host, "localhost", 9) == 0 ||
        strncmp(host, "127.", 4) == 0 ||
        strncmp(host, "192.168.", 8) == 0 ||
        strncmp(host, "10.", 3) == 0 ||
        strncmp(host, "172.16.", 7) == 0 ||
        strncmp(host, "172.17.", 7) == 0 ||
        strncmp(host, "172.18.", 7) == 0 ||
        strncmp(host, "172.19.", 7) == 0 ||
        strncmp(host, "172.2", 5) == 0 ||
        strncmp(host, "172.30.", 7) == 0 ||
        strncmp(host, "172.31.", 7) == 0 ||
        strncmp(host, "0.", 2) == 0 ||
        strncmp(host, "[", 1) == 0) {  /* Block IPv6 for now */
        snprintf(errorMsg, errorLen, "Cannot download from private/local addresses");
        return false;
    }

    return true;
}


/*
 * Helper: Ensure directory exists
 */
static bool ensureDir(const char *path) {
    struct stat st;
    if (stat(path, &st) == 0) {
        return S_ISDIR(st.st_mode);
    }
    return mkdir(path, 0755) == 0;
}

/*
 * Helper: Get player directory path
 */
static bool getPlayerDir(const char *guid, char *outPath, int outLen) {
    if (!guid || guid[0] == '\0') {
        return false;
    }

    snprintf(outPath, outLen, "%s%c%s", g_soundMgr.baseDir, PATH_SEP, guid);
    return true;
}

/*
 * Helper: Get sound file path
 */
static bool getSoundPath(const char *guid, const char *name, char *outPath, int outLen) {
    if (!guid || !name || guid[0] == '\0' || name[0] == '\0') {
        return false;
    }

    snprintf(outPath, outLen, "%s%c%s%c%s.mp3",
             g_soundMgr.baseDir, PATH_SEP, guid, PATH_SEP, name);
    return true;
}

/*
 * Helper: Check add cooldown
 */
static bool checkCooldown(const char *guid) {
    time_t now = time(NULL);
    for (int i = 0; i < g_soundMgr.numCooldowns; i++) {
        if (strcmp(g_soundMgr.cooldowns[i].guid, guid) == 0) {
            if (now - g_soundMgr.cooldowns[i].lastAddTime < SOUND_ADD_COOLDOWN_SEC) {
                return false;
            }
            return true;
        }
    }
    return true;
}

/*
 * Helper: Update add cooldown
 */
static void updateCooldown(const char *guid) {
    time_t now = time(NULL);

    /* Find existing entry */
    for (int i = 0; i < g_soundMgr.numCooldowns; i++) {
        if (strcmp(g_soundMgr.cooldowns[i].guid, guid) == 0) {
            g_soundMgr.cooldowns[i].lastAddTime = now;
            return;
        }
    }

    /* Add new entry */
    if (g_soundMgr.numCooldowns < (int)(sizeof(g_soundMgr.cooldowns) / sizeof(g_soundMgr.cooldowns[0]))) {
        strncpy(g_soundMgr.cooldowns[g_soundMgr.numCooldowns].guid, guid, SOUND_GUID_LEN);
        g_soundMgr.cooldowns[g_soundMgr.numCooldowns].lastAddTime = now;
        g_soundMgr.numCooldowns++;
    }
}

/*
 * Helper: Decode MP3 to PCM (48kHz mono)
 */
static bool decodeMP3(const char *filepath, int16_t **outPcm, int *outSamples) {
    FILE *f = fopen(filepath, "rb");
    if (!f) {
        return false;
    }

    /* Read entire file */
    fseek(f, 0, SEEK_END);
    long fileSize = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (fileSize <= 0 || fileSize > SOUND_MAX_FILESIZE) {
        fclose(f);
        return false;
    }

    uint8_t *mp3Data = (uint8_t*)malloc(fileSize);
    if (!mp3Data) {
        fclose(f);
        return false;
    }

    if (fread(mp3Data, 1, fileSize, f) != (size_t)fileSize) {
        free(mp3Data);
        fclose(f);
        return false;
    }
    fclose(f);

    /* Decode */
    mp3dec_frame_info_t frameInfo;
    int16_t frameBuffer[MINIMP3_MAX_SAMPLES_PER_FRAME];

    int maxSamples = OPUS_SAMPLE_RATE * SOUND_MAX_DURATION_SEC;
    int16_t *pcmBuffer = (int16_t*)malloc(maxSamples * sizeof(int16_t));
    if (!pcmBuffer) {
        free(mp3Data);
        return false;
    }

    int totalSamples = 0;
    int offset = 0;

    while (offset < fileSize && totalSamples < maxSamples) {
        int samples = mp3dec_decode_frame(&g_soundMgr.mp3Decoder,
                                          mp3Data + offset,
                                          fileSize - offset,
                                          frameBuffer,
                                          &frameInfo);

        if (samples <= 0) {
            if (frameInfo.frame_bytes <= 0) break;
            offset += frameInfo.frame_bytes;
            continue;
        }

        offset += frameInfo.frame_bytes;

        /* Convert to mono if stereo */
        if (frameInfo.channels == 2) {
            for (int i = 0; i < samples && totalSamples < maxSamples; i++) {
                pcmBuffer[totalSamples++] = (frameBuffer[i * 2] + frameBuffer[i * 2 + 1]) / 2;
            }
        } else {
            int copyCount = samples;
            if (totalSamples + copyCount > maxSamples) {
                copyCount = maxSamples - totalSamples;
            }
            memcpy(pcmBuffer + totalSamples, frameBuffer, copyCount * sizeof(int16_t));
            totalSamples += copyCount;
        }

        /* Handle sample rate conversion if needed */
        /* For simplicity, we assume MP3 is close to 48kHz */
        /* A proper implementation would resample here */
    }

    free(mp3Data);

    if (totalSamples == 0) {
        free(pcmBuffer);
        return false;
    }

    *outPcm = pcmBuffer;
    *outSamples = totalSamples;

    return true;
}
