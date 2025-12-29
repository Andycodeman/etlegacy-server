/**
 * @file admin.h
 * @brief ETMan Admin Commands System - Core definitions
 *
 * Provides Jaymod-style !commands with PostgreSQL-backed permissions.
 * Part of the ETMan server sidecar (voice + sounds + admin).
 */

#ifndef ETMAN_ADMIN_H
#define ETMAN_ADMIN_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <time.h>

#ifdef _WIN32
    #include <winsock2.h>
#else
    #include <netinet/in.h>
#endif

/*
 * Admin Command Packet Types (qagame -> etman-server)
 * These extend the existing voice/sound protocol
 */
#define PKT_ADMIN_CMD           0x40  /* Admin command from player */
#define PKT_ADMIN_RESP          0x41  /* Response back to player */
#define PKT_ADMIN_ACTION        0x42  /* Action for qagame to execute */
#define PKT_PLAYER_LIST         0x43  /* Full player list sync */
#define PKT_PLAYER_UPDATE       0x44  /* Single player connect/disconnect */

/*
 * Admin Action Types (etman-server -> qagame)
 * These tell qagame what to do after processing a command
 */
#define ADMIN_ACTION_NONE       0     /* No action needed (response only) */
#define ADMIN_ACTION_KICK       1     /* Kick player: target_slot, reason */
#define ADMIN_ACTION_BAN        2     /* Ban player: target_slot, duration, reason */
#define ADMIN_ACTION_MUTE       3     /* Mute player: target_slot, duration */
#define ADMIN_ACTION_UNMUTE     4     /* Unmute player: target_slot */
#define ADMIN_ACTION_SLAP       5     /* Slap player: target_slot, damage */
#define ADMIN_ACTION_GIB        6     /* Gib player: target_slot */
#define ADMIN_ACTION_PUT        7     /* Force team: target_slot, team */
#define ADMIN_ACTION_MAP        8     /* Change map: mapname */
#define ADMIN_ACTION_RESTART    9     /* Restart map */
#define ADMIN_ACTION_RCON       10    /* Raw rcon: command */
#define ADMIN_ACTION_CHAT       11    /* Chat message: message */
#define ADMIN_ACTION_CPRINT     12    /* Center print: message */
#define ADMIN_ACTION_FLING      13    /* Fling player: strength */
#define ADMIN_ACTION_UP         14    /* Launch player up: strength */

/*
 * Admin Levels (must match database)
 */
#define ADMIN_LEVEL_GUEST       0
#define ADMIN_LEVEL_REGULAR     1
#define ADMIN_LEVEL_VIP         2
#define ADMIN_LEVEL_ADMIN       3
#define ADMIN_LEVEL_SENIOR      4
#define ADMIN_LEVEL_OWNER       5

/*
 * Limits
 */
#define ADMIN_MAX_PLAYERS       64
#define ADMIN_MAX_NAME_LEN      64
#define ADMIN_GUID_LEN          32
#define ADMIN_MAX_CMD_LEN       256
#define ADMIN_MAX_ARGS_LEN      512
#define ADMIN_MAX_RESPONSE_LEN  1024

/*
 * Team values (ET uses these)
 */
#define ADMIN_TEAM_FREE         0
#define ADMIN_TEAM_AXIS         1
#define ADMIN_TEAM_ALLIES       2
#define ADMIN_TEAM_SPECTATOR    3

/*
 * Player info structure (synced from qagame)
 */
typedef struct {
    bool     connected;
    uint8_t  slot;                          /* 0-63 */
    char     guid[ADMIN_GUID_LEN + 1];
    char     name[ADMIN_MAX_NAME_LEN + 1];
    char     cleanName[ADMIN_MAX_NAME_LEN + 1]; /* Color-stripped, lowercase */
    uint8_t  team;
    time_t   connectTime;
    int      playerId;                      /* Database player ID (-1 if not loaded) */
    int      level;                         /* Admin level (0-5) */
    bool     muted;                         /* Currently muted? */
} AdminPlayer;

/*
 * Admin command handler function type
 */
typedef void (*AdminCmdFunc)(int callerSlot, AdminPlayer *caller, const char *args);

/*
 * Admin command definition
 */
