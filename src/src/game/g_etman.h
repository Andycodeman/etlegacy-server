/*
 * ET:Legacy - ETMan Admin Commands Module
 * Copyright (C) 2024 ETMan
 *
 * UDP communication with etman-server for !commands.
 * Intercepts chat messages starting with ! and sends to etman-server.
 */

#ifndef G_ETMAN_H
#define G_ETMAN_H

#include "g_local.h"

/*
 * Admin Command Packet Types (qagame -> etman-server)
 */
#define PKT_ADMIN_CMD           0x40  /* Admin command from player */
#define PKT_ADMIN_RESP          0x41  /* Response back to player */
#define PKT_ADMIN_ACTION        0x42  /* Action for qagame to execute */
#define PKT_PLAYER_LIST         0x43  /* Full player list sync */
#define PKT_PLAYER_UPDATE       0x44  /* Single player connect/disconnect */

/*
 * Admin Action Types (etman-server -> qagame)
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
 * Limits
 */
#define ADMIN_GUID_LEN          32
#define ADMIN_MAX_NAME_LEN      64
#define ADMIN_MAX_CMD_LEN       256
#define ADMIN_MAX_ARGS_LEN      512
#define ADMIN_MAX_RESPONSE_LEN  1024

/*
 * Quick Command Packet Types (for chat-triggered sounds)
 * Must match etman-server/sound_manager.h
 * Note: 0x40-0x42 conflict with PKT_ADMIN_*, so use 0x50-0x52
 */
#define VOICE_CMD_QUICK_LOOKUP      0x50  /* Look up quick command: <slot><guid><msgLen><message> */
#define VOICE_RESP_QUICK_FOUND      0x51  /* Found: <slot><soundFileId:4><chatTextLen><chatText> */
#define VOICE_RESP_QUICK_NOTFOUND   0x52  /* Not found, let chat through: <slot> */

#define QUICK_CMD_MAX_CHAT_TEXT     128   /* Max length of chat replacement text */

// CVARs for ETMan configuration
extern vmCvar_t etman_enabled;
extern vmCvar_t etman_port;

// Initialize ETMan admin system (call from G_InitGame)
void G_ETMan_Init(void);

// Shutdown ETMan admin system (call from G_ShutdownGame)
void G_ETMan_Shutdown(void);

// Frame processing - check for responses from etman-server
void G_ETMan_Frame(void);

// Check if a chat message is an admin command (!xxx)
// Returns qtrue if the message was handled as a command
qboolean G_ETMan_CheckCommand(gentity_t *ent, const char *chatText);

// Player events - notify etman-server of connects/disconnects
void G_ETMan_PlayerConnect(int clientNum, const char *guid, const char *name, int team);
void G_ETMan_PlayerDisconnect(int clientNum);
void G_ETMan_PlayerTeamChange(int clientNum, int team);

// Quick command support - chat-triggered sound commands
// Characters that can potentially start a quick command prefix
// Note: '!' is NOT included - reserved for admin commands
#define QUICK_PREFIX_CHARS "@#$*~^&%+="

// Check if a chat message might be a quick sound command
// Sends to etman-server for lookup, returns immediately
// The response is handled in G_ETMan_Frame()
// Returns qtrue if message was sent for lookup (caller should defer chat)
qboolean G_ETMan_CheckQuickCommand(gentity_t *ent, const char *chatText, int mode);

#endif // G_ETMAN_H
