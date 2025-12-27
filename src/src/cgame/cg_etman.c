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

} etman;

/*
 * Forward declarations
 */
static void ETMan_SendPacket(uint8_t *data, int len);
static void ETMan_ShowHelp(void);

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
 */
static void ETMan_CmdShare(void)
{
	/* TODO: Implement in Phase 6 */
	CG_Printf("^3ETMan: Share feature coming soon!\n");
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
	CG_Printf("^7  /etman sharesnd <name> <player> ^5- Share with player (coming soon)\n");
	CG_Printf("\n^3Sound Limits: ^7100 sounds, 5MB per file, 30 sec max duration\n");
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
	else if (Q_stricmp(subcmd, "sharesnd") == 0 || Q_stricmp(subcmd, "share") == 0)
	{
		ETMan_CmdShare();
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

	/* TODO: Draw share request prompt if active */
	if (etman.hasShareRequest)
	{
		/* Draw F1/F2 prompt */
	}
}

#endif /* FEATURE_VOICE */
