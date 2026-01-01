/**
 * @file sound_manager.c
 * @brief Server-side custom sound storage and playback management
 */

#include "sound_manager.h"
#include "db_manager.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <dirent.h>
#include <sys/stat.h>
#include <errno.h>
#include <time.h>
#include <uuid/uuid.h>

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
#define OPUS_BITRATE        64000  /* 64kbps for much better music quality */
#define MAX_PENDING_DOWNLOADS   4
#define MAX_PENDING_SHARES      64

/*
 * Cached pending shares for index-based accept/reject
 */
#define MAX_CACHED_CLIENTS      64
#define MAX_CACHED_SHARES       32

typedef struct {
    uint32_t        clientId;
    time_t          cacheTime;
    int             count;
    struct {
        int         soundFileId;
        char        fromGuid[SOUND_GUID_LEN + 1];
        char        suggestedAlias[SOUND_MAX_NAME_LEN + 1];
    } shares[MAX_CACHED_SHARES];
} CachedPendingShares;

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

    /* Cached pending shares for index-based lookup */
    CachedPendingShares cachedShares[MAX_CACHED_CLIENTS];
    int             numCachedClients;

    /* MP3 decoder */
    mp3dec_t        mp3Decoder;

    /* Cooldown tracking per GUID (for add requests) */
    struct {
        char    guid[SOUND_GUID_LEN + 1];
        time_t  lastAddTime;
    } cooldowns[MAX_PENDING_DOWNLOADS * 4];
    int             numCooldowns;

    /* Play rate limiting per GUID (burst limit with cooldown) */
    struct {
        char    guid[SOUND_GUID_LEN + 1];
        int     burstCount;         /* Number of sounds played in current burst */
        time_t  firstPlayTime;      /* Time of first play in current burst window */
        time_t  cooldownUntil;      /* If set, player is in cooldown until this time */
    } playRateLimits[64];           /* Track up to 64 players */
    int             numPlayRateLimits;

    /* Database mode (Phase 2) */
    bool            dbMode;         /* If true, use PostgreSQL for metadata */

} g_soundMgr;


/*
 * Forward declarations
 */
static bool ensureDir(const char *path);
static bool getPlayerDir(const char *guid, char *outPath, int outLen);
static bool getSoundPath(const char *guid, const char *name, char *outPath, int outLen);
static bool checkCooldown(const char *guid);
static void updateCooldown(const char *guid);
static bool checkPlayRateLimit(const char *guid, int *outCooldownRemaining);
static bool updatePlayRateLimit(const char *guid);
static bool decodeMP3(const char *filepath, int16_t **outPcm, int *outSamples);
static bool SoundMgr_PlaySoundByPath(uint32_t clientId, const char *guid,
                                     const char *name, const char *filepath);
extern void sendResponseToClient(uint32_t clientId, uint8_t respType,
                                 const char *message);
extern void sendBinaryToClient(uint32_t clientId, uint8_t respType,
                               const uint8_t *data, int dataLen);
extern void broadcastOpusPacket(uint8_t fromClient, uint8_t channel,
                                uint32_t sequence, const uint8_t *opus, int opusLen);
extern void resetSoundPlaybackTiming(void);

/*
 * Store pending shares for a client (for index-based accept/reject)
 */
static void storePendingSharesForClient(uint32_t clientId, DBShareListResult *result, int count) {
    /* Find existing or get new slot */
    int slot = -1;
    for (int i = 0; i < g_soundMgr.numCachedClients; i++) {
        if (g_soundMgr.cachedShares[i].clientId == clientId) {
            slot = i;
            break;
        }
    }

    if (slot < 0) {
        if (g_soundMgr.numCachedClients < MAX_CACHED_CLIENTS) {
            slot = g_soundMgr.numCachedClients++;
        } else {
            /* Evict oldest entry */
            time_t oldest = time(NULL);
            slot = 0;
            for (int i = 1; i < MAX_CACHED_CLIENTS; i++) {
                if (g_soundMgr.cachedShares[i].cacheTime < oldest) {
                    oldest = g_soundMgr.cachedShares[i].cacheTime;
                    slot = i;
                }
            }
        }
    }

    CachedPendingShares *cache = &g_soundMgr.cachedShares[slot];
    cache->clientId = clientId;
    cache->cacheTime = time(NULL);
    cache->count = (count > MAX_CACHED_SHARES) ? MAX_CACHED_SHARES : count;

    for (int i = 0; i < cache->count; i++) {
        cache->shares[i].soundFileId = result->shares[i].soundFileId;
        strncpy(cache->shares[i].fromGuid, result->shares[i].fromGuid, SOUND_GUID_LEN);
        cache->shares[i].fromGuid[SOUND_GUID_LEN] = '\0';
        strncpy(cache->shares[i].suggestedAlias, result->shares[i].suggestedAlias, SOUND_MAX_NAME_LEN);
        cache->shares[i].suggestedAlias[SOUND_MAX_NAME_LEN] = '\0';
    }

    printf("SoundMgr: Cached %d pending shares for client %u\n", cache->count, clientId);
}

/*
 * Get pending share by index (1-based) for a client
 * Returns true if found, fills outSoundFileId and outFromGuid
 */