typedef struct {
    const char    *name;         /* Command name (e.g., "kick") */
    AdminCmdFunc   func;         /* Handler function */
    int            minLevel;     /* Minimum level required */
    const char    *usage;        /* Usage string */
    const char    *description;  /* Description */
} AdminCommand;

/*
 * Packet structures (must match qagame)
 */
#pragma pack(push, 1)

/* PKT_ADMIN_CMD: Player issued a !command
 * NOTE: guid is ADMIN_GUID_LEN+1 to ensure full 32-char GUID + null terminator */
typedef struct {
    uint8_t  type;                          /* PKT_ADMIN_CMD */
    uint8_t  clientSlot;                    /* 0-63 */
    char     guid[ADMIN_GUID_LEN + 1];      /* Player GUID (32 chars + null) */
    char     name[ADMIN_MAX_NAME_LEN];      /* Player name */
    char     command[ADMIN_MAX_CMD_LEN];    /* "kick eth" or "rotate" */
} AdminCmdPacket;

/* PKT_ADMIN_RESP: Response message to player */
typedef struct {
    uint8_t  type;                          /* PKT_ADMIN_RESP */
    uint8_t  clientSlot;                    /* Who to send message to (255 = all) */
    char     message[ADMIN_MAX_RESPONSE_LEN]; /* Response text */
} AdminRespPacket;

/* PKT_ADMIN_ACTION: Tell qagame to execute an action */
typedef struct {
    uint8_t  type;                          /* PKT_ADMIN_ACTION */
    uint8_t  action;                        /* ADMIN_ACTION_* */
    uint8_t  targetSlot;                    /* Target player (if applicable) */
    char     data[ADMIN_MAX_ARGS_LEN];      /* Action-specific data */
} AdminActionPacket;

/* PKT_PLAYER_UPDATE: Player connect/disconnect
 * NOTE: guid is ADMIN_GUID_LEN+1 to ensure full 32-char GUID + null terminator */
typedef struct {
    uint8_t  type;                          /* PKT_PLAYER_UPDATE */
    uint8_t  slot;                          /* Player slot */
    uint8_t  connected;                     /* 1 = connect, 0 = disconnect */
    char     guid[ADMIN_GUID_LEN + 1];      /* Player GUID (32 chars + null) */
    char     name[ADMIN_MAX_NAME_LEN];      /* Player name */
    uint8_t  team;                          /* Current team */
} PlayerUpdatePacket;

#pragma pack(pop)

/*
 * API Functions
 */

/**
 * Initialize the admin system.
 * Connects to database, loads commands, etc.
 * @return true on success
 */
bool Admin_Init(void);

/**
 * Shutdown the admin system.
 */
void Admin_Shutdown(void);

/**
 * Handle incoming admin command packet from qagame.
 * @param clientSlot Player slot who issued command
 * @param guid Player GUID
 * @param name Player name
 * @param cmdText Command text (without ! prefix)
 */
void Admin_HandleCommand(int clientSlot, const char *guid, const char *name,
                         const char *cmdText);

/**
 * Handle player connect event.
 * @param slot Player slot
 * @param guid Player GUID
 * @param name Player name
 * @param team Current team
 */
void Admin_PlayerConnect(int slot, const char *guid, const char *name, uint8_t team);

/**
 * Handle player disconnect event.
 * @param slot Player slot
 */
void Admin_PlayerDisconnect(int slot);

/**
 * Handle player team change.
 * @param slot Player slot
 * @param team New team
 */
void Admin_PlayerTeamChange(int slot, uint8_t team);

/**
 * Handle player name change.
 * @param slot Player slot
 * @param newName New name
 */
void Admin_PlayerNameChange(int slot, const char *newName);

/**
 * Send response message to a player.
 * @param slot Player slot (255 for all)
 * @param fmt Printf-style format string
 */
void Admin_SendResponse(int slot, const char *fmt, ...);

/**
 * Send action to qagame.
 * @param action Action type
 * @param targetSlot Target player (if applicable)
 * @param data Action data
 */
void Admin_SendAction(uint8_t action, uint8_t targetSlot, const char *data);

