/**
 * @file cg_etman.c
 * @brief ETMan custom sound commands - client side
 */

#include "cg_etman.h"
#include "cg_voice.h"

#ifdef FEATURE_VOICE

#ifdef _WIN32
    #include <winsock2.h>
#else
    #include <arpa/inet.h>
#endif

/*
 * Menu type enum - matches server-side definitions
 */
typedef enum {
	ETMAN_MENU_PERSONAL = 0,    /* Player's personal menus */
	ETMAN_MENU_SERVER = 1       /* Server-wide default menus */
} etmanMenuType_t;

/*
 * Root menu state - shows Server/User Sounds choice before loading actual data
 */
typedef enum {
	ETMAN_ROOT_CHOICE = 0,      /* At the root choice (Server Sounds / User Sounds) */
	ETMAN_ROOT_SERVER = 1,      /* Viewing server sounds */
	ETMAN_ROOT_USER = 2         /* Viewing user sounds */
} etmanRootState_t;

/*
 * Module state
 */
static struct
{
	qboolean initialized;

	/* Pending share request */
	qboolean hasShareRequest;
	char     shareFromName[64];
	char     shareSoundName[ETMAN_MAX_NAME_LEN + 1];
	char     shareFromGuid[ETMAN_GUID_LEN + 1];
	int      shareRequestTime;

	/* Sound menu state */
	qboolean        menuActive;          // Menu HUD visible
	qboolean        menuDataLoaded;      // Have we received menu data from server
	int             menuRequestTime;     // When we last requested menus
	etmanMenuType_t currentMenuType;     // Personal (0) or Server (1) menus
	etmanRootState_t rootState;          // Root choice vs viewing sounds
	qboolean        userHasSounds;       // Track if user has any sounds (for promo)

	/* Hierarchical navigation state */
	etmanMenu_t     currentMenu;         // Currently displayed menu
	etmanNavStack_t navStack;            // Navigation history for back button

	/* Legacy compatibility (kept for reference during transition) */
	int             currentMenuLevel;    // 0 = root menu, 1+ = submenu (deprecated)
	int             selectedMenu;        // Which menu is selected (deprecated)
	int             menuCount;           // Number of menus (deprecated)
	etmanMenu_t     menus[ETMAN_MAX_MENUS]; // (deprecated, kept for compat)

	/* Sound ID quick-load mode */
	qboolean        idModeActive;        // ID input mode active
	char            idInputBuffer[8];    // Buffer for typing ID number
	int             idInputLen;          // Current input length

	/* Pending URL to open (deferred to next frame) */
	qboolean        pendingUrlOpen;
	char            pendingUrl[256];

} etman;

/*
 * Forward declarations
 */
static void ETMan_SendPacket(uint8_t *data, int len);
static void ETMan_ShowHelp(void);
static qboolean ETMan_GetGuid(char *outGuid, int outLen);
static void ETMan_ParseMenuData(const uint8_t *data, int dataLen);
static void ETMan_ParseHierarchicalMenuData(const uint8_t *data, int dataLen);
static void ETMan_PlayMenuSound(const char *soundAlias);
static void ETMan_DrawMenu(void);
static void ETMan_DrawRootMenu(void);
static void ETMan_DrawUserPromo(void);
static void ETMan_DrawServerSoundsHeader(void);

/**
 * Initialize ETMan system
 */
void ETMan_Init(void)
{
	Com_Memset(&etman, 0, sizeof(etman));
	etman.initialized = qtrue;
	CG_Printf("^2ETMan: Server-side custom sounds initialized\n");
}

/**
 * Shutdown ETMan system
 */
void ETMan_Shutdown(void)
{
	Com_Memset(&etman, 0, sizeof(etman));
}

/**
 * Get the player's GUID for sound storage
 */
static qboolean ETMan_GetGuid(char *outGuid, int outLen)
{
	trap_Cvar_VariableStringBuffer("cl_guid", outGuid, outLen);

	if (outGuid[0] == '\0')
	{
		/* No GUID set - this shouldn't happen */
		CG_Printf("^1ETMan: Error - no cl_guid set\n");
		return qfalse;
	}

	/* Truncate to 32 chars if needed */
	if (strlen(outGuid) > ETMAN_GUID_LEN)
	{
		outGuid[ETMAN_GUID_LEN] = '\0';
	}

	return qtrue;
}

/**
 * Send a packet to the voice server
 */
static void ETMan_SendPacket(uint8_t *data, int len)
{
	/* Use the Voice_SendRaw function if available, or send directly */
	extern void Voice_SendRawPacket(const uint8_t *data, int len);
	Voice_SendRawPacket(data, len);
}

/* Forward declarations for functions used before definition */
static void ETMan_CmdPlayId(void);
static void ETMan_RequestMenuPage(int menuId, int pageOffset);
static void ETMan_OpenMenuWithType(etmanMenuType_t menuType);

/**
 * Handle /etman add <url> <name>
 */
static void ETMan_CmdAdd(void)
{
	char url[512];
	char name[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[600];
	int offset = 0;
	uint16_t urlLen;

	if (trap_Argc() < 4)
	{
		CG_Printf("Usage: /etman add <url> <name>\n");
		CG_Printf("  Downloads an MP3 from the URL and saves it as <name>\n");
		CG_Printf("  Example: /etman add https://example.com/sound.mp3 mysound\n");
		return;
	}

	trap_Argv(2, url, sizeof(url));
	trap_Argv(3, name, sizeof(name));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Validate URL length */
	if (strlen(url) > 500)
	{
		CG_Printf("^1ETMan: URL too long (max 500 chars)\n");
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><urlLen[2]><url><name> */
	packet[offset++] = VOICE_CMD_SOUND_ADD;

	/* Client ID (network byte order) */
	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	/* GUID */
	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	/* URL length */
	urlLen = htons((uint16_t)strlen(url));
	Com_Memcpy(packet + offset, &urlLen, 2);
	offset += 2;

	/* URL */
	Com_Memcpy(packet + offset, url, strlen(url));
	offset += strlen(url);

	/* Name */
	Com_Memcpy(packet + offset, name, strlen(name));
	offset += strlen(name);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Requesting download of '%s'...\n", name);
}

/**
 * Handle /etman play <name>
 */
static void ETMan_CmdPlay(void)
{
	char name[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman play <name>\n");
		CG_Printf("  Plays the sound to all players in the game\n");
		return;
	}

	trap_Argv(2, name, sizeof(name));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><name> */
	packet[offset++] = VOICE_CMD_SOUND_PLAY;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	Com_Memcpy(packet + offset, name, strlen(name));
	offset += strlen(name);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Playing '%s'...\n", name);
}

/**
 * Handle /etman list
 */
static void ETMan_CmdList(void)
{
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[64];
	int offset = 0;

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]> */
	packet[offset++] = VOICE_CMD_SOUND_LIST;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Requesting sound list...\n");
}

/**
 * Handle /etman delete <name>
 */
static void ETMan_CmdDelete(void)
{
	char name[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman delete <name>\n");
		return;
	}

	trap_Argv(2, name, sizeof(name));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><name> */
	packet[offset++] = VOICE_CMD_SOUND_DELETE;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	Com_Memcpy(packet + offset, name, strlen(name));
	offset += strlen(name);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Deleting '%s'...\n", name);
}

/**
 * Handle /etman rename <old> <new>
 */
static void ETMan_CmdRename(void)
{
	char oldName[ETMAN_MAX_NAME_LEN + 1];
	char newName[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 4)
	{
		CG_Printf("Usage: /etman rename <oldname> <newname>\n");
		return;
	}

	trap_Argv(2, oldName, sizeof(oldName));
	trap_Argv(3, newName, sizeof(newName));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><oldLen[1]><old><new> */
	packet[offset++] = VOICE_CMD_SOUND_RENAME;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	packet[offset++] = (uint8_t)strlen(oldName);

	Com_Memcpy(packet + offset, oldName, strlen(oldName));
	offset += strlen(oldName);

	Com_Memcpy(packet + offset, newName, strlen(newName));
	offset += strlen(newName);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Renaming '%s' to '%s'...\n", oldName, newName);
}

/**
 * Handle /etman stop
 */
static void ETMan_CmdStop(void)
{
	uint8_t packet[16];
	int offset = 0;

	packet[offset++] = VOICE_CMD_SOUND_STOP;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Stopping sound...\n");
}

/**
 * Handle /etman share <name> <player>
 * Shares a sound with another online player by name (fuzzy match).
 * The server will resolve the player name to their GUID.
 */
static void ETMan_CmdShare(void)
{
	char name[ETMAN_MAX_NAME_LEN + 1];
	char targetPlayer[64];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 4)
	{
		CG_Printf("Usage: /etman share <sound> <player>\n");
		CG_Printf("  Share a sound with another online player\n");
		CG_Printf("  Use partial name to match (must be unique)\n");
		return;
	}

	trap_Argv(2, name, sizeof(name));
	trap_Argv(3, targetPlayer, sizeof(targetPlayer));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><soundNameLen[1]><soundName><targetPlayerName> */
	packet[offset++] = VOICE_CMD_SOUND_SHARE;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	/* Sound name with length prefix */
	packet[offset++] = (uint8_t)strlen(name);
	Com_Memcpy(packet + offset, name, strlen(name));
	offset += strlen(name);

	/* Target player name (server will do fuzzy match and GUID lookup) */
	Com_Memcpy(packet + offset, targetPlayer, strlen(targetPlayer));
	offset += strlen(targetPlayer);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Sharing '%s' with %s...\n", name, targetPlayer);
}

/**
 * Handle /etman pending - List pending share requests
 */
static void ETMan_CmdPending(void)
{
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[64];
	int offset = 0;

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	packet[offset++] = VOICE_CMD_SOUND_PENDING;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Checking pending shares...\n");
}

/**
 * Handle /etman accept <#> [alias]
 */
