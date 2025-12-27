/**
 * @file sound_manager.h
 * @brief Server-side custom sound storage and playback management
 *
 * Manages custom sounds stored per-player UUID. Supports:
 * - Sound file CRUD operations (add, list, delete, rename)
 * - URL download with validation
 * - MP3 decoding and Opus encoding for playback
 * - Sound sharing between players
 */

#ifndef SOUND_MANAGER_H
#define SOUND_MANAGER_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <time.h>
#include <sys/types.h>

#ifdef _WIN32
    #include <winsock2.h>
#else
    #include <netinet/in.h>
#endif

/*
 * Sound Command Packet Types (client -> server)
 * Must match cgame definitions
 */
#define VOICE_CMD_SOUND_ADD     0x10  /* Add sound: <guid><url><name> */
#define VOICE_CMD_SOUND_PLAY    0x11  /* Play sound: <guid><name> */
#define VOICE_CMD_SOUND_LIST    0x12  /* List sounds: <guid> */
#define VOICE_CMD_SOUND_DELETE  0x13  /* Delete sound: <guid><name> */
#define VOICE_CMD_SOUND_RENAME  0x14  /* Rename: <guid><oldname><newname> */
#define VOICE_CMD_SOUND_SHARE   0x15  /* Share: <guid><name><target_guid> */
#define VOICE_CMD_SOUND_ACCEPT  0x16  /* Accept share: <guid><from_guid><name> */
#define VOICE_CMD_SOUND_REJECT  0x17  /* Reject share: <guid><from_guid><name> */
#define VOICE_CMD_SOUND_STOP    0x18  /* Stop currently playing sound */

/*
 * Sound Response Packet Types (server -> client)
 */
#define VOICE_RESP_SUCCESS      0x20  /* Operation succeeded: <message> */
#define VOICE_RESP_ERROR        0x21  /* Operation failed: <error_message> */
#define VOICE_RESP_LIST         0x22  /* Sound list: <count><name1><name2>... */
#define VOICE_RESP_SHARE_REQ    0x23  /* Incoming share request: <from_name><sound_name> */
#define VOICE_RESP_PROGRESS     0x24  /* Download progress: <percent> */

/*
 * Sound Limits
 */
#define SOUND_MAX_PER_USER      100         /* Max sounds per player */
#define SOUND_MAX_FILESIZE      (2 * 1024 * 1024)  /* 2MB max per file */
#define SOUND_MAX_DURATION_SEC  10          /* 10 second max duration */
#define SOUND_MAX_NAME_LEN      32          /* Max sound name length */
#define SOUND_GUID_LEN          32          /* Player GUID length (without null) */
#define SOUND_ADD_COOLDOWN_SEC  10          /* Cooldown between add requests */
#define SOUND_DOWNLOAD_TIMEOUT  120         /* 2 minute download timeout */

/*
 * Sound playback state
 */
typedef enum {
    PLAYBACK_IDLE = 0,
    PLAYBACK_LOADING,
    PLAYBACK_PLAYING,
    PLAYBACK_ERROR
} SoundPlaybackState;

/*
 * Download request state
 */
typedef enum {
    DOWNLOAD_IDLE = 0,
    DOWNLOAD_PENDING,
    DOWNLOAD_IN_PROGRESS,
    DOWNLOAD_COMPLETE,
    DOWNLOAD_FAILED
} DownloadState;

/*
 * Download request
 */
typedef struct {
    DownloadState state;
    char          guid[SOUND_GUID_LEN + 1];
    char          name[SOUND_MAX_NAME_LEN + 1];
    char          url[512];
    uint32_t      clientId;         /* For sending response */
    time_t        startTime;
    char          errorMsg[128];
    int           progress;         /* 0-100 */
    pid_t         workerPid;        /* Worker process PID */
} DownloadRequest;

/*
 * Sound info entry (for listing)
 */
typedef struct {
    char    name[SOUND_MAX_NAME_LEN + 1];
    size_t  fileSize;
    time_t  addedTime;
} SoundInfo;

/*
 * Pending share request
 */
typedef struct {
    char    fromGuid[SOUND_GUID_LEN + 1];
    char    toGuid[SOUND_GUID_LEN + 1];
    char    soundName[SOUND_MAX_NAME_LEN + 1];
    char    fromPlayerName[64];     /* For display */
    time_t  requestTime;
    uint32_t fromClientId;
    uint32_t toClientId;
} PendingShare;

/*
 * Sound playback context (for streaming to clients)
 */
typedef struct {
    SoundPlaybackState state;
    char    guid[SOUND_GUID_LEN + 1];
    char    name[SOUND_MAX_NAME_LEN + 1];
    uint32_t clientId;              /* Who initiated playback */

    /* Decoded PCM audio (48kHz mono) */
    int16_t *pcmBuffer;
    int      pcmSamples;
    int      pcmPosition;

    /* Opus encoding state */
    void    *opusEncoder;
    uint32_t sequence;
} SoundPlayback;