static bool getPendingShareByIndex(uint32_t clientId, int index,
                                   int *outSoundFileId, char *outFromGuid,
                                   char *outSuggestedAlias) {
    for (int i = 0; i < g_soundMgr.numCachedClients; i++) {
        if (g_soundMgr.cachedShares[i].clientId == clientId) {
            CachedPendingShares *cache = &g_soundMgr.cachedShares[i];

            /* Check cache age (5 minute expiry) */
            if (time(NULL) - cache->cacheTime > 300) {
                return false;  /* Cache expired */
            }

            /* Convert 1-based index to 0-based */
            int idx = index - 1;
            if (idx < 0 || idx >= cache->count) {
                return false;  /* Out of range */
            }

            *outSoundFileId = cache->shares[idx].soundFileId;
            strncpy(outFromGuid, cache->shares[idx].fromGuid, SOUND_GUID_LEN + 1);
            if (outSuggestedAlias) {
                strncpy(outSuggestedAlias, cache->shares[idx].suggestedAlias, SOUND_MAX_NAME_LEN + 1);
            }
            return true;
        }
    }
    return false;
}


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

    /* Try to initialize database connection (Phase 2) */
    const char *dbUrl = getenv("DATABASE_URL");
    if (dbUrl && dbUrl[0]) {
        if (DB_Init(NULL)) {
            g_soundMgr.dbMode = true;
            printf("SoundMgr: Database mode ENABLED\n");
        } else {
            printf("SoundMgr: Database connection failed, using filesystem mode\n");
            printf("SoundMgr: Error: %s\n", DB_GetLastError());
            g_soundMgr.dbMode = false;
        }
    } else {
        printf("SoundMgr: DATABASE_URL not set, using filesystem mode\n");
        g_soundMgr.dbMode = false;
    }

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

    /* Shutdown database connection */
    if (g_soundMgr.dbMode) {
        DB_Shutdown();
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
    if (!g_soundMgr.initialized || dataLen < 5) {  /* type + clientId (some commands have no payload) */
        printf("[DEBUG] SoundMgr_HandlePacket: rejected (init=%d, len=%d)\n",
               g_soundMgr.initialized, dataLen);
        return;
    }

    uint8_t cmdType = data[0];
    printf("[DEBUG] SoundMgr_HandlePacket: cmdType=0x%02X, dataLen=%d, clientId=%u\n",
           cmdType, dataLen, clientId);
    /* Skip type (1) and clientId (4) - clientId already extracted by caller */
    const uint8_t *payload = data + 5;
    int payloadLen = dataLen - 5;

    switch (cmdType) {
        case VOICE_CMD_SOUND_LIST: {
            /* Use server-stored GUID, not what client sends */
            char guid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, guid, sizeof(guid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated - reconnect to server");
                return;
            }

            printf("[DEBUG] SOUND_LIST: clientId=%u, using GUID=%s\n", clientId, guid);

            SoundInfo sounds[SOUND_MAX_PER_USER];
            int count = SoundMgr_ListSounds(guid, sounds, SOUND_MAX_PER_USER);
            printf("[DEBUG] SOUND_LIST: got %d sounds for GUID %s\n", count, guid);

            if (count < 0) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Failed to list sounds");
                return;
            }

            if (count == 0) {
                sendResponseToClient(clientId, VOICE_RESP_LIST,
                    "No sounds. Use /etman add <url> <name> to add one!");
                break;
            }

            /* Build response messages - split into chunks to avoid truncation */
            /* Each sound entry is ~30 chars max, aim for ~25 per message */
            #define SOUNDS_PER_MSG 25
            #define RESP_BUF_SIZE 1024

            int msgNum = 0;
            int totalMsgs = (count + SOUNDS_PER_MSG - 1) / SOUNDS_PER_MSG;

            for (int start = 0; start < count; start += SOUNDS_PER_MSG) {
                char response[RESP_BUF_SIZE];
                int offset;
                int end = start + SOUNDS_PER_MSG;
                if (end > count) end = count;

                msgNum++;
                if (totalMsgs == 1) {
                    offset = snprintf(response, sizeof(response),
                        "You have %d sound%s:", count, count == 1 ? "" : "s");
                } else {
                    offset = snprintf(response, sizeof(response),
                        "Sounds (%d/%d) - %d total:", msgNum, totalMsgs, count);
                }

                for (int i = start; i < end && offset < (int)sizeof(response) - 64; i++) {
                    offset += snprintf(response + offset, sizeof(response) - offset,
                        "\n  %s (%.1fKB)", sounds[i].name,
                        (float)sounds[i].fileSize / 1024.0f);
                }

                sendResponseToClient(clientId, VOICE_RESP_LIST, response);
            }
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

            /* Use server-stored GUID (handles shared sounds correctly) */
            char guid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, guid, sizeof(guid))) {
                /* Fallback to packet GUID if not found */
                memcpy(guid, payload, SOUND_GUID_LEN);
                guid[SOUND_GUID_LEN] = '\0';
            }

            char name[SOUND_MAX_NAME_LEN + 1] = {0};
            int nameLen = payloadLen - SOUND_GUID_LEN;
            if (nameLen > SOUND_MAX_NAME_LEN) nameLen = SOUND_MAX_NAME_LEN;
            memcpy(name, payload + SOUND_GUID_LEN, nameLen);

            /* Check rate limit (5 sounds burst, then 5 second cooldown) */
            int cooldownRemaining = 0;
            if (!checkPlayRateLimit(guid, &cooldownRemaining)) {
                char msg[64];
                snprintf(msg, sizeof(msg), "Rate limited. Wait %d seconds.", cooldownRemaining);
                sendResponseToClient(clientId, VOICE_RESP_ERROR, msg);
                return;
            }

            /* Interrupt mode: if a sound is playing, stop it and play the new one */
            if (g_soundMgr.playback.state == PLAYBACK_PLAYING ||
                g_soundMgr.playback.state == PLAYBACK_LOADING) {
                printf("SoundMgr: Interrupting current sound to play '%s'\n", name);
                SoundMgr_StopSound();
            }

            if (!SoundMgr_PlaySound(clientId, guid, name)) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Failed to play sound. Does it exist?");
                return;
            }

            /* Update rate limit tracking (after successful play) */
            updatePlayRateLimit(guid);
            break;
        }

        case VOICE_CMD_SOUND_DELETE: {
            /* Payload: <guid[32]><name> - use server-stored GUID */
            if (payloadLen < SOUND_GUID_LEN + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid delete request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, guid, sizeof(guid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated - reconnect to server");
                return;
            }

            /* Name starts after the guid in the packet */
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
            /* Payload: <guid[32]><oldNameLen[1]><oldName><newName> - use server-stored GUID */
            if (payloadLen < SOUND_GUID_LEN + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid rename request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, guid, sizeof(guid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated - reconnect to server");
                return;
            }

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

        case VOICE_CMD_SOUND_SHARE: {
            /* Payload: <guid[32]><soundNameLen[1]><soundName><targetPlayerName> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Sharing requires database mode");
                return;
            }
            if (payloadLen < SOUND_GUID_LEN + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid share request");
                return;
            }

            char fromGuid[SOUND_GUID_LEN + 1];
            memcpy(fromGuid, payload, SOUND_GUID_LEN);
            fromGuid[SOUND_GUID_LEN] = '\0';

            uint8_t soundNameLen = payload[SOUND_GUID_LEN];
            if (payloadLen < SOUND_GUID_LEN + 1 + soundNameLen + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid share request");
                return;
            }

            char soundName[SOUND_MAX_NAME_LEN + 1] = {0};
            if (soundNameLen > SOUND_MAX_NAME_LEN) soundNameLen = SOUND_MAX_NAME_LEN;
            memcpy(soundName, payload + SOUND_GUID_LEN + 1, soundNameLen);

            /* Get target player name */
            char targetPlayerName[64] = {0};
            int targetNameLen = payloadLen - SOUND_GUID_LEN - 1 - soundNameLen;
            if (targetNameLen > 63) targetNameLen = 63;
            if (targetNameLen > 0) {
                memcpy(targetPlayerName, payload + SOUND_GUID_LEN + 1 + soundNameLen, targetNameLen);
            }

            /* Look up target player's GUID by name */
            char toGuid[SOUND_GUID_LEN + 1] = {0};
            char actualPlayerName[64] = {0};
            char lookupError[128] = {0};
            if (!getGuidByPlayerName(targetPlayerName, toGuid, sizeof(toGuid),
                                      actualPlayerName, sizeof(actualPlayerName),
                                      lookupError, sizeof(lookupError))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, lookupError);
                return;
            }

            /* Don't allow sharing with yourself */
            if (strcmp(fromGuid, toGuid) == 0) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Cannot share with yourself");
                return;
            }

            /* Get sender's player name for the share record */
            char senderPlayerName[64] = {0};
            getPlayerNameByClientId(clientId, senderPlayerName, sizeof(senderPlayerName));

            if (DB_CreateShare(fromGuid, toGuid, soundName, soundName, senderPlayerName)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Shared '%s' with %s", soundName, actualPlayerName);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_SOUND_ACCEPT: {
            /* Payload: <guid[32]><fromGuid[32]><index[4]><alias>
             * The index is a 1-based number from /etman pending list
             * We look up the actual soundFileId and fromGuid from our cache
             * Use server-stored GUID, not what client sends */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Sharing requires database mode");
                return;
            }

            char toGuid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, toGuid, sizeof(toGuid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated - reconnect to server");
                return;
            }

            /* Skip the guid and dummy fromGuid in packet, get index */
            /* The client sends an index (1-based) not the actual soundFileId */
            uint32_t index;
            memcpy(&index, payload + SOUND_GUID_LEN + SOUND_GUID_LEN, 4);
            index = ntohl(index);

            /* Get alias from packet (after guid + dummy fromGuid + index) */
            char alias[SOUND_MAX_NAME_LEN + 1] = {0};
            int aliasLen = payloadLen - SOUND_GUID_LEN - SOUND_GUID_LEN - 4;
            if (aliasLen > SOUND_MAX_NAME_LEN) aliasLen = SOUND_MAX_NAME_LEN;
            if (aliasLen > 0) {
                memcpy(alias, payload + SOUND_GUID_LEN + SOUND_GUID_LEN + 4, aliasLen);
            }

            /* Look up the actual soundFileId and fromGuid from cache */
            int soundFileId;
            char fromGuid[SOUND_GUID_LEN + 1];
            char suggestedAlias[SOUND_MAX_NAME_LEN + 1];
            if (!getPendingShareByIndex(clientId, (int)index, &soundFileId, fromGuid, suggestedAlias)) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Invalid share #. Run /etman pending first to see current list");
                return;
            }

            /* If no alias provided, use the suggested alias */
            if (alias[0] == '\0') {
                strncpy(alias, suggestedAlias, SOUND_MAX_NAME_LEN);
                alias[SOUND_MAX_NAME_LEN] = '\0';
            }

            if (DB_AcceptShare(toGuid, fromGuid, soundFileId, alias)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Accepted share #%d as '%s'", (int)index, alias);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_SOUND_REJECT: {
            /* Payload: <guid[32]><fromGuid[32]><index[4]>
             * The index is a 1-based number from /etman pending list
             * We look up the actual soundFileId and fromGuid from our cache
             * Use server-stored GUID, not what client sends */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Sharing requires database mode");
                return;
            }

            char toGuid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, toGuid, sizeof(toGuid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated - reconnect to server");
                return;
            }

            /* The client sends an index (1-based) not the actual soundFileId */
            uint32_t index;
            memcpy(&index, payload + SOUND_GUID_LEN + SOUND_GUID_LEN, 4);
            index = ntohl(index);

            /* Look up the actual soundFileId and fromGuid from cache */
            int soundFileId;
            char fromGuid[SOUND_GUID_LEN + 1];
            if (!getPendingShareByIndex(clientId, (int)index, &soundFileId, fromGuid, NULL)) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Invalid share #. Run /etman pending first to see current list");
                return;
            }

            if (DB_RejectShare(toGuid, fromGuid, soundFileId)) {
                char msg[64];
                snprintf(msg, sizeof(msg), "Rejected share #%d", (int)index);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_SOUND_PLAYLIST_CREATE: {
            /* Payload: <guid[32]><name> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Playlists require database mode");
                return;
            }
            if (payloadLen < SOUND_GUID_LEN + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid playlist create request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            char name[SOUND_MAX_NAME_LEN + 1] = {0};
            int nameLen = payloadLen - SOUND_GUID_LEN;
            if (nameLen > SOUND_MAX_NAME_LEN) nameLen = SOUND_MAX_NAME_LEN;
            memcpy(name, payload + SOUND_GUID_LEN, nameLen);

            char safeName[SOUND_MAX_NAME_LEN + 1];
            if (!SoundMgr_ValidateName(name, safeName, sizeof(safeName))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Invalid name. Use only letters, numbers, underscore.");
                return;
            }

            int playlistId;
            if (DB_CreatePlaylist(guid, safeName, NULL, &playlistId)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Created playlist: %s", safeName);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_SOUND_PLAYLIST_DELETE: {
            /* Payload: <guid[32]><name> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Playlists require database mode");
                return;
            }
            if (payloadLen < SOUND_GUID_LEN + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid playlist delete request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            char name[SOUND_MAX_NAME_LEN + 1] = {0};
            int nameLen = payloadLen - SOUND_GUID_LEN;
            if (nameLen > SOUND_MAX_NAME_LEN) nameLen = SOUND_MAX_NAME_LEN;
            memcpy(name, payload + SOUND_GUID_LEN, nameLen);

            if (DB_DeletePlaylist(guid, name)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Deleted playlist: %s", name);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_SOUND_PLAYLIST_LIST:
        case VOICE_CMD_SOUND_CATEGORIES: {
            /* Payload: <guid[32]>[playlistName] - optional playlist name for contents */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Playlists require database mode");
                return;
            }
            if (payloadLen < SOUND_GUID_LEN) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid playlists request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            /* Check if a playlist name was provided */
            if (payloadLen > SOUND_GUID_LEN) {
                /* Get contents of specific playlist */
                char playlistName[SOUND_MAX_NAME_LEN + 1] = {0};
                int nameLen = payloadLen - SOUND_GUID_LEN;
                if (nameLen > SOUND_MAX_NAME_LEN) nameLen = SOUND_MAX_NAME_LEN;
                memcpy(playlistName, payload + SOUND_GUID_LEN, nameLen);

                DBPlaylistItemsResult result;
                int count = DB_GetPlaylistSounds(guid, playlistName, &result);

                if (count < 0) {
                    sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
                    return;
                }

                if (count == 0) {
                    char msg[128];
                    snprintf(msg, sizeof(msg), "Playlist '%s' is empty. Use /etman playlist add %s <sound>",
                             playlistName, playlistName);
                    sendResponseToClient(clientId, VOICE_RESP_LIST, msg);
                    break;
                }

                char response[1024];
                int offset = snprintf(response, sizeof(response),
                    "Playlist '%s' (%d sounds):", playlistName, count);

                for (int i = 0; i < count && offset < (int)sizeof(response) - 64; i++) {
                    offset += snprintf(response + offset, sizeof(response) - offset,
                        "\n  #%d: %s", result.items[i].orderNumber, result.items[i].alias);
                }

                sendResponseToClient(clientId, VOICE_RESP_LIST, response);
            } else {
                /* List all playlists */
                DBPlaylistListResult result;
                int count = DB_ListPlaylists(guid, &result);

                if (count < 0) {
                    sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
                    return;
                }

                if (count == 0) {
                    sendResponseToClient(clientId, VOICE_RESP_LIST,
                        "No playlists. Use /etman playlist create <name>");
                    break;
                }

                char response[1024];
                int offset = snprintf(response, sizeof(response),
                    "You have %d playlist%s:", count, count == 1 ? "" : "s");

                for (int i = 0; i < count && offset < (int)sizeof(response) - 64; i++) {
                    offset += snprintf(response + offset, sizeof(response) - offset,
                        "\n  %s (%d sounds)", result.playlists[i].name,
                        result.playlists[i].soundCount);
                }

                sendResponseToClient(clientId, VOICE_RESP_LIST, response);
            }
            break;
        }

        case VOICE_CMD_SOUND_PLAYLIST_ADD: {
            /* Payload: <guid[32]><playlistNameLen[1]><playlistName><soundAlias> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Playlists require database mode");
                return;
            }
            if (payloadLen < SOUND_GUID_LEN + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid playlist add request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            uint8_t playlistLen = payload[SOUND_GUID_LEN];
            if (payloadLen < SOUND_GUID_LEN + 1 + playlistLen + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid playlist add request");
                return;
            }

            char playlistName[SOUND_MAX_NAME_LEN + 1] = {0};
            char soundAlias[SOUND_MAX_NAME_LEN + 1] = {0};

            if (playlistLen > SOUND_MAX_NAME_LEN) playlistLen = SOUND_MAX_NAME_LEN;
            memcpy(playlistName, payload + SOUND_GUID_LEN + 1, playlistLen);

            int soundLen = payloadLen - SOUND_GUID_LEN - 1 - playlistLen;
            if (soundLen > SOUND_MAX_NAME_LEN) soundLen = SOUND_MAX_NAME_LEN;
            memcpy(soundAlias, payload + SOUND_GUID_LEN + 1 + playlistLen, soundLen);

            if (DB_AddToPlaylist(guid, playlistName, soundAlias)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Added '%s' to playlist '%s'",
                         soundAlias, playlistName);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_SOUND_PLAYLIST_REMOVE: {
            /* Payload: <guid[32]><playlistNameLen[1]><playlistName><soundAlias> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Playlists require database mode");
                return;
            }
            if (payloadLen < SOUND_GUID_LEN + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid playlist remove request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            uint8_t playlistLen = payload[SOUND_GUID_LEN];
            if (payloadLen < SOUND_GUID_LEN + 1 + playlistLen + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid playlist remove request");
                return;
            }

            char playlistName[SOUND_MAX_NAME_LEN + 1] = {0};
            char soundAlias[SOUND_MAX_NAME_LEN + 1] = {0};

            if (playlistLen > SOUND_MAX_NAME_LEN) playlistLen = SOUND_MAX_NAME_LEN;
            memcpy(playlistName, payload + SOUND_GUID_LEN + 1, playlistLen);

            int soundLen = payloadLen - SOUND_GUID_LEN - 1 - playlistLen;
            if (soundLen > SOUND_MAX_NAME_LEN) soundLen = SOUND_MAX_NAME_LEN;
            memcpy(soundAlias, payload + SOUND_GUID_LEN + 1 + playlistLen, soundLen);

            if (DB_RemoveFromPlaylist(guid, playlistName, soundAlias)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Removed '%s' from playlist '%s'",
                         soundAlias, playlistName);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_SOUND_PLAYLIST_PLAY: {
            /* Payload: <guid[32]><playlistNameLen[1]><playlistName><position[1]> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Playlists require database mode");
                return;
            }
            if (payloadLen < SOUND_GUID_LEN + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid playlist play request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            uint8_t playlistLen = payload[SOUND_GUID_LEN];
            if (payloadLen < SOUND_GUID_LEN + 1 + playlistLen) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid playlist play request");
                return;
            }

            char playlistName[SOUND_MAX_NAME_LEN + 1] = {0};
            if (playlistLen > SOUND_MAX_NAME_LEN) playlistLen = SOUND_MAX_NAME_LEN;
            memcpy(playlistName, payload + SOUND_GUID_LEN + 1, playlistLen);

            /* Position is optional - 0 means use current position, 255 means random */
            int position = 0;
            bool isRandom = false;
            if (payloadLen > SOUND_GUID_LEN + 1 + playlistLen) {
                position = payload[SOUND_GUID_LEN + 1 + playlistLen];
                if (position == 255) {
                    isRandom = true;
                    position = 0;  /* Will be set to random below */
                }
            }

            /* Check playback state */
            if (g_soundMgr.playback.state == PLAYBACK_PLAYING ||
                g_soundMgr.playback.state == PLAYBACK_LOADING) {
                if (g_soundMgr.playback.pcmPosition >= g_soundMgr.playback.pcmSamples) {
                    SoundMgr_StopSound();
                } else {
                    sendResponseToClient(clientId, VOICE_RESP_ERROR,
                        "A sound is already playing. Wait or use /etman stopsnd");
                    return;
                }
            }

            /* Get sound at position - try user's playlist first, then public */
            DBPlaylistItem item;
            bool isPublicPlaylist = false;

            /* For random, first get total count then pick random position */
            if (isRandom) {
                DBPlaylistItemsResult itemsResult;
                int totalItems = DB_GetPlaylistSounds(guid, playlistName, &itemsResult);
                if (totalItems <= 0) {
                    /* Try public playlist */
                    totalItems = DB_GetPublicPlaylistSounds(playlistName, &itemsResult);
                    if (totalItems <= 0) {
                        sendResponseToClient(clientId, VOICE_RESP_ERROR,
                            "Playlist not found or empty");
                        return;
                    }
                    isPublicPlaylist = true;
                }
                position = (rand() % totalItems) + 1;  /* 1-based position */
                printf("SoundMgr: Random position %d of %d in '%s'\n", position, totalItems, playlistName);
            }

            if (!DB_GetPlaylistSoundAtPosition(guid, playlistName, position, &item)) {
                /* Not found in user's playlists - try public */
                int publicPos = (position == 0) ? 1 : position;
                if (!DB_GetPublicPlaylistSoundAtPosition(playlistName, publicPos, &item)) {
                    sendResponseToClient(clientId, VOICE_RESP_ERROR,
                        "Playlist not found (checked your playlists and public)");
                    return;
                }
                isPublicPlaylist = true;
                printf("SoundMgr: Playing from public playlist '%s'\n", playlistName);
            }

            /* Play the sound using the file path from DB */
            if (!SoundMgr_PlaySoundByPath(clientId, guid, item.alias, item.filePath)) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Failed to play sound from playlist");
                return;
            }

            /* Advance position for next time (only for user's own playlists) */
            if (!isPublicPlaylist) {
                DBPlaylistItemsResult itemsResult;
                int totalItems = DB_GetPlaylistSounds(guid, playlistName, &itemsResult);
                int nextPos = (position == 0 ? DB_GetPlaylistPosition(guid, playlistName) : position) + 1;
                if (nextPos > totalItems) nextPos = 1;  /* Wrap around */
                DB_SetPlaylistPosition(guid, playlistName, nextPos);
            }
            break;
        }

        case VOICE_CMD_SOUND_PLAYLIST_REORDER: {
            /* For now, just acknowledge - full reorder needs array parsing */
            sendResponseToClient(clientId, VOICE_RESP_ERROR,
                "Reorder via web panel (ETPanel) only");
            break;
        }

        case VOICE_CMD_SOUND_SET_VISIBILITY: {
            /* Payload: <guid[32]><aliasLen[1]><alias><visibility> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Visibility requires database mode");
                return;
            }
            if (payloadLen < SOUND_GUID_LEN + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid visibility request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            uint8_t aliasLen = payload[SOUND_GUID_LEN];
            if (payloadLen < SOUND_GUID_LEN + 1 + aliasLen + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid visibility request");
                return;
            }

            char alias[SOUND_MAX_NAME_LEN + 1] = {0};
            char visibility[16] = {0};

            if (aliasLen > SOUND_MAX_NAME_LEN) aliasLen = SOUND_MAX_NAME_LEN;
            memcpy(alias, payload + SOUND_GUID_LEN + 1, aliasLen);

            int visLen = payloadLen - SOUND_GUID_LEN - 1 - aliasLen;
            if (visLen > 15) visLen = 15;
            memcpy(visibility, payload + SOUND_GUID_LEN + 1 + aliasLen, visLen);

            if (DB_SetVisibility(guid, alias, visibility)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Set '%s' to %s", alias, visibility);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_SOUND_PUBLIC_LIST: {
            /* Payload: <offset[2]> (optional) */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Public library requires database mode");
                return;
            }

            int offset = 0;
            if (payloadLen >= 2) {
                uint16_t off;
                memcpy(&off, payload, 2);
                offset = ntohs(off);
            }

            DBSoundListResult result;
            int count = DB_ListPublicSounds(&result, 25, offset);

            if (count < 0) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
                return;
            }

            if (count == 0) {
                sendResponseToClient(clientId, VOICE_RESP_LIST,
                    "No public sounds available. Make yours public with /etman visibility <name> public");
                break;
            }

            char response[1024];
            int respOffset = snprintf(response, sizeof(response),
                "Public sounds (%d shown):", count);

            for (int i = 0; i < count && respOffset < (int)sizeof(response) - 64; i++) {
                respOffset += snprintf(response + respOffset, sizeof(response) - respOffset,
                    "\n  [%d] %s (%.1fKB)", result.sounds[i].soundFileId,
                    result.sounds[i].alias,
                    (float)result.sounds[i].fileSize / 1024.0f);
            }

            sendResponseToClient(clientId, VOICE_RESP_LIST, response);
            break;
        }

        case VOICE_CMD_SOUND_PUBLIC_ADD: {
            /* Payload: <guid[32]><soundFileId[4]><alias> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Public library requires database mode");
                return;
            }
            if (payloadLen < SOUND_GUID_LEN + 4 + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid public add request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            uint32_t soundFileId;
            memcpy(&soundFileId, payload + SOUND_GUID_LEN, 4);
            soundFileId = ntohl(soundFileId);

            char alias[SOUND_MAX_NAME_LEN + 1] = {0};
            int aliasLen = payloadLen - SOUND_GUID_LEN - 4;
            if (aliasLen > SOUND_MAX_NAME_LEN) aliasLen = SOUND_MAX_NAME_LEN;
            memcpy(alias, payload + SOUND_GUID_LEN + 4, aliasLen);

            char safeAlias[SOUND_MAX_NAME_LEN + 1];
            if (!SoundMgr_ValidateName(alias, safeAlias, sizeof(safeAlias))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR,
                    "Invalid name. Use only letters, numbers, underscore.");
                return;
            }

            if (DB_AddFromPublic(guid, soundFileId, safeAlias)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Added public sound as '%s'", safeAlias);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_SOUND_PENDING: {
            /* Use server-stored GUID, not what client sends */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Sharing requires database mode");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, guid, sizeof(guid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated - reconnect to server");
                return;
            }

            DBShareListResult result;
            int count = DB_ListPendingShares(guid, &result);

            if (count < 0) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
                return;
            }

            if (count == 0) {
                sendResponseToClient(clientId, VOICE_RESP_LIST, "No pending share requests");
                break;
            }

            /* Store pending shares for this client so we can look them up by index */
            storePendingSharesForClient(clientId, &result, count);

            char response[1024];
            int respOffset = snprintf(response, sizeof(response),
                "Pending shares (%d):", count);

            /* Show simple index numbers (1, 2, 3...) instead of database IDs */
            for (int i = 0; i < count && respOffset < (int)sizeof(response) - 96; i++) {
                respOffset += snprintf(response + respOffset, sizeof(response) - respOffset,
                    "\n  #%d: '%s' from %s",
                    i + 1,  /* Simple 1-based index */
                    result.shares[i].suggestedAlias,
                    result.shares[i].fromPlayerName);
            }

            sendResponseToClient(clientId, VOICE_RESP_LIST, response);
            break;
        }

        case VOICE_CMD_PLAYLIST_PUBLIC_LIST: {
            /* List all public playlists */
            printf("[DEBUG] VOICE_CMD_PLAYLIST_PUBLIC_LIST received from client %u\n", clientId);

            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Playlists require database mode");
                return;
            }

            DBPlaylistListResult result;
            int count = DB_ListPublicPlaylists(&result);
            printf("[DEBUG] DB_ListPublicPlaylists returned %d\n", count);

            if (count < 0) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
                return;
            }

            if (count == 0) {
                sendResponseToClient(clientId, VOICE_RESP_LIST,
                    "No public playlists available");
                break;
            }

            char response[1024];
            int respOffset = snprintf(response, sizeof(response),
                "Public playlists (%d):", count);

            for (int i = 0; i < count && respOffset < (int)sizeof(response) - 64; i++) {
                respOffset += snprintf(response + respOffset, sizeof(response) - respOffset,
                    "\n  %s (%d sounds)", result.playlists[i].name, result.playlists[i].soundCount);
            }

            sendResponseToClient(clientId, VOICE_RESP_LIST, response);
            break;
        }

        case VOICE_CMD_PLAYLIST_SET_VISIBILITY: {
            /* Payload: <guid[32]><nameLen[1]><name><isPublic[1]> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Playlists require database mode");
                return;
            }

            /* Use server-stored GUID */
            char guid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, guid, sizeof(guid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated - reconnect to server");
                return;
            }

            if (payloadLen < SOUND_GUID_LEN + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid visibility request");
                return;
            }

            uint8_t nameLen = payload[SOUND_GUID_LEN];
            if (payloadLen < SOUND_GUID_LEN + 1 + nameLen + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid visibility request");
                return;
            }

            char playlistName[SOUND_MAX_NAME_LEN + 1] = {0};
            if (nameLen > SOUND_MAX_NAME_LEN) nameLen = SOUND_MAX_NAME_LEN;
            memcpy(playlistName, payload + SOUND_GUID_LEN + 1, nameLen);

            bool isPublic = payload[SOUND_GUID_LEN + 1 + nameLen] != 0;

            if (DB_SetPlaylistVisibility(guid, playlistName, isPublic)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Playlist '%s' is now %s",
                         playlistName, isPublic ? "public" : "private");
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_ACCOUNT_REGISTER: {
            /* Payload: <guid[32]><playerName> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Registration requires database mode");
                return;
            }
            if (payloadLen < SOUND_GUID_LEN + 1) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid register request");
                return;
            }

            char guid[SOUND_GUID_LEN + 1];
            memcpy(guid, payload, SOUND_GUID_LEN);
            guid[SOUND_GUID_LEN] = '\0';

            char playerName[64] = {0};
            int nameLen = payloadLen - SOUND_GUID_LEN;
            if (nameLen > 63) nameLen = 63;
            memcpy(playerName, payload + SOUND_GUID_LEN, nameLen);

            char code[7];
            if (DB_CreateVerificationCode(guid, playerName, code)) {
                char msg[256];
                snprintf(msg, sizeof(msg),
                    "Your registration code: %s\n"
                    "Visit ETPanel to link your account:\n"
                    "https://etpanel.etman.dev\n"
                    "Code expires in 10 minutes.", code);
                sendResponseToClient(clientId, VOICE_RESP_REGISTER_CODE, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
            }
            break;
        }

        case VOICE_CMD_PLAYLIST_PUBLIC_SHOW: {
            /* Payload: <nameLen[1]><name><position[1]> */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Playlists require database mode");
                return;
            }

            if (payloadLen < 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid request");
                return;
            }

            uint8_t nameLen = payload[0];
            if (nameLen > SOUND_MAX_NAME_LEN || payloadLen < nameLen + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid playlist name");
                return;
            }

            char playlistName[SOUND_MAX_NAME_LEN + 1];
            memcpy(playlistName, payload + 1, nameLen);
            playlistName[nameLen] = '\0';

            uint8_t position = payload[1 + nameLen];
            bool isRandom = false;

            /* Handle special positions: 0=list, 254=next(play #1), 255=random */
            if (position == 255) {
                isRandom = true;
            }

            if (position == 0) {
                /* List songs in the public playlist */
                DBPlaylistItemsResult result;
                int count = DB_GetPublicPlaylistSounds(playlistName, &result);

                if (count < 0) {
                    sendResponseToClient(clientId, VOICE_RESP_ERROR, DB_GetLastError());
                    return;
                }

                if (count == 0) {
                    char msg[128];
                    snprintf(msg, sizeof(msg), "Public playlist '%s' is empty or not found", playlistName);
                    sendResponseToClient(clientId, VOICE_RESP_LIST, msg);
                    return;
                }

                char response[2048];
                int respOffset = snprintf(response, sizeof(response),
                    "Public playlist '%s' (%d sounds):", playlistName, count);

                for (int i = 0; i < count && respOffset < (int)sizeof(response) - 64; i++) {
                    respOffset += snprintf(response + respOffset, sizeof(response) - respOffset,
                        "\n  [%d] %s", i + 1, result.items[i].alias);
                }

                sendResponseToClient(clientId, VOICE_RESP_LIST, response);
            } else {
                /* Play sound from public playlist */
                int actualPosition = position;

                /* For random or "next" (254), get count first */
                if (isRandom || position == 254) {
                    DBPlaylistItemsResult itemsResult;
                    int count = DB_GetPublicPlaylistSounds(playlistName, &itemsResult);
                    if (count <= 0) {
                        sendResponseToClient(clientId, VOICE_RESP_ERROR,
                            "Public playlist not found or empty");
                        return;
                    }
                    if (isRandom) {
                        actualPosition = (rand() % count) + 1;
                        printf("SoundMgr: Random position %d of %d in public playlist '%s'\n",
                               actualPosition, count, playlistName);
                    } else {
                        actualPosition = 1;  /* "next" for public just plays #1 */
                    }
                }

                DBPlaylistItem item;
                if (!DB_GetPublicPlaylistSoundAtPosition(playlistName, actualPosition, &item)) {
                    char msg[128];
                    snprintf(msg, sizeof(msg), "No sound at position %d in public playlist '%s'",
                             actualPosition, playlistName);
                    sendResponseToClient(clientId, VOICE_RESP_ERROR, msg);
                    return;
                }

                /* Play the sound using the file path from the item */
                if (!SoundMgr_PlaySoundByPath(clientId, NULL, item.alias, item.filePath)) {
                    sendResponseToClient(clientId, VOICE_RESP_ERROR, "Failed to play sound");
                    return;
                }

                char msg[128];
                snprintf(msg, sizeof(msg), "Playing '%s' from public playlist '%s'",
                         item.alias, playlistName);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            }
            break;
        }

        case VOICE_CMD_MENU_GET: {
            /* Get user's sound menus */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Menus require database mode");
                break;
            }

            char guid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, guid, sizeof(guid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated");
                break;
            }

            /* Use HEAP to avoid stack overflow - DBMenuResult is ~6KB */
            DBMenuResult *menus = malloc(sizeof(DBMenuResult));
            if (!menus) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Memory allocation failed");
                break;
            }

            if (!DB_GetUserMenus(guid, menus)) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Failed to get menus");
                free(menus);
                break;
            }

            /* Build binary response for client:
             * [menuCount:1]
             * per menu: [position:1][nameLen:1][name][itemCount:1]
             * per item: [position:1][nameLen:1][name][aliasLen:1][alias]
             */
            uint8_t response[2048];
            int offset = 0;

            if (menus->count == 0) {
                /* Send NO_MENUS marker */
                memcpy(response, "NO_MENUS", 8);
                sendBinaryToClient(clientId, VOICE_RESP_MENU_DATA, response, 8);
                free(menus);
                break;
            }

            response[offset++] = (uint8_t)menus->count;

            for (int m = 0; m < menus->count && offset < 2000; m++) {
                DBMenu *menu = &menus->menus[m];
                int nameLen = strlen(menu->name);

                response[offset++] = (uint8_t)menu->position;
                response[offset++] = (uint8_t)nameLen;
                memcpy(response + offset, menu->name, nameLen);
                offset += nameLen;
                response[offset++] = (uint8_t)menu->itemCount;

                for (int i = 0; i < menu->itemCount && offset < 2000; i++) {
                    DBMenuItem *item = &menu->items[i];
                    int itemNameLen = strlen(item->name);
                    int aliasLen = strlen(item->soundAlias);

                    response[offset++] = (uint8_t)item->position;
                    response[offset++] = (uint8_t)itemNameLen;
                    memcpy(response + offset, item->name, itemNameLen);
                    offset += itemNameLen;
                    response[offset++] = (uint8_t)aliasLen;
                    memcpy(response + offset, item->soundAlias, aliasLen);
                    offset += aliasLen;
                }
            }

            printf("[MENU] Sending %d menus (%d bytes) to client %u\n",
                   menus->count, offset, clientId);
            sendBinaryToClient(clientId, VOICE_RESP_MENU_DATA, response, offset);
            free(menus);
            break;
        }

        case VOICE_CMD_MENU_PLAY: {
            /* Play sound from menu position */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Menus require database mode");
                break;
            }

            if (payloadLen < 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid menu play request");
                break;
            }

            char guid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, guid, sizeof(guid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated");
                break;
            }

            int menuPos = payload[0];
            int itemPos = payload[1];

            char filePath[512];
            if (!DB_GetMenuItemSound(guid, menuPos, itemPos, filePath, sizeof(filePath))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Sound not found in menu");
                break;
            }

            /* Play the sound file using existing function */
            if (SoundMgr_PlaySoundByPath(clientId, guid, "menu", filePath)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Playing menu %d item %d", menuPos, itemPos);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Failed to play sound");
            }
            break;
        }

        case VOICE_CMD_MENU_NAVIGATE: {
            /* Hierarchical menu navigation - get specific menu page */
            printf("[DEBUG] MENU_NAVIGATE: received, payloadLen=%d\n", payloadLen);

            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Menus require database mode");
                break;
            }

            char guid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, guid, sizeof(guid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated");
                break;
            }

            printf("[DEBUG] MENU_NAVIGATE: clientId=%u, guid=%s\n", clientId, guid);

            /* Parse menuId and pageOffset from payload
             * Payload format: [guid:32][menuId:4][pageOffset:2]
             * Total: 38 bytes minimum
             */
            if (payloadLen < SOUND_GUID_LEN + 6) {
                printf("[DEBUG] MENU_NAVIGATE: payload too short (%d < %d)\n",
                       payloadLen, SOUND_GUID_LEN + 6);
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid request");
                break;
            }

            uint32_t menuIdNet;
            uint16_t pageOffsetNet;
            memcpy(&menuIdNet, payload + SOUND_GUID_LEN, 4);
            memcpy(&pageOffsetNet, payload + SOUND_GUID_LEN + 4, 2);
            int menuId = ntohl(menuIdNet);
            int pageOffset = ntohs(pageOffsetNet);

            printf("[DEBUG] MENU_NAVIGATE: menuId=%d, pageOffset=%d\n", menuId, pageOffset);

            DBMenuPageResult result;
            if (!DB_GetMenuPage(guid, menuId, pageOffset, &result)) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Menu not found");
                break;
            }

            /* Build hierarchical binary response:
             * [menuId:4][totalItems:2][pageOffset:2][itemCount:1]
             * per item: [position:1][itemType:1][nameLen:1][name][dataLen:1][data]
             * For sounds: data = alias
             * For menus: data = nestedMenuId[4]
             */
            uint8_t response[2048];
            int offset = 0;

            uint32_t menuIdResp = htonl(result.menu.menuId);
            uint16_t totalItemsResp = htons(result.menu.totalItems);
            uint16_t pageOffsetResp = htons(result.menu.pageOffset);

            memcpy(response + offset, &menuIdResp, 4); offset += 4;
            memcpy(response + offset, &totalItemsResp, 2); offset += 2;
            memcpy(response + offset, &pageOffsetResp, 2); offset += 2;
            response[offset++] = (uint8_t)result.menu.itemCount;

            for (int i = 0; i < result.menu.itemCount && offset < 2000; i++) {
                DBMenuItem *item = &result.menu.items[i];
                int nameLen = strlen(item->name);

                response[offset++] = (uint8_t)item->position;
                response[offset++] = (uint8_t)item->itemType;
                response[offset++] = (uint8_t)nameLen;
                memcpy(response + offset, item->name, nameLen);
                offset += nameLen;

                if (item->itemType == DB_MENU_ITEM_MENU) {
                    /* Menu: send nestedMenuId (4 bytes) */
                    response[offset++] = 4;
                    uint32_t nestedIdNet = htonl(item->nestedMenuId);
                    memcpy(response + offset, &nestedIdNet, 4);
                    offset += 4;
                } else {
                    /* Sound: send alias */
                    int aliasLen = strlen(item->soundAlias);
                    response[offset++] = (uint8_t)aliasLen;
                    memcpy(response + offset, item->soundAlias, aliasLen);
                    offset += aliasLen;
                }
            }

            printf("[DEBUG] MENU_NAVIGATE: built response, offset=%d bytes\n", offset);
            printf("[MENU] Sending menu page (id=%d, items=%d/%d, page=%d) to client %u\n",
                   result.menu.menuId, result.menu.itemCount, result.menu.totalItems,
                   pageOffset / 9 + 1, clientId);
            sendBinaryToClient(clientId, VOICE_RESP_MENU_DATA, response, offset);
            break;
        }

        case VOICE_CMD_SOUND_BY_ID: {
            /* Play sound by database ID (user_sounds.id or public sound_files.id) */
            if (!g_soundMgr.dbMode) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Requires database mode");
                break;
            }

            char guid[SOUND_GUID_LEN + 1];
            if (!getGuidByClientId(clientId, guid, sizeof(guid))) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Not authenticated");
                break;
            }

            /* Parse soundId from payload (2 bytes for now, could be 4 for larger IDs) */
            if (payloadLen < SOUND_GUID_LEN + 2) {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Invalid request");
                break;
            }

            uint16_t soundIdNet;
            memcpy(&soundIdNet, payload + SOUND_GUID_LEN, 2);
            int soundId = ntohs(soundIdNet);

            char filePath[512], soundName[64];
            if (!DB_GetSoundById(guid, soundId, filePath, sizeof(filePath), soundName, sizeof(soundName))) {
                char msg[64];
                snprintf(msg, sizeof(msg), "Sound #%d not found", soundId);
                sendResponseToClient(clientId, VOICE_RESP_ERROR, msg);
                break;
            }

            printf("[PLAYID] Playing sound #%d (%s) for client %u\n", soundId, soundName, clientId);

            if (SoundMgr_PlaySoundByPath(clientId, guid, soundName, filePath)) {
                char msg[128];
                snprintf(msg, sizeof(msg), "Playing #%d: %s", soundId, soundName);
                sendResponseToClient(clientId, VOICE_RESP_SUCCESS, msg);
            } else {
                sendResponseToClient(clientId, VOICE_RESP_ERROR, "Failed to play sound");
            }
            break;
        }

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
 * Comparison function for sorting SoundInfo alphabetically by name
 */