static void ETMan_CmdAccept(void)
{
	char idStr[16];
	char alias[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;
	int shareIndex;

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman accept <#> [alias]\n");
		CG_Printf("  Accept a pending share. Use /etman pending to see the list.\n");
		CG_Printf("  If no alias given, uses the suggested name from the share.\n");
		CG_Printf("  Example: /etman accept 1        ^5(uses suggested name)\n");
		CG_Printf("  Example: /etman accept 1 myname ^5(custom name)\n");
		return;
	}

	trap_Argv(2, idStr, sizeof(idStr));
	shareIndex = atoi(idStr);

	if (trap_Argc() >= 4)
	{
		trap_Argv(3, alias, sizeof(alias));
	}
	else
	{
		/* Empty alias = server uses suggested alias from the share */
		alias[0] = '\0';
	}

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><fromGuid[32]><index[4]><alias>
	 * Server will look up actual soundFileId and fromGuid from cached pending list */
	packet[offset++] = VOICE_CMD_SOUND_ACCEPT;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	/* fromGuid - placeholder (server looks it up from cache by index) */
	char fromGuid[ETMAN_GUID_LEN + 1];
	Com_Memset(fromGuid, '0', ETMAN_GUID_LEN);
	fromGuid[ETMAN_GUID_LEN] = '\0';
	Com_Memcpy(packet + offset, fromGuid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	/* Send the index (1-based) instead of soundFileId */
	uint32_t indexNet = htonl((uint32_t)shareIndex);
	Com_Memcpy(packet + offset, &indexNet, 4);
	offset += 4;

	Com_Memcpy(packet + offset, alias, strlen(alias));
	offset += strlen(alias);

	ETMan_SendPacket(packet, offset);
	if (alias[0])
	{
		CG_Printf("^3ETMan: Accepting share #%d as '%s'...\n", shareIndex, alias);
	}
	else
	{
		CG_Printf("^3ETMan: Accepting share #%d (using suggested name)...\n", shareIndex);
	}
}

/**
 * Handle /etman reject <#>
 */
static void ETMan_CmdReject(void)
{
	char idStr[16];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;
	int shareIndex;

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman reject <#>\n");
		CG_Printf("  Reject a pending share. Use /etman pending to see the list.\n");
		CG_Printf("  Example: /etman reject 1\n");
		return;
	}

	trap_Argv(2, idStr, sizeof(idStr));
	shareIndex = atoi(idStr);

	if (shareIndex < 1)
	{
		CG_Printf("^1ETMan: Invalid share number. Use /etman pending to see the list.\n");
		return;
	}

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><fromGuid[32]><index[4]>
	 * Server will look up actual soundFileId and fromGuid from cached pending list */
	packet[offset++] = VOICE_CMD_SOUND_REJECT;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	/* fromGuid - placeholder (server looks it up from cache by index) */
	char fromGuid[ETMAN_GUID_LEN + 1];
	Com_Memset(fromGuid, '0', ETMAN_GUID_LEN);
	fromGuid[ETMAN_GUID_LEN] = '\0';
	Com_Memcpy(packet + offset, fromGuid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	/* Send the index (1-based) instead of soundFileId */
	uint32_t indexNet = htonl((uint32_t)shareIndex);
	Com_Memcpy(packet + offset, &indexNet, 4);
	offset += 4;

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Rejecting share #%d...\n", shareIndex);
}

/**
 * Handle /etman playlist create <name>
 */
static void ETMan_CmdPlaylistCreate(void)
{
	char name[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 4)
	{
		CG_Printf("Usage: /etman playlist create <name>\n");
		return;
	}

	trap_Argv(3, name, sizeof(name));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	packet[offset++] = VOICE_CMD_SOUND_PLAYLIST_CREATE;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	Com_Memcpy(packet + offset, name, strlen(name));
	offset += strlen(name);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Creating playlist '%s'...\n", name);
}

/**
 * Handle /etman playlist delete <name>
 */
static void ETMan_CmdPlaylistDelete(void)
{
	char name[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 4)
	{
		CG_Printf("Usage: /etman playlist delete <name>\n");
		return;
	}

	trap_Argv(3, name, sizeof(name));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	packet[offset++] = VOICE_CMD_SOUND_PLAYLIST_DELETE;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	Com_Memcpy(packet + offset, name, strlen(name));
	offset += strlen(name);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Deleting playlist '%s'...\n", name);
}

/**
 * Handle /etman playlist add <playlist> <sound>
 */
static void ETMan_CmdPlaylistAdd(void)
{
	char playlist[ETMAN_MAX_NAME_LEN + 1];
	char sound[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 5)
	{
		CG_Printf("Usage: /etman playlist add <playlist> <sound>\n");
		return;
	}

	trap_Argv(3, playlist, sizeof(playlist));
	trap_Argv(4, sound, sizeof(sound));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><playlistLen[1]><playlist><sound> */
	packet[offset++] = VOICE_CMD_SOUND_PLAYLIST_ADD;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	packet[offset++] = (uint8_t)strlen(playlist);

	Com_Memcpy(packet + offset, playlist, strlen(playlist));
	offset += strlen(playlist);

	Com_Memcpy(packet + offset, sound, strlen(sound));
	offset += strlen(sound);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Adding '%s' to playlist '%s'...\n", sound, playlist);
}

/**
 * Handle /etman playlist remove <playlist> <sound>
 */
static void ETMan_CmdPlaylistRemove(void)
{
	char playlist[ETMAN_MAX_NAME_LEN + 1];
	char sound[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 5)
	{
		CG_Printf("Usage: /etman playlist remove <playlist> <sound>\n");
		return;
	}

	trap_Argv(3, playlist, sizeof(playlist));
	trap_Argv(4, sound, sizeof(sound));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	packet[offset++] = VOICE_CMD_SOUND_PLAYLIST_REMOVE;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	packet[offset++] = (uint8_t)strlen(playlist);

	Com_Memcpy(packet + offset, playlist, strlen(playlist));
	offset += strlen(playlist);

	Com_Memcpy(packet + offset, sound, strlen(sound));
	offset += strlen(sound);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Removing '%s' from playlist '%s'...\n", sound, playlist);
}

/**
 * Handle /etman playlist <name> [#] - List or play from playlist
 */
static void ETMan_CmdPlaylistShow(const char *playlistName)
{
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;
	int position = 0;

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Check if a position number was given */
	if (trap_Argc() >= 4)
	{
		char posStr[8];
		trap_Argv(3, posStr, sizeof(posStr));
		position = atoi(posStr);
	}

	if (position > 0)
	{
		/* Play sound at position */
		packet[offset++] = VOICE_CMD_SOUND_PLAYLIST_PLAY;

		uint32_t clientId = htonl((uint32_t)cg.clientNum);
		Com_Memcpy(packet + offset, &clientId, 4);
		offset += 4;

		Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
		offset += ETMAN_GUID_LEN;

		packet[offset++] = (uint8_t)strlen(playlistName);

		Com_Memcpy(packet + offset, playlistName, strlen(playlistName));
		offset += strlen(playlistName);

		packet[offset++] = (uint8_t)position;

		ETMan_SendPacket(packet, offset);
		CG_Printf("^3ETMan: Playing #%d from '%s'...\n", position, playlistName);
	}
	else
	{
		/* List sounds in playlist - send PLAYLIST_LIST with the playlist name */
		packet[offset++] = VOICE_CMD_SOUND_PLAYLIST_LIST;

		uint32_t clientId = htonl((uint32_t)cg.clientNum);
		Com_Memcpy(packet + offset, &clientId, 4);
		offset += 4;

		Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
		offset += ETMAN_GUID_LEN;

		/* Include playlist name to get its contents */
		Com_Memcpy(packet + offset, playlistName, strlen(playlistName));
		offset += strlen(playlistName);

		ETMan_SendPacket(packet, offset);
		CG_Printf("^3ETMan: Listing sounds in '%s'...\n", playlistName);
	}
}

/**
 * Handle /etman playlists or /etman categories
 */
static void ETMan_CmdPlaylists(void)
{
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[64];
	int offset = 0;

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	packet[offset++] = VOICE_CMD_SOUND_PLAYLIST_LIST;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Listing playlists...\n");
}

/**
 * Handle /etman playnext <playlist> - Play next sound from playlist
 * Uses position=0 which server interprets as "use current position, then advance"
 */
static void ETMan_CmdPlayNext(void)
{
	char playlistName[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman playnext <playlist>\n");
		return;
	}

	trap_Argv(2, playlistName, sizeof(playlistName));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	packet[offset++] = VOICE_CMD_SOUND_PLAYLIST_PLAY;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	packet[offset++] = (uint8_t)strlen(playlistName);

	Com_Memcpy(packet + offset, playlistName, strlen(playlistName));
	offset += strlen(playlistName);

	packet[offset++] = 0;  /* position=0 means "next" */

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Playing next from '%s'...\n", playlistName);
}

/**
 * Handle /etman playrandom <playlist> - Play random sound from playlist
 * Uses position=255 which server interprets as "random"
 */
static void ETMan_CmdPlayRandom(void)
{
	char playlistName[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman playrandom <playlist>\n");
		return;
	}

	trap_Argv(2, playlistName, sizeof(playlistName));

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	packet[offset++] = VOICE_CMD_SOUND_PLAYLIST_PLAY;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	packet[offset++] = (uint8_t)strlen(playlistName);

	Com_Memcpy(packet + offset, playlistName, strlen(playlistName));
	offset += strlen(playlistName);

	packet[offset++] = 255;  /* position=255 means "random" */

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Playing random from '%s'...\n", playlistName);
}

/**
 * Handle /etman publicplaynext <playlist> - Play next from public playlist
 */
static void ETMan_CmdPublicPlayNext(void)
{
	char playlistName[ETMAN_MAX_NAME_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman publicplaynext <playlist>\n");
		return;
	}

	trap_Argv(2, playlistName, sizeof(playlistName));

	packet[offset++] = VOICE_CMD_PLAYLIST_PUBLIC_SHOW;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	packet[offset++] = (uint8_t)strlen(playlistName);

	Com_Memcpy(packet + offset, playlistName, strlen(playlistName));
	offset += strlen(playlistName);

	packet[offset++] = 254;  /* position=254 means "next" for public playlists */

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Playing next from public playlist '%s'...\n", playlistName);
}

/**
 * Handle /etman publicplayrandom <playlist> - Play random from public playlist
 */
static void ETMan_CmdPublicPlayRandom(void)
{
	char playlistName[ETMAN_MAX_NAME_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman publicplayrandom <playlist>\n");
		return;
	}

	trap_Argv(2, playlistName, sizeof(playlistName));

	packet[offset++] = VOICE_CMD_PLAYLIST_PUBLIC_SHOW;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	packet[offset++] = (uint8_t)strlen(playlistName);

	Com_Memcpy(packet + offset, playlistName, strlen(playlistName));
	offset += strlen(playlistName);

	packet[offset++] = 255;  /* position=255 means "random" */

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Playing random from public playlist '%s'...\n", playlistName);
}

/**
 * Handle /etman visibility <name> <private|shared|public>
 */
static void ETMan_CmdVisibility(void)
{
	char name[ETMAN_MAX_NAME_LEN + 1];
	char visibility[16];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;

	if (trap_Argc() < 4)
	{
		CG_Printf("Usage: /etman visibility <name> <private|shared|public>\n");
		CG_Printf("  private = only you can see/play\n");
		CG_Printf("  shared  = can be shared with others\n");
		CG_Printf("  public  = appears in public library\n");
		return;
	}

	trap_Argv(2, name, sizeof(name));
	trap_Argv(3, visibility, sizeof(visibility));

	/* Validate visibility value */
	if (Q_stricmp(visibility, "private") != 0 &&
	    Q_stricmp(visibility, "shared") != 0 &&
	    Q_stricmp(visibility, "public") != 0)
	{
		CG_Printf("^1ETMan: Invalid visibility. Use: private, shared, or public\n");
		return;
	}

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><nameLen[1]><name><visibility> */
	packet[offset++] = VOICE_CMD_SOUND_SET_VISIBILITY;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	packet[offset++] = (uint8_t)strlen(name);

	Com_Memcpy(packet + offset, name, strlen(name));
	offset += strlen(name);

	Com_Memcpy(packet + offset, visibility, strlen(visibility));
	offset += strlen(visibility);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Setting '%s' to %s...\n", name, visibility);
}

/**
 * Handle /etman public [page]
 */
static void ETMan_CmdPublic(void)
{
	uint8_t packet[64];
	int offset = 0;
	int page = 0;

	if (trap_Argc() >= 3)
	{
		char pageStr[8];
		trap_Argv(2, pageStr, sizeof(pageStr));
		page = atoi(pageStr);
		if (page < 0) page = 0;
	}

	packet[offset++] = VOICE_CMD_SOUND_PUBLIC_LIST;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	/* Offset for pagination (25 sounds per page) */
	uint16_t pageOffset = htons((uint16_t)(page * 25));
	Com_Memcpy(packet + offset, &pageOffset, 2);
	offset += 2;

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Listing public sounds (page %d)...\n", page + 1);
}

/**
 * Handle /etman getpublic <id> <alias>
 */
static void ETMan_CmdGetPublic(void)
{
	char idStr[16];
	char alias[ETMAN_MAX_NAME_LEN + 1];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;
	int soundFileId;

	if (trap_Argc() < 4)
	{
		CG_Printf("Usage: /etman getpublic <id> <alias>\n");
		CG_Printf("  Add a public sound to your library with your own name.\n");
		CG_Printf("  Use /etman public to see available sounds and their IDs.\n");
		return;
	}

	trap_Argv(2, idStr, sizeof(idStr));
	trap_Argv(3, alias, sizeof(alias));
	soundFileId = atoi(idStr);

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><soundFileId[4]><alias> */
	packet[offset++] = VOICE_CMD_SOUND_PUBLIC_ADD;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	uint32_t fileId = htonl((uint32_t)soundFileId);
	Com_Memcpy(packet + offset, &fileId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, alias, strlen(alias));
	offset += strlen(alias);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Adding public sound as '%s'...\n", alias);
}

/**
 * Handle /etman publicplaylists - List public playlists
 */
static void ETMan_CmdPublicPlaylists(void)
{
	uint8_t packet[64];
	int offset = 0;

	packet[offset++] = VOICE_CMD_PLAYLIST_PUBLIC_LIST;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Listing public playlists...\n");
}

/**
 * Handle /etman plvisibility <playlist> <public|private>
 */
static void ETMan_CmdPlaylistVisibility(void)
{
	char playlistName[ETMAN_MAX_NAME_LEN + 1];
	char visibility[16];
	char guid[ETMAN_GUID_LEN + 1];
	uint8_t packet[128];
	int offset = 0;
	uint8_t nameLen;
	uint8_t isPublic;

	if (trap_Argc() < 4)
	{
		CG_Printf("Usage: /etman plvisibility <playlist> <public|private>\n");
		return;
	}

	trap_Argv(2, playlistName, sizeof(playlistName));
	trap_Argv(3, visibility, sizeof(visibility));

	if (Q_stricmp(visibility, "public") == 0)
	{
		isPublic = 1;
	}
	else if (Q_stricmp(visibility, "private") == 0)
	{
		isPublic = 0;
	}
	else
	{
		CG_Printf("^1ETMan: Visibility must be 'public' or 'private'\n");
		return;
	}

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: <type><clientId[4]><guid[32]><nameLen[1]><name><isPublic[1]> */
	packet[offset++] = VOICE_CMD_PLAYLIST_SET_VISIBILITY;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	nameLen = (uint8_t)strlen(playlistName);
	packet[offset++] = nameLen;
	Com_Memcpy(packet + offset, playlistName, nameLen);
	offset += nameLen;

	packet[offset++] = isPublic;

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Setting playlist '%s' to %s...\n", playlistName, visibility);
}

/**
 * Handle /etman publicplaylist <name> [#]
 * List songs in a public playlist, or play from it
 */
static void ETMan_CmdPublicPlaylistShow(void)
{
	char playlistName[ETMAN_MAX_NAME_LEN + 1];
	char posStr[16];
	uint8_t packet[128];
	int offset = 0;
	uint8_t nameLen;
	int position = 0;

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman publicplaylist <name> [#]\n");
		CG_Printf("  Without #: List songs in the public playlist\n");
		CG_Printf("  With #: Play song at that position\n");
		return;
	}

	trap_Argv(2, playlistName, sizeof(playlistName));

	/* Check if position specified */
	if (trap_Argc() >= 4)
	{
		trap_Argv(3, posStr, sizeof(posStr));
		position = atoi(posStr);
		if (position < 1)
		{
			CG_Printf("^1ETMan: Position must be 1 or higher\n");
			return;
		}
	}

	/* Build packet: <type><clientId[4]><nameLen[1]><name><position[1]> */
	packet[offset++] = VOICE_CMD_PLAYLIST_PUBLIC_SHOW;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	nameLen = (uint8_t)strlen(playlistName);
	packet[offset++] = nameLen;

	Com_Memcpy(packet + offset, playlistName, nameLen);
	offset += nameLen;

	packet[offset++] = (uint8_t)position;

	ETMan_SendPacket(packet, offset);
	if (position > 0)
	{
		CG_Printf("^3ETMan: Playing #%d from public playlist '%s'...\n", position, playlistName);
	}
	else
	{
		CG_Printf("^3ETMan: Listing public playlist '%s'...\n", playlistName);
	}
}

/**
 * Handle /etman register
 */
static void ETMan_CmdRegister(void)
{
	char guid[ETMAN_GUID_LEN + 1];
	char playerName[64];
	uint8_t packet[128];
	int offset = 0;

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Get player name */
	Q_strncpyz(playerName, cgs.clientinfo[cg.clientNum].name, sizeof(playerName));

	/* Build packet: <type><clientId[4]><guid[32]><playerName> */
	packet[offset++] = VOICE_CMD_ACCOUNT_REGISTER;

	uint32_t clientId = htonl((uint32_t)cg.clientNum);
	Com_Memcpy(packet + offset, &clientId, 4);
	offset += 4;

	Com_Memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	Com_Memcpy(packet + offset, playerName, strlen(playerName));
	offset += strlen(playerName);

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Requesting registration code...\n");
}

/**
 * Handle /etman playlist subcommand routing
 */
static void ETMan_CmdPlaylist(void)
{
	char subcmd[32];

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman playlist <create|delete|add|remove|name> ...\n");
		CG_Printf("  /etman playlist create <name>           ^5- Create playlist\n");
		CG_Printf("  /etman playlist delete <name>           ^5- Delete playlist\n");
		CG_Printf("  /etman playlist add <playlist> <sound>  ^5- Add sound to playlist\n");
		CG_Printf("  /etman playlist remove <playlist> <sound> ^5- Remove from playlist\n");
		CG_Printf("  /etman playlist <name>                  ^5- List sounds in playlist\n");
		CG_Printf("  /etman playlist <name> <#>              ^5- Play sound at position\n");
		return;
	}

	trap_Argv(2, subcmd, sizeof(subcmd));

	if (Q_stricmp(subcmd, "create") == 0)
	{
		ETMan_CmdPlaylistCreate();
	}
	else if (Q_stricmp(subcmd, "delete") == 0)
	{
		ETMan_CmdPlaylistDelete();
	}
	else if (Q_stricmp(subcmd, "add") == 0)
	{
		ETMan_CmdPlaylistAdd();
	}
	else if (Q_stricmp(subcmd, "remove") == 0)
	{
		ETMan_CmdPlaylistRemove();
	}
	else
	{
		/* Assume it's a playlist name */
		ETMan_CmdPlaylistShow(subcmd);
	}
}