/**
 * Set the qagame address for sending responses.
 * Called by main.c when receiving admin commands.
 * @param addr Source address of qagame
 */
void Admin_SetQagameAddr(struct sockaddr_in *addr);

/**
 * Check if player has permission for a command.
 * Checks both level permissions and per-player overrides.
 * @param guid Player GUID
 * @param cmdName Command name
 * @return true if allowed
 */
bool Admin_HasPermission(const char *guid, const char *cmdName);

/**
 * Get player by slot number.
 * @param slot Player slot
 * @return Player info or NULL if not connected
 */
AdminPlayer* Admin_GetPlayer(int slot);

/**
 * Find player by fuzzy name match.
 * @param search Name or slot number to search for
 * @param outSlots Array to fill with matching slot numbers
 * @param maxResults Maximum matches to return
 * @return Number of matches found
 */
int Admin_FindPlayer(const char *search, int *outSlots, int maxResults);

/**
 * Strip ET color codes from a string.
 * @param src Source string
 * @param dst Destination buffer
 * @param dstLen Destination buffer length
 */
void Admin_StripColors(const char *src, char *dst, int dstLen);

/**
 * Convert string to lowercase.
 * @param str String to convert (in-place)
 */
void Admin_ToLower(char *str);

/**
 * Get current player count.
 * @return Number of connected players
 */
int Admin_GetPlayerCount(void);

/**
 * Check if a player is banned.
 * @param guid Player GUID
 * @param outReason Buffer for ban reason (can be NULL)
 * @param outExpires Pointer to store expiry time (can be NULL)
 * @return true if banned
 */
bool Admin_IsBanned(const char *guid, char *outReason, time_t *outExpires);

/**
 * Check if a player is muted.
 * @param guid Player GUID
 * @return true if muted
 */
bool Admin_IsMuted(const char *guid);

/*
 * Command Implementations (defined in commands.c)
 */
void Cmd_Help(int slot, AdminPlayer *caller, const char *args);
void Cmd_AdminTest(int slot, AdminPlayer *caller, const char *args);
void Cmd_Time(int slot, AdminPlayer *caller, const char *args);
void Cmd_NextMap(int slot, AdminPlayer *caller, const char *args);
void Cmd_MapList(int slot, AdminPlayer *caller, const char *args);
void Cmd_Rotate(int slot, AdminPlayer *caller, const char *args);
void Cmd_Map(int slot, AdminPlayer *caller, const char *args);
void Cmd_Restart(int slot, AdminPlayer *caller, const char *args);
void Cmd_Players(int slot, AdminPlayer *caller, const char *args);
void Cmd_Kick(int slot, AdminPlayer *caller, const char *args);
void Cmd_Mute(int slot, AdminPlayer *caller, const char *args);
void Cmd_Unmute(int slot, AdminPlayer *caller, const char *args);
void Cmd_Warn(int slot, AdminPlayer *caller, const char *args);
void Cmd_Ban(int slot, AdminPlayer *caller, const char *args);
void Cmd_Unban(int slot, AdminPlayer *caller, const char *args);
void Cmd_Slap(int slot, AdminPlayer *caller, const char *args);
void Cmd_Gib(int slot, AdminPlayer *caller, const char *args);
void Cmd_Put(int slot, AdminPlayer *caller, const char *args);
void Cmd_SetLevel(int slot, AdminPlayer *caller, const char *args);
void Cmd_ListAdmins(int slot, AdminPlayer *caller, const char *args);
void Cmd_Finger(int slot, AdminPlayer *caller, const char *args);
void Cmd_Aliases(int slot, AdminPlayer *caller, const char *args);
void Cmd_Stats(int slot, AdminPlayer *caller, const char *args);
void Cmd_Spec999(int slot, AdminPlayer *caller, const char *args);
void Cmd_Fling(int slot, AdminPlayer *caller, const char *args);
void Cmd_Up(int slot, AdminPlayer *caller, const char *args);
void Cmd_KickBots(int slot, AdminPlayer *caller, const char *args);
void Cmd_PutBots(int slot, AdminPlayer *caller, const char *args);
void Cmd_TimeLeft(int slot, AdminPlayer *caller, const char *args);

#endif /* ETMAN_ADMIN_H */