static int compareSoundInfo(const void *a, const void *b) {
    const SoundInfo *sa = (const SoundInfo *)a;
    const SoundInfo *sb = (const SoundInfo *)b;
    return strcasecmp(sa->name, sb->name);
}

/*
 * List all sounds for a player (sorted alphabetically)
 */
int SoundMgr_ListSounds(const char *guid, SoundInfo *outList, int maxCount) {
    /* In database mode, query user_sounds table which includes shared sounds */
    if (g_soundMgr.dbMode) {
        return DB_ListUserSounds(guid, outList, maxCount);
    }

    /* Filesystem-only mode (legacy) */
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

    /* Sort alphabetically by name */
    if (count > 1) {
        qsort(outList, count, sizeof(SoundInfo), compareSoundInfo);
    }

    return count;
}

/*
 * Delete a sound
 */
bool SoundMgr_DeleteSound(const char *guid, const char *name) {
    /* In database mode, delete from user_sounds table */
    if (g_soundMgr.dbMode) {
        char filePathToDelete[1024] = {0};
        if (DB_DeleteSound(guid, name, filePathToDelete)) {
            /* If filePathToDelete is set, the file should be deleted from disk */
            if (filePathToDelete[0]) {
                char fullPath[1024];
                snprintf(fullPath, sizeof(fullPath), "%s%c%s",
                         g_soundMgr.baseDir, PATH_SEP, filePathToDelete);
                remove(fullPath);  /* Best effort, ignore errors */
                printf("SoundMgr: Deleted file %s\n", fullPath);
            }
            printf("SoundMgr: Deleted %s/%s from database\n", guid, name);
            return true;
        }
        return false;
    }

    /* Filesystem-only mode (legacy) */
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
    /* In database mode, just update the alias in user_sounds (file stays the same) */
    if (g_soundMgr.dbMode) {
        if (DB_RenameSound(guid, oldName, newName)) {
            printf("SoundMgr: Renamed %s/%s to %s in database\n", guid, oldName, newName);
            return true;
        }
        return false;
    }

    /* Filesystem-only mode (legacy) */
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

    /* In database mode, lookup file_path from database (handles shared sounds) */
    if (g_soundMgr.dbMode) {
        char foundPath[512];

        /*
         * Search order:
         * 1. User's local sounds (direct sounds + sounds in user's playlists)
         * 2. All public sounds (public sound_files + public user aliases + public playlists)
         */
        if (DB_FindSoundByAlias(guid, name, foundPath, sizeof(foundPath))) {
            /* Found in user's local library or playlists */
            snprintf(filepath, sizeof(filepath), "%s%c%s",
                     g_soundMgr.baseDir, PATH_SEP, foundPath);
            printf("SoundMgr: PlaySound (DB) found in local library/playlist: %s\n", filepath);
        } else if (DB_FindPublicSoundByAlias(name, foundPath, sizeof(foundPath))) {
            /* Found in public sounds or public playlists */
            snprintf(filepath, sizeof(filepath), "%s%c%s",
                     g_soundMgr.baseDir, PATH_SEP, foundPath);
            printf("SoundMgr: PlaySound (DB) found in public library/playlist: %s\n", filepath);
        } else {
            printf("SoundMgr: PlaySound failed - '%s' not found in local or public sounds for guid='%s'\n",
                   name, guid);
            return false;
        }
    } else {
        /* Filesystem-only mode - use direct path lookup */
        if (!getSoundPath(guid, name, filepath, sizeof(filepath))) {
            printf("SoundMgr: PlaySound failed - getSoundPath returned false for guid='%s' name='%s'\n", guid, name);
            return false;
        }
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

    /* Reset Opus encoder state to avoid garbled audio at start of new sounds.
     * The encoder carries state from previous encoding which corrupts the
     * first few frames of a new stream. */
    if (g_soundMgr.playback.opusEncoder) {
        opus_encoder_ctl((OpusEncoder*)g_soundMgr.playback.opusEncoder, OPUS_RESET_STATE);
    }

    /* Reset playback timing so sequence starts at 0 */
    resetSoundPlaybackTiming();

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
 * Play sound by direct file path (for DB mode)
 */
static bool SoundMgr_PlaySoundByPath(uint32_t clientId, const char *guid,
                                     const char *name, const char *filepath) {
    if (g_soundMgr.playback.state == PLAYBACK_PLAYING) {
        printf("SoundMgr: PlaySoundByPath called while state=PLAYING\n");
        return false;
    }

    /* Build full path from base directory + relative filepath */
    char fullPath[1024];
    snprintf(fullPath, sizeof(fullPath), "%s%c%s",
             g_soundMgr.baseDir, PATH_SEP, filepath);

    printf("SoundMgr: PlaySoundByPath trying filepath: %s\n", fullPath);

    /* Check file exists */
    struct stat st;
    if (stat(fullPath, &st) != 0) {
        printf("SoundMgr: PlaySoundByPath failed - file not found: %s\n", fullPath);
        return false;
    }

    /* Decode MP3 to PCM */
    int16_t *pcmData = NULL;
    int pcmSamples = 0;
    if (!decodeMP3(fullPath, &pcmData, &pcmSamples)) {
        printf("SoundMgr: PlaySoundByPath failed - decodeMP3 failed\n");
        return false;
    }

    /* Check duration limit */
    int durationSec = pcmSamples / OPUS_SAMPLE_RATE;
    if (durationSec > SOUND_MAX_DURATION_SEC) {
        pcmSamples = SOUND_MAX_DURATION_SEC * OPUS_SAMPLE_RATE;
        printf("SoundMgr: Truncated sound to %d seconds\n", SOUND_MAX_DURATION_SEC);
    }

    /* Setup playback */
    if (g_soundMgr.playback.pcmBuffer) {
        free(g_soundMgr.playback.pcmBuffer);
    }

    /* Reset Opus encoder state to avoid garbled audio at start of new sounds.
     * The encoder carries state from previous encoding which corrupts the
     * first few frames of a new stream. */
    if (g_soundMgr.playback.opusEncoder) {
        opus_encoder_ctl((OpusEncoder*)g_soundMgr.playback.opusEncoder, OPUS_RESET_STATE);
    }

    /* Reset playback timing so sequence starts at 0 */
    resetSoundPlaybackTiming();

    g_soundMgr.playback.pcmBuffer = pcmData;
    g_soundMgr.playback.pcmSamples = pcmSamples;
    g_soundMgr.playback.pcmPosition = 0;
    g_soundMgr.playback.clientId = clientId;
    g_soundMgr.playback.sequence = 0;
    g_soundMgr.playback.state = PLAYBACK_PLAYING;
    if (guid) {
        strncpy(g_soundMgr.playback.guid, guid, SOUND_GUID_LEN);
    } else {
        g_soundMgr.playback.guid[0] = '\0';
    }
    strncpy(g_soundMgr.playback.name, name, SOUND_MAX_NAME_LEN);

    printf("SoundMgr: Playing (by path) %s (%d samples, %.1f sec)\n",
           name, pcmSamples, (float)pcmSamples / OPUS_SAMPLE_RATE);

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
 * Helper: Check play rate limit for a player
 * Returns true if player can play, false if rate limited
 * Also returns remaining cooldown seconds via outCooldownRemaining (if not NULL)
 */
static bool checkPlayRateLimit(const char *guid, int *outCooldownRemaining) {
    time_t now = time(NULL);

    /* Find existing entry for this player */
    for (int i = 0; i < g_soundMgr.numPlayRateLimits; i++) {
        if (strcmp(g_soundMgr.playRateLimits[i].guid, guid) == 0) {
            /* Check if in cooldown */
            if (g_soundMgr.playRateLimits[i].cooldownUntil > now) {
                if (outCooldownRemaining) {
                    *outCooldownRemaining = (int)(g_soundMgr.playRateLimits[i].cooldownUntil - now);
                }
                return false;
            }

            /* Cooldown expired - reset if needed */
            if (g_soundMgr.playRateLimits[i].cooldownUntil > 0) {
                g_soundMgr.playRateLimits[i].cooldownUntil = 0;
                g_soundMgr.playRateLimits[i].burstCount = 0;
                g_soundMgr.playRateLimits[i].firstPlayTime = 0;
            }

            return true;
        }
    }

    /* No entry = no rate limit */
    return true;
}

/*
 * Helper: Update play rate limit after a play
 * Returns true if play is allowed, false if this play triggers cooldown
 */
static bool updatePlayRateLimit(const char *guid) {
    time_t now = time(NULL);
    int slot = -1;

    /* Find existing entry */
    for (int i = 0; i < g_soundMgr.numPlayRateLimits; i++) {
        if (strcmp(g_soundMgr.playRateLimits[i].guid, guid) == 0) {
            slot = i;
            break;
        }
    }

    /* Create new entry if needed */
    if (slot < 0) {
        if (g_soundMgr.numPlayRateLimits < 64) {
            slot = g_soundMgr.numPlayRateLimits++;
            memset(&g_soundMgr.playRateLimits[slot], 0, sizeof(g_soundMgr.playRateLimits[0]));
            strncpy(g_soundMgr.playRateLimits[slot].guid, guid, SOUND_GUID_LEN);
            g_soundMgr.playRateLimits[slot].guid[SOUND_GUID_LEN] = '\0';
        } else {
            /* Table full - evict oldest (slot 0) and shift */
            memmove(&g_soundMgr.playRateLimits[0], &g_soundMgr.playRateLimits[1],
                    sizeof(g_soundMgr.playRateLimits[0]) * 63);
            slot = 63;
            memset(&g_soundMgr.playRateLimits[slot], 0, sizeof(g_soundMgr.playRateLimits[0]));
            strncpy(g_soundMgr.playRateLimits[slot].guid, guid, SOUND_GUID_LEN);
            g_soundMgr.playRateLimits[slot].guid[SOUND_GUID_LEN] = '\0';
        }
    }

    /* If cooldown just expired, reset burst */
    if (g_soundMgr.playRateLimits[slot].cooldownUntil > 0 &&
        g_soundMgr.playRateLimits[slot].cooldownUntil <= now) {
        g_soundMgr.playRateLimits[slot].cooldownUntil = 0;
        g_soundMgr.playRateLimits[slot].burstCount = 0;
        g_soundMgr.playRateLimits[slot].firstPlayTime = 0;
    }

    /* Start new burst window if needed */
    if (g_soundMgr.playRateLimits[slot].burstCount == 0) {
        g_soundMgr.playRateLimits[slot].firstPlayTime = now;
    }

    /* Increment burst count */
    g_soundMgr.playRateLimits[slot].burstCount++;

    /* Check if burst limit reached */
    if (g_soundMgr.playRateLimits[slot].burstCount >= SOUND_PLAY_BURST_LIMIT) {
        /* Trigger cooldown */
        g_soundMgr.playRateLimits[slot].cooldownUntil = now + SOUND_PLAY_COOLDOWN_SEC;
        printf("SoundMgr: Player %s hit burst limit (%d sounds), cooldown for %d seconds\n",
               guid, SOUND_PLAY_BURST_LIMIT, SOUND_PLAY_COOLDOWN_SEC);
        return true;  /* This play is still allowed, but next will be blocked */
    }

    return true;
}

/*
 * Helper: Resample PCM from srcRate to dstRate using linear interpolation
 * Returns newly allocated buffer (caller must free) and output sample count
 */
static int16_t* resampleLinear(const int16_t *src, int srcSamples, int srcRate,
                                int dstRate, int *outSamples) {
    if (srcRate == dstRate) {
        /* No resampling needed - just copy */
        int16_t *dst = (int16_t*)malloc(srcSamples * sizeof(int16_t));
        if (!dst) return NULL;
        memcpy(dst, src, srcSamples * sizeof(int16_t));
        *outSamples = srcSamples;
        return dst;
    }

    /* Calculate output size */
    int dstSamples = (int)((int64_t)srcSamples * dstRate / srcRate);
    if (dstSamples <= 0) return NULL;

    int16_t *dst = (int16_t*)malloc(dstSamples * sizeof(int16_t));
    if (!dst) return NULL;

    /* Linear interpolation resampling */
    double ratio = (double)srcRate / (double)dstRate;

    for (int i = 0; i < dstSamples; i++) {
        double srcPos = i * ratio;
        int srcIdx = (int)srcPos;
        double frac = srcPos - srcIdx;

        if (srcIdx >= srcSamples - 1) {
            /* At or past end - use last sample */
            dst[i] = src[srcSamples - 1];
        } else {
            /* Interpolate between two samples */
            int16_t s0 = src[srcIdx];
            int16_t s1 = src[srcIdx + 1];
            dst[i] = (int16_t)(s0 + frac * (s1 - s0));
        }
    }

    *outSamples = dstSamples;
    return dst;
}

/*
 * Helper: Decode MP3 to PCM (48kHz mono)
 * Handles any input sample rate by resampling to 48kHz
 */
/*
 * Helper: Generate UUID for sound file storage
 */
static void generateUUID(char *out, size_t outLen) {
    uuid_t uuid;
    uuid_generate(uuid);
    uuid_unparse_lower(uuid, out);
}

/*
 * Decode WAV file to PCM
 */
static bool decodeWAV(const char *filepath, int16_t **outPcm, int *outSamples) {
    FILE *f = fopen(filepath, "rb");
    if (!f) {
        printf("SoundMgr: WAV - Cannot open file: %s\n", filepath);
        return false;
    }

    /* Read RIFF header (12 bytes) */
    uint8_t riffHeader[12];
    if (fread(riffHeader, 1, 12, f) != 12) {
        fclose(f);
        printf("SoundMgr: WAV - Header too short\n");
        return false;
    }

    /* Verify RIFF/WAVE */
    if (memcmp(riffHeader, "RIFF", 4) != 0 || memcmp(riffHeader + 8, "WAVE", 4) != 0) {
        fclose(f);
        printf("SoundMgr: WAV - Invalid RIFF/WAVE header\n");
        return false;
    }

    /* Parse chunks to find fmt and data */
    uint16_t audioFormat = 0;
    uint16_t numChannels = 0;
    uint32_t sampleRate = 0;
    uint16_t bitsPerSample = 0;
    uint32_t dataSize = 0;
    long dataOffset = 0;

    uint8_t chunkHeader[8];
    while (fread(chunkHeader, 1, 8, f) == 8) {
        uint32_t chunkSize = chunkHeader[4] | (chunkHeader[5] << 8) |
                            (chunkHeader[6] << 16) | (chunkHeader[7] << 24);

        if (memcmp(chunkHeader, "fmt ", 4) == 0) {
            /* Format chunk */
            uint8_t fmtData[16];
            if (fread(fmtData, 1, 16, f) != 16) {
                fclose(f);
                return false;
            }
            audioFormat = fmtData[0] | (fmtData[1] << 8);
            numChannels = fmtData[2] | (fmtData[3] << 8);
            sampleRate = fmtData[4] | (fmtData[5] << 8) | (fmtData[6] << 16) | (fmtData[7] << 24);
            bitsPerSample = fmtData[14] | (fmtData[15] << 8);

            /* Skip rest of fmt chunk if larger than 16 */
            if (chunkSize > 16) {
                fseek(f, chunkSize - 16, SEEK_CUR);
            }
        } else if (memcmp(chunkHeader, "data", 4) == 0) {
            /* Data chunk found */
            dataSize = chunkSize;
            dataOffset = ftell(f);
            break;
        } else {
            /* Skip unknown chunk */
            fseek(f, chunkSize, SEEK_CUR);
        }
    }

    printf("SoundMgr: WAV - format=%d, channels=%d, rate=%d, bits=%d, dataSize=%d\n",
           audioFormat, numChannels, sampleRate, bitsPerSample, dataSize);

    if (audioFormat != 1) {  /* 1 = PCM */
        fclose(f);
        printf("SoundMgr: WAV - Not PCM format (format=%d)\n", audioFormat);
        return false;
    }

    if (bitsPerSample != 8 && bitsPerSample != 16) {
        fclose(f);
        printf("SoundMgr: WAV - Only 8-bit and 16-bit supported (got %d-bit)\n", bitsPerSample);
        return false;
    }

    if (dataSize == 0 || dataOffset == 0) {
        fclose(f);
        printf("SoundMgr: WAV - No data chunk found\n");
        return false;
    }

    /* Seek to data and read raw audio */
    fseek(f, dataOffset, SEEK_SET);
    uint8_t *rawBytes = (uint8_t*)malloc(dataSize);
    if (!rawBytes) {
        fclose(f);
        return false;
    }

    size_t bytesRead = fread(rawBytes, 1, dataSize, f);
    fclose(f);

    if (bytesRead < dataSize) {
        printf("SoundMgr: WAV - Only read %zu of %u bytes\n", bytesRead, dataSize);
        dataSize = bytesRead;
    }

    int totalSamples = dataSize / (bitsPerSample / 8) / numChannels;

    /* Convert to 16-bit if 8-bit */
    int16_t *rawData;
    if (bitsPerSample == 8) {
        printf("SoundMgr: WAV - Converting 8-bit to 16-bit\n");
        rawData = (int16_t*)malloc(totalSamples * numChannels * sizeof(int16_t));
        if (!rawData) {
            free(rawBytes);
            return false;
        }
        /* 8-bit WAV is unsigned (0-255), center at 128. Convert to signed 16-bit. */
        for (int i = 0; i < totalSamples * numChannels; i++) {
            rawData[i] = ((int16_t)rawBytes[i] - 128) * 256;
        }
        free(rawBytes);
    } else {
        /* Already 16-bit */
        rawData = (int16_t*)rawBytes;
    }

    /* Convert to mono if stereo */
    int16_t *monoData;
    int monoSamples;

    if (numChannels == 2) {
        monoSamples = totalSamples;
        monoData = (int16_t*)malloc(monoSamples * sizeof(int16_t));
        if (!monoData) {
            free(rawData);
            return false;
        }
        for (int i = 0; i < monoSamples; i++) {
            monoData[i] = (rawData[i * 2] + rawData[i * 2 + 1]) / 2;
        }
        free(rawData);
    } else {
        monoData = rawData;
        monoSamples = totalSamples;
    }

    /* Resample to 48kHz if needed */
    int16_t *finalBuffer;
    int finalSamples;

    if ((int)sampleRate != OPUS_SAMPLE_RATE) {
        printf("SoundMgr: WAV - Resampling from %d Hz to %d Hz\n", sampleRate, OPUS_SAMPLE_RATE);
        finalBuffer = resampleLinear(monoData, monoSamples, sampleRate, OPUS_SAMPLE_RATE, &finalSamples);
        free(monoData);
        if (!finalBuffer) {
            return false;
        }
    } else {
        finalBuffer = monoData;
        finalSamples = monoSamples;
    }

    /* Enforce max duration */
    int maxSamples = OPUS_SAMPLE_RATE * SOUND_MAX_DURATION_SEC;
    if (finalSamples > maxSamples) {
        printf("SoundMgr: WAV - Truncating to %d sec\n", SOUND_MAX_DURATION_SEC);
        finalSamples = maxSamples;
    }

    *outPcm = finalBuffer;
    *outSamples = finalSamples;
    printf("SoundMgr: WAV - Decoded %d samples (%.2f sec)\n", finalSamples, (float)finalSamples / OPUS_SAMPLE_RATE);
    return true;
}

static bool decodeMP3(const char *filepath, int16_t **outPcm, int *outSamples) {
    /* Check if it's a WAV file */
    const char *ext = strrchr(filepath, '.');
    if (ext && strcasecmp(ext, ".wav") == 0) {
        return decodeWAV(filepath, outPcm, outSamples);
    }

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

    /* First pass: decode to get sample rate and total samples */
    mp3dec_frame_info_t frameInfo;
    int16_t frameBuffer[MINIMP3_MAX_SAMPLES_PER_FRAME];

    /* Allocate temp buffer for native sample rate (estimate max ~10 min at 48kHz stereo) */
    int maxNativeSamples = 48000 * 60 * 10;  /* 10 minutes max */
    int16_t *nativeBuffer = (int16_t*)malloc(maxNativeSamples * sizeof(int16_t));
    if (!nativeBuffer) {
        free(mp3Data);
        return false;
    }

    int nativeSamples = 0;
    int offset = 0;
    int detectedRate = 0;

    while (offset < fileSize && nativeSamples < maxNativeSamples) {
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

        /* Capture sample rate from first valid frame */
        if (detectedRate == 0 && frameInfo.hz > 0) {
            detectedRate = frameInfo.hz;
            printf("SoundMgr: MP3 sample rate detected: %d Hz\n", detectedRate);
        }

        /* Convert to mono if stereo */
        if (frameInfo.channels == 2) {
            for (int i = 0; i < samples && nativeSamples < maxNativeSamples; i++) {
                nativeBuffer[nativeSamples++] = (frameBuffer[i * 2] + frameBuffer[i * 2 + 1]) / 2;
            }
        } else {
            int copyCount = samples;
            if (nativeSamples + copyCount > maxNativeSamples) {
                copyCount = maxNativeSamples - nativeSamples;
            }
            memcpy(nativeBuffer + nativeSamples, frameBuffer, copyCount * sizeof(int16_t));
            nativeSamples += copyCount;
        }
    }

    free(mp3Data);

    if (nativeSamples == 0 || detectedRate == 0) {
        free(nativeBuffer);
        return false;
    }

    /* Resample to 48kHz if needed */
    int16_t *finalBuffer;
    int finalSamples;

    if (detectedRate != OPUS_SAMPLE_RATE) {
        printf("SoundMgr: Resampling from %d Hz to %d Hz (%d samples)\n",
               detectedRate, OPUS_SAMPLE_RATE, nativeSamples);

        finalBuffer = resampleLinear(nativeBuffer, nativeSamples, detectedRate,
                                     OPUS_SAMPLE_RATE, &finalSamples);
        free(nativeBuffer);

        if (!finalBuffer) {
            return false;
        }

        printf("SoundMgr: Resampled to %d samples (%.2f sec)\n",
               finalSamples, (float)finalSamples / OPUS_SAMPLE_RATE);
    } else {
        /* Already at target rate */
        finalBuffer = nativeBuffer;
        finalSamples = nativeSamples;
    }

    /* Enforce max duration */
    int maxSamples = OPUS_SAMPLE_RATE * SOUND_MAX_DURATION_SEC;
    if (finalSamples > maxSamples) {
        printf("SoundMgr: Truncating from %d to %d samples (max %d sec)\n",
               finalSamples, maxSamples, SOUND_MAX_DURATION_SEC);
        finalSamples = maxSamples;
    }

    *outPcm = finalBuffer;
    *outSamples = finalSamples;

    return true;
}


/*
 * Database mode functions (Phase 2)
 */

bool SoundMgr_IsDBMode(void) {
    return g_soundMgr.dbMode;
}

void SoundMgr_SetDBMode(bool enabled) {
    if (enabled && !DB_IsConnected()) {
        printf("SoundMgr: Cannot enable DB mode - database not connected\n");
        return;
    }
    g_soundMgr.dbMode = enabled;
    printf("SoundMgr: Database mode %s\n", enabled ? "ENABLED" : "DISABLED");
}