/**
 * Show help
 */
static void ETMan_ShowHelp(void)
{
	CG_Printf("\n^3ETMan Commands:\n");
	CG_Printf("^5=== Sound Commands ===\n");
	CG_Printf("^7  /etman addsnd <url> <name>    ^5- Download MP3 from URL\n");
	CG_Printf("^7  /etman playsnd <name>         ^5- Play sound to all players\n");
	CG_Printf("^7  /etman listsnd                ^5- List your sounds\n");
	CG_Printf("^7  /etman delsnd <name>          ^5- Delete a sound\n");
	CG_Printf("^7  /etman renamesnd <old> <new>  ^5- Rename a sound\n");
	CG_Printf("^7  /etman stopsnd                ^5- Stop playing sound\n");
	CG_Printf("\n^5=== Playlists ===\n");
	CG_Printf("^7  /etman playlists              ^5- List your playlists\n");
	CG_Printf("^7  /etman playlist <name>        ^5- Show sounds in playlist\n");
	CG_Printf("^7  /etman playlist create <name> ^5- Create a playlist\n");
	CG_Printf("^7  /etman playlist delete <name> ^5- Delete a playlist\n");
	CG_Printf("^7  /etman playlist add <pl> <snd> ^5- Add sound to playlist\n");
	CG_Printf("^7  /etman playlist remove <pl> <snd> ^5- Remove from playlist\n");
	CG_Printf("^7  /etman playlist <name> <#>    ^5- Play sound at position\n");
	CG_Printf("^7  /etman playnext <playlist>   ^5- Play next in playlist (cycles)\n");
	CG_Printf("^7  /etman playrandom <playlist> ^5- Play random from playlist\n");
	CG_Printf("^7  /etman publicplaylists        ^5- Browse public playlists\n");
	CG_Printf("^7  /etman publicplaylist <name>  ^5- List songs in public playlist\n");
	CG_Printf("^7  /etman publicplaylist <name> <#> ^5- Play from public playlist\n");
	CG_Printf("^7  /etman publicplaynext <name> ^5- Play next from public playlist\n");
	CG_Printf("^7  /etman publicplayrandom <name> ^5- Play random from public playlist\n");
	CG_Printf("^7  /etman plvisibility <pl> <vis> ^5- Set playlist public/private\n");
	CG_Printf("\n^5=== Sharing ===\n");
	CG_Printf("^7  /etman share <name> <player>  ^5- Share with player\n");
	CG_Printf("^7  /etman pending                ^5- List pending shares\n");
	CG_Printf("^7  /etman accept <#> [alias]     ^5- Accept share (e.g. accept 1)\n");
	CG_Printf("^7  /etman reject <#>             ^5- Reject share (e.g. reject 1)\n");
	CG_Printf("\n^5=== Visibility & Public ===\n");
	CG_Printf("^7  /etman visibility <name> <vis> ^5- Set private/shared/public\n");
	CG_Printf("^7  /etman public [page]          ^5- Browse public sounds\n");
	CG_Printf("^7  /etman getpublic <id> <alias> ^5- Add public sound to library\n");
	CG_Printf("\n^5=== Account ===\n");
	CG_Printf("^7  /etman register               ^5- Get ETPanel registration code\n");
	CG_Printf("\n^5=== Quick Play by ID ===\n");
	CG_Printf("^7  /etman playid <id>            ^5- Play sound by database ID\n");
	CG_Printf("^7  ^3Example bind: bind F5 \"etman playid 42\"\n");
	CG_Printf("\n^3Limits: ^7100 sounds, 5MB/file, 30 sec max\n");
}

