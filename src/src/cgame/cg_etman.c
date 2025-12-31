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
	qboolean      menuActive;          // Menu HUD visible
	qboolean      menuDataLoaded;      // Have we received menu data from server
	int           menuRequestTime;     // When we last requested menus
	int           currentMenuLevel;    // 0 = root menu, 1+ = submenu
	int           selectedMenu;        // Which menu is selected (1-9)
	int           menuCount;           // Number of menus
	etmanMenu_t   menus[ETMAN_MAX_MENUS];

} etman;

/*
 * Forward declarations
 */
static void ETMan_SendPacket(uint8_t *data, int len);
static void ETMan_ShowHelp(void);
static qboolean ETMan_GetGuid(char *outGuid, int outLen);
static void ETMan_ParseMenuData(const uint8_t *data, int dataLen);
static void ETMan_PlayMenuSound(const char *soundAlias);
static void ETMan_DrawMenu(void);

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
		/* Registration code response - display prominently */
		CG_Printf("\n^2========================================\n");
		CG_Printf("^3%s\n", message);
		CG_Printf("^2========================================\n\n");
		break;

	case VOICE_RESP_MENU_DATA:
		/* Binary menu data from server */
		ETMan_ParseMenuData(data + 1, dataLen - 1);
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
	int i;
	static int lastKeyTime[10] = {0};  /* Debounce for keys 0-9 */

	if (!etman.initialized)
	{
		return;
	}

	/* Handle menu key input */
	if (etman.menuActive)
	{
		/* Check ESC key */
		if (trap_Key_IsDown(K_ESCAPE))
		{
			if (cg.time - lastKeyTime[0] > 200)
			{
				lastKeyTime[0] = cg.time;
				if (etman.currentMenuLevel > 0)
				{
					etman.currentMenuLevel = 0;
					etman.selectedMenu = 0;
				}
				else
				{
					etman.menuActive = qfalse;
				}
			}
		}

		/* Check number keys 1-9 */
		for (i = 1; i <= 9; i++)
		{
			if (trap_Key_IsDown('0' + i))
			{
				if (cg.time - lastKeyTime[i] > 300)  /* 300ms debounce */
				{
					lastKeyTime[i] = cg.time;
					CG_Printf("^3ETMan: Key %d pressed\n", i);
					ETMan_MenuKeyEvent(i);
				}
			}
		}

		/* Check 0 key for back */
		if (trap_Key_IsDown('0'))
		{
			if (cg.time - lastKeyTime[0] > 300)
			{
				lastKeyTime[0] = cg.time;
				CG_Printf("^3ETMan: Key 0 pressed (back)\n");
				ETMan_MenuKeyEvent(0);
			}
		}
	}

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

	/* Draw sound menu if active */
	if (etman.menuActive)
	{
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
		/* Close menu */
		CG_Printf("^3ETMan: Closing menu\n");
		etman.menuActive       = qfalse;
		etman.currentMenuLevel = 0;
		etman.selectedMenu     = 0;
	}
	else
	{
		/* Open menu */
		CG_Printf("^3ETMan: Opening menu (menuCount=%d, dataLoaded=%d)\n", etman.menuCount, etman.menuDataLoaded);
		etman.menuActive       = qtrue;
		etman.currentMenuLevel = 0;
		etman.selectedMenu     = 0;

		/* Request fresh menu data if we haven't loaded or it's been a while */
		if (!etman.menuDataLoaded || (cg.time - etman.menuRequestTime > 60000))
		{
			ETMan_RequestMenus();
		}
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
 * Handle key event while menu is active
 * @param key - integer 0-9 representing the key pressed
 */
qboolean ETMan_MenuKeyEvent(int key)
{
	int selection;
	int i;
	etmanMenu_t *menu;

	if (!etman.menuActive)
	{
		return qfalse;
	}

	/* 0 goes back or closes menu */
	if (key == 0)
	{
		if (etman.currentMenuLevel > 0)
		{
			/* Go back to root menu */
			etman.currentMenuLevel = 0;
			etman.selectedMenu     = 0;
		}
		else
		{
			/* Close menu entirely */
			etman.menuActive = qfalse;
		}
		return qtrue;
	}

	/* Number keys 1-9 */
	if (key >= 1 && key <= 9)
	{
		selection = key;

		if (etman.currentMenuLevel == 0)
		{
			/* Root menu - select a submenu */
			for (i = 0; i < etman.menuCount; i++)
			{
				if (etman.menus[i].position == selection)
				{
					if (etman.menus[i].itemCount > 0)
					{
						etman.selectedMenu     = i;
						etman.currentMenuLevel = 1;
					}
					else
					{
						CG_Printf("^3ETMan: Menu '%s' is empty\n", etman.menus[i].name);
					}
					return qtrue;
				}
			}
		}
		else
		{
			/* Submenu - play a sound */
			menu = &etman.menus[etman.selectedMenu];
			CG_Printf("^3ETMan: In submenu, looking for position %d (itemCount=%d)\n", selection, menu->itemCount);
			for (i = 0; i < menu->itemCount; i++)
			{
				CG_Printf("^3ETMan: Item %d position=%d alias='%s'\n", i, menu->items[i].position, menu->items[i].soundAlias);
				if (menu->items[i].position == selection)
				{
					/* Play this sound */
					CG_Printf("^2ETMan: Playing sound '%s'\n", menu->items[i].soundAlias);
					ETMan_PlayMenuSound(menu->items[i].soundAlias);
					etman.menuActive = qfalse;
					return qtrue;
				}
			}
			CG_Printf("^1ETMan: No item found at position %d\n", selection);
		}
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

	clientId = htonl(0);
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
 * Draw the menu HUD
 */
static void ETMan_DrawMenu(void)
{
	float   x, y, w, h;
	float   lineHeight = 18;
	float   padding    = 8;
	int     i;
	vec4_t  bgColor    = { 0.0f, 0.0f, 0.0f, 0.85f };
	vec4_t  titleColor = { 1.0f, 0.8f, 0.2f, 1.0f };
	float   textY;
	etmanMenu_t *menu;

	/* Fixed position - center of screen */
	w = 220;
	x = (640 - w) / 2;  /* 640 is the virtual width */
	y = 200;

	/* Calculate height based on content */
	if (!etman.menuDataLoaded)
	{
		h = padding * 2 + lineHeight * 2;
	}
	else if (etman.currentMenuLevel == 0)
	{
		h = padding * 2 + lineHeight * (2 + (etman.menuCount > 0 ? etman.menuCount : 1));
	}
	else
	{
		menu = &etman.menus[etman.selectedMenu];
		h = padding * 2 + lineHeight * (2 + menu->itemCount);
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
	}
	else if (etman.currentMenuLevel == 0)
	{
		/* Root menu - show list of menus */
		CG_Text_Paint_Ext(x + padding, textY + 12, 0.22f, 0.22f, titleColor, "Sound Menu", 0, 0, 0, &cgs.media.limboFont2);
		textY += lineHeight;

		if (etman.menuCount == 0)
		{
			CG_Text_Paint_Ext(x + padding, textY + 12, 0.18f, 0.18f, colorWhite, "No menus configured", 0, 0, 0, &cgs.media.limboFont2);
			textY += lineHeight;
		}
		else
		{
			for (i = 0; i < etman.menuCount; i++)
			{
				CG_Text_Paint_Ext(x + padding, textY + 12, 0.18f, 0.18f, colorWhite,
					va("^3%d. ^7%s", etman.menus[i].position, etman.menus[i].name),
					0, 0, 0, &cgs.media.limboFont2);
				textY += lineHeight;
			}
		}

		CG_Text_Paint_Ext(x + padding, textY + 12, 0.15f, 0.15f, colorWhite, "^3ESC^7 to close", 0, 0, 0, &cgs.media.limboFont2);
	}
	else
	{
		/* Submenu - show items */
		menu = &etman.menus[etman.selectedMenu];

		CG_Text_Paint_Ext(x + padding, textY + 12, 0.22f, 0.22f, titleColor, menu->name, 0, 0, 0, &cgs.media.limboFont2);
		textY += lineHeight;

		for (i = 0; i < menu->itemCount; i++)
		{
			CG_Text_Paint_Ext(x + padding, textY + 12, 0.18f, 0.18f, colorWhite,
				va("^3%d. ^7%s", menu->items[i].position, menu->items[i].name),
				0, 0, 0, &cgs.media.limboFont2);
			textY += lineHeight;
		}

		CG_Text_Paint_Ext(x + padding, textY + 12, 0.15f, 0.15f, colorWhite, "^30^7=back ^3ESC^7=close", 0, 0, 0, &cgs.media.limboFont2);
	}
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
		etman.menuActive       = qtrue;
		etman.currentMenuLevel = 0;
		etman.selectedMenu     = 0;

		/* Request fresh menu data if we haven't loaded or it's been a while */
		if (!etman.menuDataLoaded || (cg.time - etman.menuRequestTime > 60000))
		{
			ETMan_RequestMenus();
		}
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

#endif /* FEATURE_VOICE */
