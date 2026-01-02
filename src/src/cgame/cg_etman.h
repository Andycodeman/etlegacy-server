/**
 * @file cg_etman.h
 * @brief ETMan custom sound commands - client side
 *
 * Handles /etman commands for server-side custom sound management:
 * - /etman add <url> <name> - Add sound from URL
 * - /etman play <name> - Play a sound
 * - /etman list - List your sounds
 * - /etman delete <name> - Delete a sound
 * - /etman rename <old> <new> - Rename a sound
 * - /etman share <name> <player> - Share with another player
 * - /etman stop - Stop currently playing sound
 */

#ifndef CG_ETMAN_H
#define CG_ETMAN_H

#include "cg_local.h"

#ifdef FEATURE_VOICE

/*
 * Sound Command Packet Types (client -> server)
 * Must match voice server definitions
 */
#define VOICE_CMD_SOUND_ADD     0x10
#define VOICE_CMD_SOUND_PLAY    0x11
#define VOICE_CMD_SOUND_LIST    0x12
#define VOICE_CMD_SOUND_DELETE  0x13
#define VOICE_CMD_SOUND_RENAME  0x14
#define VOICE_CMD_SOUND_SHARE   0x15
#define VOICE_CMD_SOUND_ACCEPT  0x16
#define VOICE_CMD_SOUND_REJECT  0x17
#define VOICE_CMD_SOUND_STOP    0x18

/* Phase 2: Playlist and visibility commands */
#define VOICE_CMD_SOUND_PLAYLIST_CREATE   0x19
#define VOICE_CMD_SOUND_PLAYLIST_DELETE   0x1A
#define VOICE_CMD_SOUND_PLAYLIST_LIST     0x1B
#define VOICE_CMD_SOUND_PLAYLIST_ADD      0x1C
#define VOICE_CMD_SOUND_PLAYLIST_REMOVE   0x1D
#define VOICE_CMD_SOUND_PLAYLIST_REORDER  0x1E
#define VOICE_CMD_SOUND_PLAYLIST_PLAY     0x1F
#define VOICE_CMD_SOUND_CATEGORIES        0x20
#define VOICE_CMD_SOUND_SET_VISIBILITY    0x21
#define VOICE_CMD_SOUND_PUBLIC_LIST       0x22
#define VOICE_CMD_SOUND_PUBLIC_ADD        0x23
#define VOICE_CMD_SOUND_PENDING           0x24
#define VOICE_CMD_PLAYLIST_PUBLIC_LIST    0x25
#define VOICE_CMD_PLAYLIST_SET_VISIBILITY 0x26
#define VOICE_CMD_PLAYLIST_PUBLIC_SHOW    0x27  /* Show/play from public playlist: <nameLen><name>[position] */

/* Registration commands */
#define VOICE_CMD_ACCOUNT_REGISTER        0x30
#define VOICE_RESP_REGISTER_CODE          0x31

/* Dynamic Sound Menus */
#define VOICE_CMD_MENU_GET                0x32
#define VOICE_CMD_MENU_PLAY               0x33
#define VOICE_RESP_MENU_DATA              0x34

/* Hierarchical menu navigation */
#define VOICE_CMD_MENU_NAVIGATE           0x35  /* Navigate to menu: <menuId:4><pageOffset:2> */
#define VOICE_CMD_SOUND_BY_ID             0x36  /* Play sound by position ID: <position:2> */

/*
 * Sound Response Packet Types (server -> client)
 */
#define VOICE_RESP_SUCCESS      0x20
#define VOICE_RESP_ERROR        0x21
#define VOICE_RESP_LIST         0x22
#define VOICE_RESP_SHARE_REQ    0x23
#define VOICE_RESP_PROGRESS     0x24

/*
 * Limits
 */
#define ETMAN_GUID_LEN          32
#define ETMAN_MAX_NAME_LEN      32
#define ETMAN_MAX_MENUS         9
#define ETMAN_MAX_MENU_ITEMS    9
#define ETMAN_ITEMS_PER_PAGE    9
#define ETMAN_MAX_MENU_DEPTH    10

/*
 * Item types for hierarchical menus
 */
#define ETMAN_ITEM_SOUND        0   // Item is a playable sound
#define ETMAN_ITEM_MENU         1   // Item is a nested menu/playlist

/*
 * Menu item structure (supports sounds and nested menus)
 */
typedef struct
{
	int      position;                          // 1-9 position in current page
	char     name[ETMAN_MAX_NAME_LEN + 1];      // Display name
	char     soundAlias[ETMAN_MAX_NAME_LEN + 1]; // Sound alias (if type=SOUND)
	int      itemType;                          // ETMAN_ITEM_SOUND or ETMAN_ITEM_MENU
	int      nestedMenuId;                      // Menu ID to navigate to (if type=MENU)
} etmanMenuItem_t;