/**
 * Main command handler for /etman
 */
void ETMan_Cmd_f(void)
{
	char subcmd[32];

	if (!etman.initialized)
	{
		CG_Printf("^1ETMan: Not initialized\n");
		return;
	}

	if (trap_Argc() < 2)
	{
		ETMan_ShowHelp();
		return;
	}

	trap_Argv(1, subcmd, sizeof(subcmd));

	/* Sound commands - use "snd" suffix for clarity */
	if (Q_stricmp(subcmd, "addsnd") == 0 || Q_stricmp(subcmd, "add") == 0)
	{
		ETMan_CmdAdd();
	}
	else if (Q_stricmp(subcmd, "playsnd") == 0 || Q_stricmp(subcmd, "play") == 0)
	{
		ETMan_CmdPlay();
	}
	else if (Q_stricmp(subcmd, "listsnd") == 0 || Q_stricmp(subcmd, "list") == 0)
	{
		ETMan_CmdList();
	}
	else if (Q_stricmp(subcmd, "delsnd") == 0 || Q_stricmp(subcmd, "delete") == 0)
	{
		ETMan_CmdDelete();
	}
	else if (Q_stricmp(subcmd, "renamesnd") == 0 || Q_stricmp(subcmd, "rename") == 0)
	{
		ETMan_CmdRename();
	}
	else if (Q_stricmp(subcmd, "stopsnd") == 0 || Q_stricmp(subcmd, "stop") == 0)
	{
		ETMan_CmdStop();
	}
	/* Sharing commands */
	else if (Q_stricmp(subcmd, "sharesnd") == 0 || Q_stricmp(subcmd, "share") == 0)
	{
		ETMan_CmdShare();
	}
	else if (Q_stricmp(subcmd, "pending") == 0)
	{
		ETMan_CmdPending();
	}
	else if (Q_stricmp(subcmd, "accept") == 0)
	{
		ETMan_CmdAccept();
	}
	else if (Q_stricmp(subcmd, "reject") == 0)
	{
		ETMan_CmdReject();
	}
	/* Playlist commands */
	else if (Q_stricmp(subcmd, "playlist") == 0)
	{
		ETMan_CmdPlaylist();
	}
	else if (Q_stricmp(subcmd, "playlists") == 0 || Q_stricmp(subcmd, "categories") == 0)
	{
		ETMan_CmdPlaylists();
	}
	else if (Q_stricmp(subcmd, "playnext") == 0)
	{
		ETMan_CmdPlayNext();
	}
	else if (Q_stricmp(subcmd, "playrandom") == 0)
	{
		ETMan_CmdPlayRandom();
	}
	/* Visibility and public library */
	else if (Q_stricmp(subcmd, "visibility") == 0)
	{
		ETMan_CmdVisibility();
	}
	else if (Q_stricmp(subcmd, "public") == 0)
	{
		ETMan_CmdPublic();
	}
	else if (Q_stricmp(subcmd, "getpublic") == 0)
	{
		ETMan_CmdGetPublic();
	}
	else if (Q_stricmp(subcmd, "publicplaylists") == 0)
	{
		ETMan_CmdPublicPlaylists();
	}
	else if (Q_stricmp(subcmd, "plvisibility") == 0)
	{
		ETMan_CmdPlaylistVisibility();
	}
	else if (Q_stricmp(subcmd, "publicplaylist") == 0)
	{
		ETMan_CmdPublicPlaylistShow();
	}
	else if (Q_stricmp(subcmd, "publicplaynext") == 0)
	{
		ETMan_CmdPublicPlayNext();
	}
	else if (Q_stricmp(subcmd, "publicplayrandom") == 0)
	{
		ETMan_CmdPublicPlayRandom();
	}
	/* Account registration */
	else if (Q_stricmp(subcmd, "register") == 0)
	{
		ETMan_CmdRegister();
	}
	/* Quick play by ID */
	else if (Q_stricmp(subcmd, "playid") == 0)
	{
		ETMan_CmdPlayId();
	}
	else if (Q_stricmp(subcmd, "help") == 0)
	{
		ETMan_ShowHelp();
	}
	else
	{
		CG_Printf("^1ETMan: Unknown command '%s'\n", subcmd);
		ETMan_ShowHelp();
	}
}

/**
 * Handle response packet from voice server
 */
void ETMan_HandleResponse(const uint8_t *data, int dataLen)
{
	if (dataLen < 2)
	{
		return;
	}

	uint8_t respType = data[0];
	const char *message = (const char *)(data + 1);

	switch (respType)
	{
	case VOICE_RESP_SUCCESS:
		CG_Printf("^2ETMan: %s\n", message);
		break;

	case VOICE_RESP_ERROR:
		CG_Printf("^1ETMan: %s\n", message);
		break;

	case VOICE_RESP_LIST:
		CG_Printf("^3ETMan: %s\n", message);
		break;

	case VOICE_RESP_PROGRESS:
		/* Download progress update - could show in HUD */
		break;

	case VOICE_RESP_SHARE_REQ:
		/* TODO: Parse and show share request prompt */
		CG_Printf("^3ETMan: Share request received\n");
		break;

	case VOICE_RESP_REGISTER_CODE:
	{
		/* Registration code response - store in cvar and show in console */
		char url[256];
		char code[16];

		/* Message format from server: just the 6-char code */
		Q_strncpyz(code, message, sizeof(code));

		/* Store code in cvar so menu can use it */
		trap_Cvar_Set("etman_regcode", code);

		/* Construct URL with code */
		Com_sprintf(url, sizeof(url), "https://etpanel.etman.dev/register?code=%s", code);

		/* Store full URL in cvar for menu button */
		trap_Cvar_Set("etman_regurl", url);

		/* Set ui_finalURL - this is what uiScript validate_openURL uses when called with no args */
		trap_Cvar_Set("ui_finalURL", url);

		/* Set status text for the menu to display */
		trap_Cvar_Set("etman_regstatus", va("^2Code ready: ^5%s ^7- Click REGISTER below!", code));

		/* Show in console */
		CG_Printf("\n^2========================================\n");
		CG_Printf("^3Registration code: ^5%s\n", code);
		CG_Printf("^7Click REGISTER button or copy URL:\n");
		CG_Printf("^5%s\n", url);
		CG_Printf("^2========================================\n\n");
		break;
	}

	case VOICE_RESP_MENU_DATA:
		/* Binary menu data from server - use new hierarchical parser */
		ETMan_ParseHierarchicalMenuData(data + 1, dataLen - 1);
		break;

	default:
		break;
	}
}

/**
 * Per-frame processing
 */
void ETMan_Frame(void)
{
	if (!etman.initialized)
	{
		return;
	}

	/* Close sound menu when intermission starts - otherwise cursor gets stuck hidden
	 * because the debriefing screen expects to control the mouse */
	if (etman.menuActive && cg.snap && cg.snap->ps.pm_type == PM_INTERMISSION)
	{
		ETMan_CloseMenu();
	}

	/* Key handling is now done in ETMan_SoundMenu_KeyHandling via CG_KeyEvent
	 * when KEYCATCH_CGAME is active - this prevents weapon binds from firing */

	/* Check for expired share requests */
	if (etman.hasShareRequest)
	{
		if (cg.time - etman.shareRequestTime > 30000)
		{
			/* 30 second timeout */
			etman.hasShareRequest = qfalse;
		}
	}
}

/**
 * Draw UI elements (share prompts, etc)
 */
void ETMan_Draw(void)
{
	if (!etman.initialized)
	{
		return;
	}

	/* Note: trap_OpenURL crashes in Flatpak ET:Legacy, so browser auto-open is disabled */

	/* Draw sound menu if active */
	if (etman.menuActive)
	{
		if (etman.rootState == ETMAN_ROOT_SERVER)
		{
			/* Draw header tip about quick commands for server sounds */
			ETMan_DrawServerSoundsHeader();
		}
		else if (etman.rootState == ETMAN_ROOT_USER && !etman.userHasSounds && etman.menuDataLoaded)
		{
			/* Show registration promo if user has no sounds */
			ETMan_DrawUserPromo();
			return;  /* Don't draw menu, promo replaces it */
		}

		ETMan_DrawMenu();
	}

	/* TODO: Draw share request prompt if active */
	if (etman.hasShareRequest)
	{
		/* Draw F1/F2 prompt */
	}
}