/*
 * API Functions
 */

/**
 * Initialize the sound manager.
 * Creates the sounds directory structure if needed.
 * @param baseDir Base directory for sound storage (e.g., "./sounds")
 * @return true on success
 */
bool SoundMgr_Init(const char *baseDir);

/**
 * Shutdown the sound manager.
 * Stops any active playback and cleans up resources.
 */
void SoundMgr_Shutdown(void);

/**
 * Process pending download and playback operations.
 * Should be called periodically from main loop.
 */
void SoundMgr_Frame(void);

/**
 * Handle incoming sound command packet.
 * @param clientId Client slot ID
 * @param clientAddr Client address for responses
 * @param data Packet data
 * @param dataLen Packet length
 */
void SoundMgr_HandlePacket(uint32_t clientId, struct sockaddr_in *clientAddr,
                           const uint8_t *data, int dataLen);

/**
 * Get the number of sounds for a player.
 * @param guid Player GUID
 * @return Number of sounds, -1 on error
 */
int SoundMgr_GetSoundCount(const char *guid);

/**
 * List all sounds for a player.
 * @param guid Player GUID
 * @param outList Array to fill with sound info
 * @param maxCount Maximum entries to return
 * @return Number of entries filled
 */
int SoundMgr_ListSounds(const char *guid, SoundInfo *outList, int maxCount);

/**
 * Delete a sound file.
 * @param guid Player GUID
 * @param name Sound name
 * @return true on success
 */
bool SoundMgr_DeleteSound(const char *guid, const char *name);

/**
 * Rename a sound file.
 * @param guid Player GUID
 * @param oldName Current name
 * @param newName New name
 * @return true on success
 */
bool SoundMgr_RenameSound(const char *guid, const char *oldName, const char *newName);

/**
 * Queue a sound for download from URL.
 * @param clientId Client slot ID
 * @param guid Player GUID
 * @param url Download URL
 * @param name Sound name to save as
 * @return true if queued successfully
 */
bool SoundMgr_QueueDownload(uint32_t clientId, const char *guid,
                            const char *url, const char *name);

/**
 * Play a sound to all connected clients.
 * @param clientId Client slot ID that initiated playback
 * @param guid Player GUID (sound owner)
 * @param name Sound name
 * @return true if playback started
 */
bool SoundMgr_PlaySound(uint32_t clientId, const char *guid, const char *name);

/**
 * Stop the currently playing sound.
 */
void SoundMgr_StopSound(void);

/**
 * Check if a sound is currently playing.
 * @return true if playing
 */
bool SoundMgr_IsPlaying(void);

/**
 * Get the client ID of who initiated the current sound playback.
 * @return client ID, or 255 if no sound is playing
 */
uint32_t SoundMgr_GetPlaybackClientId(void);

/**
 * Get the next Opus audio packet for transmission.
 * @param outBuffer Buffer for Opus data (max 512 bytes)
 * @param outLen Length of encoded data
 * @return true if data was encoded
 */
bool SoundMgr_GetNextOpusPacket(uint8_t *outBuffer, int *outLen);

/**
 * Queue a share request.
 * @param fromClientId Sender's client ID
 * @param fromGuid Sender's GUID
 * @param toGuid Recipient's GUID
 * @param soundName Sound to share
 * @param fromPlayerName Sender's display name
 * @return true if queued
 */
bool SoundMgr_QueueShare(uint32_t fromClientId, const char *fromGuid,
                         const char *toGuid, const char *soundName,
                         const char *fromPlayerName);

/**
 * Accept a pending share.
 * @param toGuid Recipient's GUID
 * @param fromGuid Sender's GUID
 * @param soundName Sound name
 * @return true on success
 */
bool SoundMgr_AcceptShare(const char *toGuid, const char *fromGuid,
                          const char *soundName);

/**
 * Reject a pending share.
 * @param toGuid Recipient's GUID
 * @param fromGuid Sender's GUID
 * @param soundName Sound name
 */
void SoundMgr_RejectShare(const char *toGuid, const char *fromGuid,
                          const char *soundName);

/**
 * Validate and sanitize a sound name.
 * @param name Sound name to validate
 * @param outName Sanitized output name
 * @param outLen Output buffer length
 * @return true if valid
 */
bool SoundMgr_ValidateName(const char *name, char *outName, int outLen);

/**
 * Validate a download URL.
 * @param url URL to validate
 * @param errorMsg Buffer for error message
 * @param errorLen Error buffer length
 * @return true if valid
 */
bool SoundMgr_ValidateUrl(const char *url, char *errorMsg, int errorLen);

#endif /* SOUND_MANAGER_H */