/*
 * Menu structure (now represents a single menu context with pagination)
 */
typedef struct
{
	int             menuId;                 // Database menu ID (0 = root)
	int             position;               // 1-9 position in parent menu
	char            name[ETMAN_MAX_NAME_LEN + 1];
	qboolean        isPlaylist;             // Backed by playlist (auto-populated)
	int             itemCount;              // Items in current page
	int             totalItems;             // Total items in this menu
	int             pageOffset;             // Current pagination offset
	etmanMenuItem_t items[ETMAN_MAX_MENU_ITEMS];
} etmanMenu_t;

/*
 * Navigation stack for hierarchical menu traversal
 */
typedef struct
{
	int menuId;                             // Menu ID at this level
	int pageOffset;                         // Page offset at this level
	char name[ETMAN_MAX_NAME_LEN + 1];      // Menu name for breadcrumb
} etmanNavStackEntry_t;

/*
 * Navigation state
 */
typedef struct
{
	etmanNavStackEntry_t stack[ETMAN_MAX_MENU_DEPTH];
	int                  depth;             // Current depth (0 = root)
} etmanNavStack_t;

/**
 * Initialize ETMan system.
 * Called from Voice_Init().
 */
void ETMan_Init(void);

/**
 * Shutdown ETMan system.
 * Called from Voice_Shutdown().
 */
void ETMan_Shutdown(void);

/**
 * Process incoming response packets from voice server.
 * Called when a sound response packet is received.
 * @param data Packet data
 * @param dataLen Packet length
 */
void ETMan_HandleResponse(const uint8_t *data, int dataLen);

/**
 * Check for pending share requests and show prompt.
 * Called from Voice_Frame().
 */
void ETMan_Frame(void);

/**
 * Console command handler for /etman.
 */
void ETMan_Cmd_f(void);

/**
 * Draw any active ETMan UI (share prompts, etc).
 */
void ETMan_Draw(void);

/**
 * Toggle sound menu visibility.
 * Called when player presses menu key.
 */
void ETMan_ToggleMenu(void);

/**
 * Check if menu is currently visible.
 */
qboolean ETMan_IsMenuActive(void);

/**
 * Handle key press while menu is active.
 * @param key Key code (1-9 for selection, 0 or ESC to close)
 * @return qtrue if key was handled
 */
qboolean ETMan_MenuKeyEvent(int key);

/**
 * Request menu data from server.
 * Called on first menu open.
 */
void ETMan_RequestMenus(void);

/**
 * Console command handlers for sound menu.
 */
void CG_SoundMenu_f(void);        /* Toggle menu on/off (personal menus) */
void CG_SoundMenuDown_f(void);    /* +soundmenu (open menu) */
void CG_SoundMenuUp_f(void);      /* -soundmenu (currently does nothing) */
void CG_SoundMenuServer_f(void);  /* soundmenu_server - server-wide sound menus */

/**
 * Open the server-wide sound menu (same for all players).
 */
void ETMan_OpenServerMenu(void);

/**
 * Key handling for sound menu (called from CG_KeyEvent).
 * This properly intercepts keys so weapon binds don't fire.
 */
void ETMan_SoundMenu_KeyHandling(int key, qboolean down);

/**
 * Check if a key should be blocked from executing binds.
 * Called from CG_CheckExecKey before engine processes key binds.
 * @param key Key code
 * @return qtrue if key should be blocked, qfalse otherwise
 */
qboolean ETMan_CheckExecKey(int key);

/**
 * Navigate to a specific menu (for hierarchical navigation).
 * @param menuId Target menu ID (0 = root)
 * @param pageOffset Starting page offset
 */
void ETMan_NavigateToMenu(int menuId, int pageOffset);

/**
 * Navigate back to parent menu.
 * @return qtrue if navigated back, qfalse if already at root
 */
qboolean ETMan_NavigateBack(void);

/**
 * Navigate to next page of current menu.
 * @return qtrue if more pages available
 */
qboolean ETMan_NextPage(void);

/**
 * Play a sound by its position ID in user's library.
 * @param positionId 1-based position (by added date order)
 */
void ETMan_PlaySoundById(int positionId);

/**
 * Toggle sound ID input mode (for quick-load).
 */
void ETMan_ToggleIdMode(void);

/**
 * Console command: /etman playid <number>
 */
void CG_SoundPlayId_f(void);

#endif /* FEATURE_VOICE */

#endif /* CG_ETMAN_H */