/*
 * ============================================================================
 * Sound Menu Implementation
 * ============================================================================
 */

/**
 * Request menu data from server
 */
void ETMan_RequestMenus(void)
{
	char     guid[ETMAN_GUID_LEN + 1];
	uint8_t  packet[64];
	int      offset = 0;
	uint32_t clientId;

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: [type:1][clientId:4][guid:32] */
	packet[offset++] = VOICE_CMD_MENU_GET;

	/* ClientId placeholder (server uses stored mapping) */
	clientId = htonl(0);
	memcpy(packet + offset, &clientId, 4);
	offset += 4;

	memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	ETMan_SendPacket(packet, offset);
	etman.menuRequestTime = cg.time;

	CG_Printf("^3ETMan: Requesting menu data...\n");
}

/**
 * Parse binary menu data from server
 */
static void ETMan_ParseMenuData(const uint8_t *data, int dataLen)
{
	int offset = 0;
	int menuCount;
	int m, ii;
	uint8_t nameLen, itemNameLen, aliasLen;
	int itemCount;
	etmanMenu_t *menu;
	etmanMenuItem_t *item;

	if (dataLen < 1)
	{
		return;
	}

	/* Check for NO_MENUS response */
	if (dataLen >= 8 && memcmp(data, "NO_MENUS", 8) == 0)
	{
		etman.menuCount      = 0;
		etman.menuDataLoaded = qtrue;
		CG_Printf("^3ETMan: No menus configured. Create menus at etpanel.etman.dev\n");
		return;
	}

	menuCount = data[offset++];
	if (menuCount > ETMAN_MAX_MENUS)
	{
		menuCount = ETMAN_MAX_MENUS;
	}

	etman.menuCount = 0;

	for (m = 0; m < menuCount && offset < dataLen; m++)
	{
		menu = &etman.menus[etman.menuCount];
		Com_Memset(menu, 0, sizeof(etmanMenu_t));

		if (offset + 3 > dataLen)
		{
			break;
		}

		menu->position = data[offset++];
		nameLen = data[offset++];

		if (offset + nameLen + 1 > dataLen)
		{
			break;
		}

		if (nameLen > ETMAN_MAX_NAME_LEN)
		{
			nameLen = ETMAN_MAX_NAME_LEN;
		}
		memcpy(menu->name, data + offset, nameLen);
		menu->name[nameLen] = '\0';
		offset += nameLen;

		itemCount = data[offset++];
		menu->itemCount = 0;

		for (ii = 0; ii < itemCount && ii < ETMAN_MAX_MENU_ITEMS && offset < dataLen; ii++)
		{
			item = &menu->items[menu->itemCount];

			if (offset + 2 > dataLen)
			{
				break;
			}

			item->position = data[offset++];

			itemNameLen = data[offset++];
			if (offset + itemNameLen + 1 > dataLen)
			{
				break;
			}
			if (itemNameLen > ETMAN_MAX_NAME_LEN)
			{
				itemNameLen = ETMAN_MAX_NAME_LEN;
			}
			memcpy(item->name, data + offset, itemNameLen);
			item->name[itemNameLen] = '\0';
			offset += itemNameLen;

			aliasLen = data[offset++];
			if (offset + aliasLen > dataLen)
			{
				break;
			}
			if (aliasLen > ETMAN_MAX_NAME_LEN)
			{
				aliasLen = ETMAN_MAX_NAME_LEN;
			}
			memcpy(item->soundAlias, data + offset, aliasLen);
			item->soundAlias[aliasLen] = '\0';
			offset += aliasLen;

			menu->itemCount++;
		}

		etman.menuCount++;
	}

	etman.menuDataLoaded = qtrue;
	CG_Printf("^2ETMan: Loaded %d sound menus\n", etman.menuCount);
}

/**
 * Close the sound menu
 */
void ETMan_CloseMenu(void)
{
	etman.menuActive       = qfalse;
	etman.currentMenuLevel = 0;
	etman.selectedMenu     = 0;
	etman.rootState        = ETMAN_ROOT_CHOICE;
	cgs.eventHandling = CGAME_EVENT_NONE;
	cgDC.cursorVisible = qtrue;  /* Restore cursor visibility for intermission/other menus */
	trap_Cvar_Set("cl_bypassmouseinput", "0");  /* Reset so other menus can capture mouse */
	trap_Key_SetCatcher(trap_Key_GetCatcher() & ~KEYCATCH_CGAME);
}

/**
 * Open the sound menu with a specific menu type
 */
static void ETMan_OpenMenuWithType(etmanMenuType_t menuType)
{
	etman.menuActive       = qtrue;
	etman.currentMenuLevel = 0;
	etman.selectedMenu     = 0;
	etman.currentMenuType  = menuType;  /* Set the menu type before requesting */

	/* Set root state based on menu type */
	if (menuType == ETMAN_MENU_SERVER)
	{
		etman.rootState = ETMAN_ROOT_SERVER;
	}
	else
	{
		etman.rootState = ETMAN_ROOT_USER;
	}

	/* Reset navigation stack and force data reload */
	etman.navStack.depth = 0;
	etman.menuDataLoaded = qfalse;
	etman.currentMenu.itemCount = 0;

	/* Capture keys so weapon binds don't fire, but allow mouse movement */
	cgs.eventHandling = CGAME_EVENT_SOUNDMENU;
	cgDC.cursorVisible = qfalse;  /* No cursor needed */
	trap_Cvar_Set("cl_bypassmouseinput", "1");  /* Mouse goes to normal view movement, not cgame */
	trap_Key_SetCatcher(KEYCATCH_CGAME);

	/* Always request fresh menu data */
	CG_Printf("^3ETMan: Requesting %s menu data...\n",
	          menuType == ETMAN_MENU_SERVER ? "server" : "personal");
	ETMan_RequestMenuPage(0, 0);
}

/**
 * Open the sound menu (user's personal sounds)
 */
void ETMan_OpenMenu(void)
{
	ETMan_OpenMenuWithType(ETMAN_MENU_PERSONAL);
}

/**
 * Open the server sound menu (direct, skips root choice)
 */
void ETMan_OpenServerMenu(void)
{
	ETMan_OpenMenuWithType(ETMAN_MENU_SERVER);
}

/**
 * Toggle menu visibility
 */
void ETMan_ToggleMenu(void)
{
	if (!etman.initialized)
	{
		CG_Printf("^1ETMan: Not initialized\n");
		return;
	}

	if (etman.menuActive)
	{
		CG_Printf("^3ETMan: Closing menu\n");
		ETMan_CloseMenu();
	}
	else
	{
		CG_Printf("^3ETMan: Opening menu\n");
		ETMan_OpenMenu();
	}
}

/**
 * Check if menu is active
 */
qboolean ETMan_IsMenuActive(void)
{
	return etman.menuActive;
}

/**
 * Handle key event while menu is active (hierarchical version)
 * @param key - integer 0-9 representing the key pressed
 *              0 = next page (pagination)
 *              1-9 = select item
 *              Use Backspace for back navigation
 */
qboolean ETMan_MenuKeyEvent(int key)
{
	int i;
	etmanMenuItem_t *item;

	if (!etman.menuActive)
	{
		return qfalse;
	}

	/* Handle user promo screen - press 1 to open register menu */
	if (etman.rootState == ETMAN_ROOT_USER && !etman.userHasSounds && etman.menuDataLoaded)
	{
		if (key == 1)
		{
			/* Close HUD menu, set cvar flag, open ingame UI which will check the cvar */
			ETMan_CloseMenu();
			trap_Cvar_Set("etman_openregister", "1");
			trap_UI_Popup(UIMENU_INGAME);
			return qtrue;
		}
		/* Other number keys do nothing (backspace handled elsewhere) */
		return qtrue;  /* Consume the key */
	}

	/* 0 = show next page (pagination) */
	if (key == 0)
	{
		if (etman.currentMenu.totalItems > ETMAN_ITEMS_PER_PAGE)
		{
			ETMan_NextPage();
			CG_Printf("^3ETMan: Loading next page...\n");
		}
		else
		{
			CG_Printf("^3ETMan: No more pages\n");
		}
		return qtrue;
	}

	/* Number keys 1-9: select item at position */
	if (key >= 1 && key <= 9)
	{
		for (i = 0; i < etman.currentMenu.itemCount; i++)
		{
			item = &etman.currentMenu.items[i];
			if (item->position == key)
			{
				if (item->itemType == ETMAN_ITEM_MENU)
				{
					/* Navigate into nested menu/playlist */
					CG_Printf("^3ETMan: Entering '%s'...\n", item->name);
					ETMan_NavigateToMenu(item->nestedMenuId, 0);
				}
				else
				{
					/* Play this sound */
					CG_Printf("^2ETMan: Playing '%s'\n", item->name);
					ETMan_PlayMenuSound(item->soundAlias);
					ETMan_CloseMenu();
				}
				return qtrue;
			}
		}
		CG_Printf("^1ETMan: No item at position %d\n", key);
	}

	return qfalse;
}

/**
 * Play a sound from the menu
 */
static void ETMan_PlayMenuSound(const char *soundAlias)
{
	char     guid[ETMAN_GUID_LEN + 1];
	uint8_t  packet[128];
	int      offset = 0;
	uint32_t clientId;
	int      nameLen;

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: [type:1][clientId:4][guid:32][name] */
	packet[offset++] = VOICE_CMD_SOUND_PLAY;

	clientId = htonl((uint32_t)cg.clientNum);
	memcpy(packet + offset, &clientId, 4);
	offset += 4;

	memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	nameLen = strlen(soundAlias);
	if (nameLen > ETMAN_MAX_NAME_LEN)
	{
		nameLen = ETMAN_MAX_NAME_LEN;
	}
	memcpy(packet + offset, soundAlias, nameLen);
	offset += nameLen;

	ETMan_SendPacket(packet, offset);
}

/**
 * Draw the menu HUD - CLASSIC STYLE (centered, top of screen)
 * Backup style - use cg_soundMenuStyle 0 to enable
 */
static void ETMan_DrawMenu_Classic(void)
{
	float   x, y, w, h;
	float   lineHeight = 11;
	float   padding    = 3;
	int     i;
	vec4_t  bgColor    = { 0.0f, 0.0f, 0.0f, 0.85f };
	vec4_t  titleColor = { 1.0f, 0.8f, 0.2f, 1.0f };  /* Yellow/gold for title */
	float   textY;
	etmanMenuItem_t *item;
	int     currentPage, totalPages;
	char    titleText[64];
	char    itemText[64];

	/* Position centered horizontally, at top (uses widescreen coords) */
	w = 240;
	x = (Ccg_WideX(SCREEN_WIDTH) - w) / 2;
	y = 10;

	/* Calculate height based on content */
	if (!etman.menuDataLoaded)
	{
		h = padding * 2 + lineHeight * 3;
	}
	else
	{
		/* Title + items + footer (with pagination info) + extra bottom padding */
		h = padding * 2 + lineHeight * (2 + etman.currentMenu.itemCount + 1) + 4;
	}

	/* Draw background */
	CG_FillRect(x, y, w, h, bgColor);
	CG_DrawRect_FixedBorder(x, y, w, h, 1, colorWhite);

	textY = y + padding;

	if (!etman.menuDataLoaded)
	{
		/* Loading state */
		CG_Text_Paint_Ext(x + padding, textY + 12, 0.22f, 0.22f, titleColor, "Sound Menu", 0, 0, 0, &cgs.media.limboFont2);
		textY += lineHeight;
		CG_Text_Paint_Ext(x + padding, textY + 12, 0.18f, 0.18f, colorWhite, "Loading...", 0, 0, 0, &cgs.media.limboFont2);
		return;
	}

	/* Title with breadcrumb if nested */
	if (etman.navStack.depth > 0)
	{
		Com_sprintf(titleText, sizeof(titleText), "%s", etman.currentMenu.name[0] ? etman.currentMenu.name : "Menu");
	}
	else
	{
		Q_strncpyz(titleText, "Sound Menu", sizeof(titleText));
	}
	CG_Text_Paint_Ext(x + padding, textY + 12, 0.22f, 0.22f, titleColor, titleText, 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight + 6;  /* Extra space after title */

	/* Draw separator line */
	CG_FillRect(x + padding, textY, w - padding * 2, 1, colorWhite);
	textY += 3;

	if (etman.currentMenu.itemCount == 0)
	{
		CG_Text_Paint_Ext(x + padding, textY + 12, 0.18f, 0.18f, colorWhite, "No items", 0, 0, 0, &cgs.media.limboFont2);
		textY += lineHeight;
	}
	else
	{
		/* Draw menu items with color coding */
		for (i = 0; i < etman.currentMenu.itemCount; i++)
		{
			item = &etman.currentMenu.items[i];

			if (item->itemType == ETMAN_ITEM_MENU)
			{
				/* Cyan for playlists/menus - indicates drilling deeper */
				Com_sprintf(itemText, sizeof(itemText), "^3%d. ^5%s ^7>", item->position, item->name);
			}
			else
			{
				/* White for sounds - indicates playable */
				Com_sprintf(itemText, sizeof(itemText), "^3%d. ^7%s", item->position, item->name);
			}

			CG_Text_Paint_Ext(x + padding, textY + 12, 0.18f, 0.18f, colorWhite, itemText, 0, 0, 0, &cgs.media.limboFont2);
			textY += lineHeight;
		}
	}

	/* Footer with navigation hints and pagination */
	textY += 2;
	currentPage = (etman.currentMenu.pageOffset / ETMAN_ITEMS_PER_PAGE) + 1;
	totalPages = ((etman.currentMenu.totalItems - 1) / ETMAN_ITEMS_PER_PAGE) + 1;

	if (totalPages > 1)
	{
		/* Show pagination with back/close depending on depth */
		if (etman.navStack.depth > 0)
		{
			Com_sprintf(itemText, sizeof(itemText), "^30^7=more (%d/%d)  ^3BKSP^7=back", currentPage, totalPages);
		}
		else
		{
			Com_sprintf(itemText, sizeof(itemText), "^30^7=more (%d/%d)  ^3BKSP^7=close", currentPage, totalPages);
		}
	}
	else if (etman.navStack.depth > 0)
	{
		Q_strncpyz(itemText, "^3BKSP^7=back", sizeof(itemText));
	}
	else
	{
		Q_strncpyz(itemText, "^3BKSP^7=close", sizeof(itemText));
	}

	CG_Text_Paint_Ext(x + padding, textY + 12, 0.15f, 0.15f, colorWhite, itemText, 0, 0, 0, &cgs.media.limboFont2);
}

/**
 * Draw the menu HUD - VSAY STYLE (matches native quickmessage look)
 * Default style - use cg_soundMenuStyle 1 to enable
 * Position: left side at y=100, same as wm_quickmessage.menu
 */
static void ETMan_DrawMenu_Vsay(void)
{
	float   x, y, w, h;
	float   lineHeight   = 12;
	float   titleHeight  = 14;
	int     i;
	vec4_t  bgColor      = { 0.0f, 0.0f, 0.0f, 0.75f };       /* Match vsay: backcolor 0 0 0 .75 */
	vec4_t  borderColor  = { 0.5f, 0.5f, 0.5f, 0.5f };        /* Match vsay: bordercolor .5 .5 .5 .5 */
	vec4_t  titleBgColor = { 0.16f, 0.2f, 0.17f, 0.8f };      /* Match vsay: backcolor .16 .2 .17 .8 */
	vec4_t  titleFgColor = { 0.6f, 0.6f, 0.6f, 1.0f };        /* Match vsay: forecolor .6 .6 .6 1 */
	vec4_t  itemColor    = { 0.6f, 0.6f, 0.6f, 1.0f };        /* Match vsay item color */
	float   textY;
	etmanMenuItem_t *item;
	int     currentPage, totalPages;
	char    titleText[64];
	char    itemText[64];
	int     itemCount;

	/* Position matches wm_quickmessage: origin 10,10 + rect starts at y=19 within that
	 * So effective position is x=10, y=100+10+19 = 129 for the box */
	x = 10;
	y = 100 + 10 + 19;  /* Match vsay menu position */
	w = 204;            /* Match vsay: rect 0 19 204 136 */

	/* Calculate item count for height */
	itemCount = etman.menuDataLoaded ? etman.currentMenu.itemCount : 1;
	if (itemCount == 0) itemCount = 1;

	/* Height: title bar + items + footer */
	h = titleHeight + 4 + (lineHeight * itemCount) + lineHeight + 8;

	/* Draw main background */
	CG_FillRect(x, y, w, h, bgColor);

	/* Draw border */
	CG_DrawRect_FixedBorder(x, y, w, h, 1, borderColor);

	/* Draw title bar background */
	CG_FillRect(x + 2, y + 2, w - 4, titleHeight, titleBgColor);

	/* Title text */
	if (!etman.menuDataLoaded)
	{
		Q_strncpyz(titleText, "SOUNDS", sizeof(titleText));
	}
	else if (etman.navStack.depth > 0)
	{
		Com_sprintf(titleText, sizeof(titleText), "%s",
		            etman.currentMenu.name[0] ? etman.currentMenu.name : "SOUNDS");
	}
	else
	{
		Q_strncpyz(titleText, "SOUNDS", sizeof(titleText));
	}

	/* Draw title - match vsay style: textscale .19, textalignx 3, textaligny 10 */
	CG_Text_Paint_Ext(x + 5, y + 2 + 10, 0.19f, 0.19f, titleFgColor, titleText, 0, 0, 0, &cgs.media.limboFont1);

	textY = y + titleHeight + 6;

	if (!etman.menuDataLoaded)
	{
		/* Loading state */
		CG_Text_Paint_Ext(x + 6, textY + 8, 0.2f, 0.2f, itemColor, "Loading...", 0, 0, 0, &cgs.media.limboFont2);
		return;
	}

	if (etman.currentMenu.itemCount == 0)
	{
		CG_Text_Paint_Ext(x + 6, textY + 8, 0.2f, 0.2f, itemColor, "No items", 0, 0, 0, &cgs.media.limboFont2);
		textY += lineHeight;
	}
	else
	{
		/* Draw menu items - match vsay style: rect 6 $evalfloat(35 + (12*POS)) 128 10 */
		for (i = 0; i < etman.currentMenu.itemCount; i++)
		{
			item = &etman.currentMenu.items[i];

			if (item->itemType == ETMAN_ITEM_MENU)
			{
				/* Submenu indicator with > arrow */
				Com_sprintf(itemText, sizeof(itemText), "%d. %s >", item->position, item->name);
			}
			else
			{
				/* Sound item */
				Com_sprintf(itemText, sizeof(itemText), "%d. %s", item->position, item->name);
			}

			/* Draw item - match vsay: textscale .2, textaligny 8 */
			CG_Text_Paint_Ext(x + 6, textY + 8, 0.2f, 0.2f, itemColor, itemText, 0, 0, 0, &cgs.media.limboFont2);
			textY += lineHeight;
		}
	}

	/* Footer with navigation hints */
	textY += 4;
	currentPage = (etman.currentMenu.pageOffset / ETMAN_ITEMS_PER_PAGE) + 1;
	totalPages = ((etman.currentMenu.totalItems - 1) / ETMAN_ITEMS_PER_PAGE) + 1;

	if (totalPages > 1)
	{
		if (etman.navStack.depth > 0)
		{
			Com_sprintf(itemText, sizeof(itemText), "0. More (%d/%d)  Bksp. Back", currentPage, totalPages);
		}
		else
		{
			Com_sprintf(itemText, sizeof(itemText), "0. More (%d/%d)  Bksp. Close", currentPage, totalPages);
		}
	}
	else if (etman.navStack.depth > 0)
	{
		Q_strncpyz(itemText, "Bksp. Back", sizeof(itemText));
	}
	else
	{
		Q_strncpyz(itemText, "Bksp. Close", sizeof(itemText));
	}

	CG_Text_Paint_Ext(x + 6, textY + 8, 0.18f, 0.18f, itemColor, itemText, 0, 0, 0, &cgs.media.limboFont2);
}

/**
 * Draw the menu HUD - dispatches to appropriate style
 * cg_soundMenuStyle: 0 = classic (centered top), 1 = vsay style (default)
 */
static void ETMan_DrawMenu(void)
{
	char buf[8];
	int  style;

	trap_Cvar_VariableStringBuffer("cg_soundMenuStyle", buf, sizeof(buf));

	/* Default to vsay style (1) if cvar not set or empty */
	if (buf[0] == '\0')
	{
		style = 1;
	}
	else
	{
		style = atoi(buf);
	}

	if (style == 0)
	{
		ETMan_DrawMenu_Classic();
	}
	else
	{
		ETMan_DrawMenu_Vsay();
	}
}

/**
 * Draw the root menu (Server Sounds / User Sounds choice)
 * This is shown first when opening the sound menu, before loading any data.
 */
static void ETMan_DrawRootMenu(void)
{
	float   x, y, w, h;
	float   lineHeight   = 12;
	float   titleHeight  = 14;
	vec4_t  bgColor      = { 0.0f, 0.0f, 0.0f, 0.75f };
	vec4_t  borderColor  = { 0.5f, 0.5f, 0.5f, 0.5f };
	vec4_t  titleBgColor = { 0.16f, 0.2f, 0.17f, 0.8f };
	vec4_t  titleFgColor = { 0.6f, 0.6f, 0.6f, 1.0f };
	vec4_t  itemColor    = { 0.6f, 0.6f, 0.6f, 1.0f };
	float   textY;

	/* Position matches vsay style */
	x = 10;
	y = 100 + 10 + 19;
	w = 204;
	h = titleHeight + 4 + (lineHeight * 2) + lineHeight + 8;

	/* Draw main background */
	CG_FillRect(x, y, w, h, bgColor);
	CG_DrawRect_FixedBorder(x, y, w, h, 1, borderColor);

	/* Draw title bar background */
	CG_FillRect(x + 2, y + 2, w - 4, titleHeight, titleBgColor);

	/* Title */
	CG_Text_Paint_Ext(x + 5, y + 2 + 10, 0.19f, 0.19f, titleFgColor, "ETMAN SOUNDS", 0, 0, 0, &cgs.media.limboFont1);

	textY = y + titleHeight + 6;

	/* Option 1: Server Sounds */
	CG_Text_Paint_Ext(x + 6, textY + 8, 0.2f, 0.2f, itemColor, "1. Server Sounds", 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight;

	/* Option 2: User Sounds */
	CG_Text_Paint_Ext(x + 6, textY + 8, 0.2f, 0.2f, itemColor, "2. User Sounds", 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight;

	/* Footer */
	textY += 4;
	CG_Text_Paint_Ext(x + 6, textY + 8, 0.18f, 0.18f, itemColor, "Bksp. Close", 0, 0, 0, &cgs.media.limboFont2);
}

/**
 * Draw the user registration promo when user has no sounds.
 * Shows info about registering at etpanel.etman.dev for custom sounds.
 */
static void ETMan_DrawUserPromo(void)
{
	float   x, y, w, h;
	float   lineHeight   = 11;
	float   titleHeight  = 14;
	vec4_t  bgColor      = { 0.0f, 0.0f, 0.0f, 0.85f };
	vec4_t  borderColor  = { 0.5f, 0.5f, 0.5f, 0.5f };
	vec4_t  titleBgColor = { 0.16f, 0.2f, 0.17f, 0.8f };
	vec4_t  titleFgColor = { 0.6f, 0.6f, 0.6f, 1.0f };
	vec4_t  textColor    = { 0.7f, 0.7f, 0.7f, 1.0f };
	vec4_t  highlightColor = { 1.0f, 0.8f, 0.2f, 1.0f };
	vec4_t  cyanColor    = { 0.4f, 0.9f, 1.0f, 1.0f };
	float   textY;

	x = 10;
	y = 100 + 10 + 19;
	w = 260;
	h = titleHeight + 4 + (lineHeight * 9) + 16;

	/* Draw background */
	CG_FillRect(x, y, w, h, bgColor);
	CG_DrawRect_FixedBorder(x, y, w, h, 1, borderColor);

	/* Title bar */
	CG_FillRect(x + 2, y + 2, w - 4, titleHeight, titleBgColor);
	CG_Text_Paint_Ext(x + 5, y + 2 + 10, 0.19f, 0.19f, titleFgColor, "USER SOUNDS", 0, 0, 0, &cgs.media.limboFont1);

	textY = y + titleHeight + 8;

	/* Promo text */
	CG_Text_Paint_Ext(x + 6, textY + 8, 0.17f, 0.17f, highlightColor, "No sounds yet? Register to unlock:", 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight + 4;

	CG_Text_Paint_Ext(x + 10, textY + 8, 0.16f, 0.16f, cyanColor, "* Upload your own MP3 sound clips", 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight;

	CG_Text_Paint_Ext(x + 10, textY + 8, 0.16f, 0.16f, cyanColor, "* Create custom sound menus", 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight;

	CG_Text_Paint_Ext(x + 10, textY + 8, 0.16f, 0.16f, cyanColor, "* Share sounds with other players", 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight;

	CG_Text_Paint_Ext(x + 10, textY + 8, 0.16f, 0.16f, cyanColor, "* Quick commands: type @alias in chat", 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight;

	CG_Text_Paint_Ext(x + 10, textY + 8, 0.16f, 0.16f, cyanColor, "* Organize sounds into playlists", 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight + 6;

	/* Register now option */
	CG_Text_Paint_Ext(x + 6, textY + 8, 0.18f, 0.18f, highlightColor, "1. Register Now", 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight + 4;

	/* Footer */
	CG_Text_Paint_Ext(x + 6, textY + 8, 0.16f, 0.16f, textColor, "Bksp. Close", 0, 0, 0, &cgs.media.limboFont2);
}

/**
 * Draw a header info box above the server sounds menu explaining quick commands.
 * Called from the menu drawing functions when in server sounds view.
 */
static void ETMan_DrawServerSoundsHeader(void)
{
	float   x, y, w, h;
	float   lineHeight = 10;
	vec4_t  bgColor    = { 0.1f, 0.15f, 0.2f, 0.9f };
	vec4_t  borderColor = { 0.3f, 0.5f, 0.7f, 0.8f };
	vec4_t  textColor  = { 0.8f, 0.9f, 1.0f, 1.0f };
	vec4_t  tipColor   = { 1.0f, 0.9f, 0.5f, 1.0f };
	char    prefixBuf[8];
	float   textY;

	/* Get user's quick command prefix (default @) */
	trap_Cvar_VariableStringBuffer("etman_quickprefix", prefixBuf, sizeof(prefixBuf));
	if (prefixBuf[0] == '\0')
	{
		Q_strncpyz(prefixBuf, "@", sizeof(prefixBuf));
	}

	/* Position above the main menu - menu starts at y=129, so put tip above that */
	x = 10;
	y = 100;  /* Position tip box starting at y=100, ends before menu at y=129 */
	w = 220;
	h = lineHeight * 2 + 6;  /* Smaller height to fit above menu */

	/* Draw background */
	CG_FillRect(x, y, w, h, bgColor);
	CG_DrawRect_FixedBorder(x, y, w, h, 1, borderColor);

	textY = y + 2;

	/* Quick command tip */
	CG_Text_Paint_Ext(x + 4, textY + 8, 0.14f, 0.14f, tipColor, "TIP: Quick play sounds in chat!", 0, 0, 0, &cgs.media.limboFont2);
	textY += lineHeight;

	CG_Text_Paint_Ext(x + 4, textY + 8, 0.13f, 0.13f, textColor,
	                  va("Type %s<alias> (e.g. %slol) to play", prefixBuf, prefixBuf),
	                  0, 0, 0, &cgs.media.limboFont2);
}

/**
 * Console command: soundmenu
 * Toggles the sound menu on/off
 */
void CG_SoundMenu_f(void)
{
	ETMan_ToggleMenu();
}

/**
 * Console command: +soundmenu
 * Opens the sound menu (for hold-to-use binds)
 */
void CG_SoundMenuDown_f(void)
{
	if (!etman.initialized)
	{
		return;
	}

	if (!etman.menuActive)
	{
		ETMan_OpenMenu();
	}
}

/**
 * Console command: -soundmenu
 * Called when key is released (does nothing for now)
 */
void CG_SoundMenuUp_f(void)
{
	/* Could close menu on key release if desired */
}

/**
 * Console command: soundmenu_server
 * Opens the server-wide sound menu (same for all players)
 */
void CG_SoundMenuServer_f(void)
{
	if (!etman.initialized)
	{
		return;
	}

	if (etman.menuActive)
	{
		ETMan_CloseMenu();
	}
	else
	{
		ETMan_OpenServerMenu();
	}
}

/**
 * Console command: register
 * Opens the ETMan registration menu directly
 * Works from console: /register
 */
void CG_Register_f(void)
{
	// Set cvar flag and open ingame UI - ui_main.c will check and open etman_register
	trap_Cvar_Set("etman_openregister", "1");
	trap_UI_Popup(UIMENU_INGAME);
	CG_Printf("^3ETMan: Opening registration menu...\n");
}

/*
 * ============================================================================
 * Hierarchical Menu Navigation Implementation
 * ============================================================================
 */

/**
 * Request menu data for a specific menu ID and page
 * Uses the current menu type (personal or server) from etman.currentMenuType
 */
static void ETMan_RequestMenuPage(int menuId, int pageOffset)
{
	char     guid[ETMAN_GUID_LEN + 1];
	uint8_t  packet[64];
	int      offset = 0;
	uint32_t clientId;
	uint32_t menuIdNet;
	uint16_t pageOffsetNet;

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: [type:1][clientId:4][guid:32][menuId:4][pageOffset:2][menuType:1] */
	packet[offset++] = VOICE_CMD_MENU_NAVIGATE;

	clientId = htonl((uint32_t)cg.clientNum);
	memcpy(packet + offset, &clientId, 4);
	offset += 4;

	memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	menuIdNet = htonl((uint32_t)menuId);
	memcpy(packet + offset, &menuIdNet, 4);
	offset += 4;

	pageOffsetNet = htons((uint16_t)pageOffset);
	memcpy(packet + offset, &pageOffsetNet, 2);
	offset += 2;

	/* Add menu type byte: 0 = personal, 1 = server */
	packet[offset++] = (uint8_t)etman.currentMenuType;

	ETMan_SendPacket(packet, offset);
	etman.menuRequestTime = cg.time;
}

/**
 * Navigate to a specific menu
 */
void ETMan_NavigateToMenu(int menuId, int pageOffset)
{
	/* Push current state onto navigation stack before navigating */
	if (etman.navStack.depth < ETMAN_MAX_MENU_DEPTH - 1 && etman.currentMenu.menuId != menuId)
	{
		etman.navStack.stack[etman.navStack.depth].menuId = etman.currentMenu.menuId;
		etman.navStack.stack[etman.navStack.depth].pageOffset = etman.currentMenu.pageOffset;
		Q_strncpyz(etman.navStack.stack[etman.navStack.depth].name,
		           etman.currentMenu.name, ETMAN_MAX_NAME_LEN + 1);
		etman.navStack.depth++;
	}

	/* Request the new menu data */
	ETMan_RequestMenuPage(menuId, pageOffset);
}

/**
 * Navigate back to parent menu or close
 */
qboolean ETMan_NavigateBack(void)
{
	int parentMenuId;
	int parentOffset;

	/* If we're viewing user promo (no sounds), just close */
	if (etman.rootState == ETMAN_ROOT_USER && !etman.userHasSounds && etman.menuDataLoaded)
	{
		ETMan_CloseMenu();
		return qfalse;
	}

	/* If nav stack is empty, close the menu */
	if (etman.navStack.depth <= 0)
	{
		ETMan_CloseMenu();
		return qfalse;
	}

	/* Pop from navigation stack */
	etman.navStack.depth--;
	parentMenuId = etman.navStack.stack[etman.navStack.depth].menuId;
	parentOffset = etman.navStack.stack[etman.navStack.depth].pageOffset;

	/* Request parent menu data */
	ETMan_RequestMenuPage(parentMenuId, parentOffset);
	return qtrue;
}

/**
 * Navigate to next page of current menu
 */
qboolean ETMan_NextPage(void)
{
	int nextOffset = etman.currentMenu.pageOffset + ETMAN_ITEMS_PER_PAGE;

	if (nextOffset >= etman.currentMenu.totalItems)
	{
		/* Wrap around to first page */
		nextOffset = 0;
	}

	ETMan_RequestMenuPage(etman.currentMenu.menuId, nextOffset);
	return qtrue;
}

/**
 * Play a sound by its position ID in user's library
 */
void ETMan_PlaySoundById(int positionId)
{
	char     guid[ETMAN_GUID_LEN + 1];
	uint8_t  packet[64];
	int      offset = 0;
	uint32_t clientId;
	uint16_t posNet;

	if (!ETMan_GetGuid(guid, sizeof(guid)))
	{
		return;
	}

	/* Build packet: [type:1][clientId:4][guid:32][position:2] */
	packet[offset++] = VOICE_CMD_SOUND_BY_ID;

	clientId = htonl((uint32_t)cg.clientNum);
	memcpy(packet + offset, &clientId, 4);
	offset += 4;

	memcpy(packet + offset, guid, ETMAN_GUID_LEN);
	offset += ETMAN_GUID_LEN;

	posNet = htons((uint16_t)positionId);
	memcpy(packet + offset, &posNet, 2);
	offset += 2;

	ETMan_SendPacket(packet, offset);
	CG_Printf("^3ETMan: Playing sound #%d...\n", positionId);
}

/**
 * Toggle sound ID input mode
 */
void ETMan_ToggleIdMode(void)
{
	etman.idModeActive = !etman.idModeActive;
	etman.idInputLen = 0;
	etman.idInputBuffer[0] = '\0';

	if (etman.idModeActive)
	{
		CG_Printf("^3ETMan: ID mode ON - type sound number and press Enter\n");
	}
	else
	{
		CG_Printf("^3ETMan: ID mode OFF\n");
	}
}

/**
 * Handle /etman playid <number>
 * Plays sound by database ID (shareable for public sounds)
 * Example: /etman playid 42
 * Bind example: bind F5 "etman playid 42"
 */
static void ETMan_CmdPlayId(void)
{
	char idStr[16];
	int soundId;

	if (trap_Argc() < 3)
	{
		CG_Printf("Usage: /etman playid <id>\n");
		CG_Printf("  Plays sound by its database ID\n");
		CG_Printf("  IDs are shown in /etman list output\n");
		CG_Printf("  Public sound IDs work for all players!\n");
		CG_Printf("  Example bind: ^3bind F5 \"etman playid 42\"\n");
		return;
	}

	trap_Argv(2, idStr, sizeof(idStr));
	soundId = atoi(idStr);

	if (soundId < 1)
	{
		CG_Printf("^1ETMan: Invalid sound ID. Must be 1 or higher.\n");
		return;
	}

	ETMan_PlaySoundById(soundId);
}

/**
 * Parse new hierarchical menu data format from server
 * Format: [menuId:4][totalItems:2][pageOffset:2][itemCount:1]
 *         for each item: [position:1][itemType:1][nameLen:1][name][dataLen:1][data]
 *         itemType 0 (sound): data = soundAlias
 *         itemType 1 (menu): data = nestedMenuId[4]
 */
static void ETMan_ParseHierarchicalMenuData(const uint8_t *data, int dataLen)
{
	int offset = 0;
	uint32_t menuIdNet;
	uint16_t totalItemsNet, pageOffsetNet;
	uint8_t itemCount;
	int i;
	etmanMenuItem_t *item;

	if (dataLen < 9)
	{
		CG_Printf("^1ETMan: Invalid menu data (too short)\n");
		return;
	}

	/* Parse header */
	memcpy(&menuIdNet, data + offset, 4);
	etman.currentMenu.menuId = ntohl(menuIdNet);
	offset += 4;

	memcpy(&totalItemsNet, data + offset, 2);
	etman.currentMenu.totalItems = ntohs(totalItemsNet);
	offset += 2;

	memcpy(&pageOffsetNet, data + offset, 2);
	etman.currentMenu.pageOffset = ntohs(pageOffsetNet);
	offset += 2;

	itemCount = data[offset++];
	if (itemCount > ETMAN_MAX_MENU_ITEMS)
	{
		itemCount = ETMAN_MAX_MENU_ITEMS;
	}
	etman.currentMenu.itemCount = itemCount;

	/* Parse items */
	for (i = 0; i < itemCount && offset < dataLen; i++)
	{
		item = &etman.currentMenu.items[i];
		Com_Memset(item, 0, sizeof(etmanMenuItem_t));

		if (offset + 3 > dataLen) break;

		item->position = data[offset++];
		item->itemType = data[offset++];

		uint8_t nameLen = data[offset++];
		if (offset + nameLen + 1 > dataLen) break;

		if (nameLen > ETMAN_MAX_NAME_LEN) nameLen = ETMAN_MAX_NAME_LEN;
		memcpy(item->name, data + offset, nameLen);
		item->name[nameLen] = '\0';
		offset += nameLen;

		uint8_t dataLen2 = data[offset++];
		if (offset + dataLen2 > dataLen) break;

		if (item->itemType == ETMAN_ITEM_SOUND)
		{
			/* Sound: data is the alias */
			if (dataLen2 > ETMAN_MAX_NAME_LEN) dataLen2 = ETMAN_MAX_NAME_LEN;
			memcpy(item->soundAlias, data + offset, dataLen2);
			item->soundAlias[dataLen2] = '\0';
		}
		else
		{
			/* Menu: data is the nested menu ID (4 bytes) */
			if (dataLen2 >= 4)
			{
				uint32_t nestedIdNet;
				memcpy(&nestedIdNet, data + offset, 4);
				item->nestedMenuId = ntohl(nestedIdNet);
			}
		}
		offset += dataLen2;
	}

	etman.menuDataLoaded = qtrue;

	/* Track if user has sounds (for promo display on user sounds menu) */
	if (etman.rootState == ETMAN_ROOT_USER && etman.currentMenu.menuId == 0)
	{
		etman.userHasSounds = (etman.currentMenu.totalItems > 0);
	}

	CG_Printf("^2ETMan: Loaded menu (id=%d, items=%d/%d, page=%d)\n",
	          etman.currentMenu.menuId, etman.currentMenu.itemCount,
	          etman.currentMenu.totalItems, etman.currentMenu.pageOffset / ETMAN_ITEMS_PER_PAGE + 1);
}

/**
 * Check if a key should be blocked from executing binds.
 * Called from CG_CheckExecKey BEFORE engine processes key binds.
 * This is how we prevent weapon switching when pressing number keys.
 */
qboolean ETMan_CheckExecKey(int key)
{
	if (!etman.menuActive)
	{
		return qfalse;
	}

	/* Block all keys when sound menu is open */
	/* Number keys 0-9 */
	if (key >= '0' && key <= '9')
	{
		return qtrue;
	}

	/* Escape and backspace */
	if (key == K_ESCAPE || key == K_BACKSPACE)
	{
		return qtrue;
	}

	/* Block all other printable keys to prevent accidental actions */
	if (key >= 32 && key <= 126)
	{
		return qtrue;
	}

	return qfalse;
}

/**
 * Key handling for sound menu (called from CG_KeyEvent when CGAME_EVENT_SOUNDMENU)
 * This properly intercepts keys so weapon binds don't fire
 */
void ETMan_SoundMenu_KeyHandling(int key, qboolean down)
{
	if (!etman.menuActive)
	{
		return;
	}

	/* Only process key DOWN events */
	if (!down)
	{
		return;
	}

	/* Ignore weird high key values (Unicode/extended chars like 1074) */
	if (key > 512)
	{
		return;
	}

	/* Escape - always close menu immediately */
	if (key == K_ESCAPE)
	{
		ETMan_CloseMenu();
		return;
	}

	/* Backspace - go back or close */
	if (key == K_BACKSPACE)
	{
		ETMan_NavigateBack();
		return;
	}

	/* Number keys 0-9 using ASCII codes (48-57) */
	if (key >= '0' && key <= '9')
	{
		int num = key - '0';
		ETMan_MenuKeyEvent(num);
		return;
	}

	/* Any other valid key - close menu */
	ETMan_CloseMenu();
}

#endif /* FEATURE_VOICE */
