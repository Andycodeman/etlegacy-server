/*
 * ET:Legacy - ETMan Admin Commands Module
 * Copyright (C) 2024 ETMan
 *
 * UDP communication with etman-server for !commands.
 * Non-blocking UDP socket for sending admin commands and receiving responses.
 */

#include "g_etman.h"

#ifndef _WIN32
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <errno.h>
#endif

// CVARs
vmCvar_t etman_enabled;
vmCvar_t etman_port;

// UDP socket for communication with etman-server
static int etman_socket = -1;
static struct sockaddr_in etman_server_addr;
static qboolean etman_initialized = qfalse;

// Packet buffer
#define ETMAN_MAX_PACKET 2048
static char etman_packet[ETMAN_MAX_PACKET];

// Quick command pending state (for async response handling)
static qboolean etman_pending_quick[MAX_CLIENTS];
static char     etman_pending_chat[MAX_CLIENTS][MAX_SAY_TEXT];
static int      etman_pending_mode[MAX_CLIENTS];

/*
 * Packet structures (must match etman-server/admin/admin.h)
 */
#pragma pack(push, 1)

typedef struct {
	uint8_t  type;                          /* PKT_ADMIN_CMD */
	uint8_t  clientSlot;                    /* 0-63 */
	char     guid[ADMIN_GUID_LEN + 1];      /* Player GUID (32 chars + null) */
	char     name[ADMIN_MAX_NAME_LEN];      /* Player name */
	char     command[ADMIN_MAX_CMD_LEN];    /* "kick eth" or "rotate" */
} AdminCmdPacket;

typedef struct {
	uint8_t  type;                          /* PKT_ADMIN_RESP */
	uint8_t  clientSlot;                    /* Who to send message to (255 = all) */
	char     message[ADMIN_MAX_RESPONSE_LEN]; /* Response text */
} AdminRespPacket;

typedef struct {
	uint8_t  type;                          /* PKT_ADMIN_ACTION */
	uint8_t  action;                        /* ADMIN_ACTION_* */
	uint8_t  targetSlot;                    /* Target player (if applicable) */
	char     data[ADMIN_MAX_ARGS_LEN];      /* Action-specific data */
} AdminActionPacket;

typedef struct {
	uint8_t  type;                          /* PKT_PLAYER_UPDATE */
	uint8_t  slot;                          /* Player slot */
	uint8_t  connected;                     /* 1 = connect, 0 = disconnect */
	char     guid[ADMIN_GUID_LEN + 1];      /* Player GUID (32 chars + null) */
	char     name[ADMIN_MAX_NAME_LEN];      /* Player name */
	uint8_t  team;                          /* Current team */
} PlayerUpdatePacket;

#pragma pack(pop)


/**
 * @brief Initialize the ETMan admin system
 */
void G_ETMan_Init(void)
{
#ifndef _WIN32
	int flags;
	int port;

	// Register CVARs
	trap_Cvar_Register(&etman_enabled, "etman_admin_enabled", "1", CVAR_ARCHIVE);
	trap_Cvar_Register(&etman_port, "etman_port", "27961", CVAR_ARCHIVE);

	if (!etman_enabled.integer)
	{
		G_Printf("[ETMan] Admin commands disabled\n");
		return;
	}

	port = etman_port.integer;

	// Create UDP socket
	etman_socket = socket(AF_INET, SOCK_DGRAM, 0);
	if (etman_socket < 0)
	{
		G_Printf("[ETMan] Failed to create UDP socket: %s\n", strerror(errno));
		return;
	}

	// Set non-blocking
	flags = fcntl(etman_socket, F_GETFL, 0);
	if (flags != -1)
	{
		fcntl(etman_socket, F_SETFL, flags | O_NONBLOCK);
	}

	// Setup server address (localhost:27961)
	memset(&etman_server_addr, 0, sizeof(etman_server_addr));
	etman_server_addr.sin_family = AF_INET;
	etman_server_addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	etman_server_addr.sin_port = htons(port);

	etman_initialized = qtrue;
	G_Printf("[ETMan] Admin commands enabled - connecting to localhost:%d\n", port);
#else
	G_Printf("[ETMan] Admin commands not supported on Windows\n");
#endif
}

/**
 * @brief Shutdown the ETMan admin system
 */
void G_ETMan_Shutdown(void)
{
#ifndef _WIN32
	if (etman_socket >= 0)
	{
		close(etman_socket);
		etman_socket = -1;
	}
	etman_initialized = qfalse;
	G_Printf("[ETMan] Admin system shutdown\n");
#endif
}

/**
 * @brief Send a packet to etman-server
 */
static void ETMan_SendPacket(const void *data, int len)
{
#ifndef _WIN32
	if (!etman_initialized || etman_socket < 0)
	{
		return;
	}

	int sent = sendto(etman_socket, data, len, 0,
	                  (struct sockaddr *)&etman_server_addr,
	                  sizeof(etman_server_addr));

	if (sent < 0 && errno != EAGAIN && errno != EWOULDBLOCK)
	{
		G_Printf("[ETMan] Send error: %s\n", strerror(errno));
	}
#endif
}

/**
 * @brief Handle admin response from etman-server
 */
static void ETMan_HandleResponse(AdminRespPacket *resp)
{
	if (resp->clientSlot == 255)
	{
		// Broadcast to all players
		trap_SendServerCommand(-1, va("chat \"%s\"", resp->message));
	}
	else if (resp->clientSlot < MAX_CLIENTS)
	{
		// Send to specific player
		trap_SendServerCommand(resp->clientSlot, va("chat \"%s\"", resp->message));
	}
}

/**
 * @brief Handle admin action from etman-server
 */
static void ETMan_HandleAction(AdminActionPacket *action)
{
	gentity_t *target;
	int targetSlot = action->targetSlot;

	switch (action->action)
	{
	case ADMIN_ACTION_KICK:
		if (targetSlot < MAX_CLIENTS)
		{
			trap_DropClient(targetSlot, action->data, 0);
		}
		break;

	case ADMIN_ACTION_MUTE:
		if (targetSlot < MAX_CLIENTS)
		{
			target = &g_entities[targetSlot];
			if (target->client)
			{
				target->client->sess.muted = qtrue;
				trap_SendServerCommand(targetSlot, "print \"^1You have been muted.\n\"");
			}
		}
		break;

	case ADMIN_ACTION_UNMUTE:
		if (targetSlot < MAX_CLIENTS)
		{
			target = &g_entities[targetSlot];
			if (target->client)
			{
				target->client->sess.muted = qfalse;
				trap_SendServerCommand(targetSlot, "print \"^2You have been unmuted.\n\"");
			}
		}
		break;

	case ADMIN_ACTION_SLAP:
		if (targetSlot < MAX_CLIENTS)
		{
			target = &g_entities[targetSlot];
			if (target->client && target->health > 0)
			{
				int damage = atoi(action->data);
				if (damage <= 0) damage = 20;
				if (damage > 999) damage = 999;

				// Apply damage (use MOD_TELEFRAG for admin actions)
				G_Damage(target, NULL, NULL, NULL, NULL, damage, DAMAGE_NO_PROTECTION, MOD_TELEFRAG);

				// Apply knockback (throw them up)
				target->client->ps.velocity[2] += 300;
			}
		}
		break;

	case ADMIN_ACTION_GIB:
		if (targetSlot < MAX_CLIENTS)
		{
			target = &g_entities[targetSlot];
			if (target->client && target->health > 0)
			{
				// Kill with enough damage to gib (use MOD_TELEFRAG for admin actions)
				G_Damage(target, NULL, NULL, NULL, NULL, 10000, DAMAGE_NO_PROTECTION, MOD_TELEFRAG);
			}
		}
		break;

	case ADMIN_ACTION_PUT:
		if (targetSlot < MAX_CLIENTS)
		{
			target = &g_entities[targetSlot];
			if (target->client)
			{
				// SetTeam() expects team strings: "s"=spec, "r"=axis, "b"=allies
				// action->data should be one of these strings
				SetTeam(target, action->data, qtrue, -1, -1, qfalse);
			}
		}
		break;

	case ADMIN_ACTION_MAP:
		trap_SendConsoleCommand(EXEC_APPEND, va("map %s\n", action->data));
		break;

	case ADMIN_ACTION_RESTART:
		trap_SendConsoleCommand(EXEC_APPEND, "map_restart 0\n");
		break;

	case ADMIN_ACTION_RCON:
		trap_SendConsoleCommand(EXEC_APPEND, va("%s\n", action->data));
		break;

	case ADMIN_ACTION_CHAT:
		trap_SendServerCommand(-1, va("chat \"%s\"", action->data));
		break;

	case ADMIN_ACTION_CPRINT:
		if (targetSlot < MAX_CLIENTS)
		{
			trap_SendServerCommand(targetSlot, va("cp \"%s\"", action->data));
		}
		break;

	case ADMIN_ACTION_FLING:
		if (targetSlot < MAX_CLIENTS)
		{
			target = &g_entities[targetSlot];
			if (target->client && target->health > 0)
			{
				int strength = atoi(action->data);
				if (strength < 100) strength = 100;
				if (strength > 5000) strength = 5000;

				// Random horizontal direction + some vertical
				target->client->ps.velocity[0] = (rand() % (strength * 2)) - strength;
				target->client->ps.velocity[1] = (rand() % (strength * 2)) - strength;
				target->client->ps.velocity[2] = strength / 2 + (rand() % (strength / 2));
			}
		}
		break;

	case ADMIN_ACTION_UP:
		if (targetSlot < MAX_CLIENTS)
		{
			target = &g_entities[targetSlot];
			if (target->client && target->health > 0)
			{
				int strength = atoi(action->data);
				if (strength < 100) strength = 100;
				if (strength > 5000) strength = 5000;

				// Launch straight up
				target->client->ps.velocity[2] = strength;
			}
		}
		break;

	default:
		G_Printf("[ETMan] Unknown action type: %d\n", action->action);
		break;
	}
}

/**
 * @brief Frame processing - check for responses from etman-server
 */
void G_ETMan_Frame(void)
{
#ifndef _WIN32
	struct sockaddr_in from;
	socklen_t fromlen;
	int received;

	if (!etman_initialized || etman_socket < 0)
	{
		return;
	}

	// Process all pending packets (non-blocking)
	while (1)
	{
		fromlen = sizeof(from);
		received = recvfrom(etman_socket, etman_packet, sizeof(etman_packet) - 1, 0,
		                    (struct sockaddr *)&from, &fromlen);

		if (received <= 0)
		{
			break;  // No more packets or error
		}

		if (received < 1)
		{
			continue;  // Too short
		}

		uint8_t type = (uint8_t)etman_packet[0];

		switch (type)
		{
		case PKT_ADMIN_RESP:
			if (received >= sizeof(AdminRespPacket) - ADMIN_MAX_RESPONSE_LEN)
			{
				ETMan_HandleResponse((AdminRespPacket *)etman_packet);
			}
			break;

		case PKT_ADMIN_ACTION:
			if (received >= sizeof(AdminActionPacket) - ADMIN_MAX_ARGS_LEN)
			{
				ETMan_HandleAction((AdminActionPacket *)etman_packet);
			}
			break;

		case VOICE_RESP_QUICK_FOUND:
		{
			/* Quick command was found - play sound and optionally send chat text
			 * Payload: <slot:1><soundFileId:4><chatTextLen:1><chatText:N>
			 */
			if (received < 7)
			{
				break;  /* Too short */
			}

			uint8_t slot = (uint8_t)etman_packet[1];
			/* Skip soundFileId bytes 2-5 (sound is already playing server-side) */
			uint8_t chatTextLen = (uint8_t)etman_packet[6];

			if (slot >= MAX_CLIENTS || !etman_pending_quick[slot])
			{
				break;
			}

			etman_pending_quick[slot] = qfalse;

			G_Printf("[ETMan] Quick command found for slot %d, chatLen=%d\n", slot, chatTextLen);

			/* If there's chat text, send it as the player's chat */
			if (chatTextLen > 0 && received >= 7 + chatTextLen)
			{
				char chatText[QUICK_CMD_MAX_CHAT_TEXT + 1];
				int copyLen = (chatTextLen < QUICK_CMD_MAX_CHAT_TEXT) ? chatTextLen : QUICK_CMD_MAX_CHAT_TEXT;
				memcpy(chatText, &etman_packet[7], copyLen);
				chatText[copyLen] = '\0';

				gentity_t *ent = &g_entities[slot];
				if (ent->client)
				{
					G_Printf("[ETMan] Sending replacement chat: '%s'\n", chatText);
					G_Say(ent, NULL, etman_pending_mode[slot], chatText);
				}
			}
			/* If no chat text, sound plays but no chat is sent (silent mode) */
			break;
		}

		case VOICE_RESP_QUICK_NOTFOUND:
		{
			/* Quick command not found - send original chat through */
			if (received < 2)
			{
				break;
			}

			uint8_t slot = (uint8_t)etman_packet[1];

			if (slot >= MAX_CLIENTS || !etman_pending_quick[slot])
			{
				break;
			}

			etman_pending_quick[slot] = qfalse;

			G_Printf("[ETMan] Quick command not found for slot %d, sending original chat\n", slot);

			/* Send the original chat message */
			gentity_t *ent = &g_entities[slot];
			if (ent->client)
			{
				G_Say(ent, NULL, etman_pending_mode[slot], etman_pending_chat[slot]);
			}
			break;
		}

		default:
			G_Printf("[ETMan] Unknown packet type: 0x%02x\n", type);
			break;
		}
	}
#endif
}

/**
 * @brief Check if a chat message is an admin command
 * Returns qtrue if the message was handled as a command
 */
qboolean G_ETMan_CheckCommand(gentity_t *ent, const char *chatText)
{
#ifndef _WIN32
	AdminCmdPacket pkt;
	int clientNum;
	char userinfo[MAX_INFO_STRING];
	const char *guid;

	if (!etman_initialized || !ent || !ent->client)
	{
		return qfalse;
	}

	// Check if message starts with !
	if (!chatText || chatText[0] != '!')
	{
		return qfalse;
	}

	// Skip if just "!" with nothing after
	if (!chatText[1])
	{
		return qfalse;
	}

	clientNum = ent - g_entities;
	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return qfalse;
	}

	// Get player GUID
	trap_GetUserinfo(clientNum, userinfo, sizeof(userinfo));
	guid = Info_ValueForKey(userinfo, "cl_guid");

	// Build packet
	memset(&pkt, 0, sizeof(pkt));
	pkt.type = PKT_ADMIN_CMD;
	pkt.clientSlot = (uint8_t)clientNum;

	Q_strncpyz(pkt.guid, guid ? guid : "", sizeof(pkt.guid));
	Q_strncpyz(pkt.name, ent->client->pers.netname, sizeof(pkt.name));
	Q_strncpyz(pkt.command, chatText + 1, sizeof(pkt.command));  // Skip the !

	// Send to etman-server
	ETMan_SendPacket(&pkt, sizeof(pkt));

	G_Printf("[ETMan] Command from %s: %s\n", pkt.name, pkt.command);

	return qtrue;  // Command handled - suppress chat message
#else
	return qfalse;
#endif
}

/**
 * @brief Notify etman-server of player connect
 */
void G_ETMan_PlayerConnect(int clientNum, const char *guid, const char *name, int team)
{
#ifndef _WIN32
	PlayerUpdatePacket pkt;

	if (!etman_initialized)
	{
		return;
	}

	memset(&pkt, 0, sizeof(pkt));
	pkt.type = PKT_PLAYER_UPDATE;
	pkt.slot = (uint8_t)clientNum;
	pkt.connected = 1;
	Q_strncpyz(pkt.guid, guid ? guid : "", sizeof(pkt.guid));
	Q_strncpyz(pkt.name, name ? name : "", sizeof(pkt.name));
	pkt.team = (uint8_t)team;

	ETMan_SendPacket(&pkt, sizeof(pkt));
#endif
}

/**
 * @brief Notify etman-server of player disconnect
 */
void G_ETMan_PlayerDisconnect(int clientNum)
{
#ifndef _WIN32
	PlayerUpdatePacket pkt;

	if (!etman_initialized)
	{
		return;
	}

	memset(&pkt, 0, sizeof(pkt));
	pkt.type = PKT_PLAYER_UPDATE;
	pkt.slot = (uint8_t)clientNum;
	pkt.connected = 0;

	ETMan_SendPacket(&pkt, sizeof(pkt));
#endif
}

/**
 * @brief Notify etman-server of player team change
 */
void G_ETMan_PlayerTeamChange(int clientNum, int team)
{
#ifndef _WIN32
	PlayerUpdatePacket pkt;
	gentity_t *ent;
	char userinfo[MAX_INFO_STRING];

	if (!etman_initialized)
	{
		return;
	}

	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return;
	}

	ent = &g_entities[clientNum];
	if (!ent->client)
	{
		return;
	}

	trap_GetUserinfo(clientNum, userinfo, sizeof(userinfo));

	memset(&pkt, 0, sizeof(pkt));
	pkt.type = PKT_PLAYER_UPDATE;
	pkt.slot = (uint8_t)clientNum;
	pkt.connected = 1;  // Team change = still connected
	Q_strncpyz(pkt.guid, Info_ValueForKey(userinfo, "cl_guid"), sizeof(pkt.guid));
	Q_strncpyz(pkt.name, ent->client->pers.netname, sizeof(pkt.name));
	pkt.team = (uint8_t)team;

	ETMan_SendPacket(&pkt, sizeof(pkt));
#endif
}

/**
 * @brief Check if a chat message might be a quick sound command
 *
 * This function checks if a chat message starts with a character that
 * could be a quick command prefix (like @, #, $, *, etc.).
 * If so, it sends the message to etman-server for lookup.
 *
 * The response is handled asynchronously in G_ETMan_Frame().
 *
 * @param ent Player entity
 * @param chatText The chat message
 * @param mode Chat mode (SAY_ALL, SAY_TEAM, etc.)
 * @return qtrue if message was sent for lookup (caller should NOT send chat)
 */
qboolean G_ETMan_CheckQuickCommand(gentity_t *ent, const char *chatText, int mode)
{
#ifndef _WIN32
	int clientNum;
	char userinfo[MAX_INFO_STRING];
	const char *guid;
	uint8_t packet[512];
	int pos = 0;

	if (!etman_initialized || !ent || !ent->client)
	{
		return qfalse;
	}

	/* Skip if empty */
	if (!chatText || !chatText[0])
	{
		return qfalse;
	}

	/* Quick check: must start with a potential prefix character
	 * Skip '!' - that's for admin commands */
	char c = chatText[0];
	if (!strchr(QUICK_PREFIX_CHARS, c))
	{
		return qfalse;
	}

	/* Need at least prefix + 1 character for alias */
	if (strlen(chatText) < 2)
	{
		return qfalse;
	}

	clientNum = ent - g_entities;
	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return qfalse;
	}

	/* Get player GUID */
	trap_GetUserinfo(clientNum, userinfo, sizeof(userinfo));
	guid = Info_ValueForKey(userinfo, "cl_guid");
	if (!guid || !guid[0])
	{
		return qfalse;
	}

	G_Printf("[ETMan] Checking quick command: '%s' from slot %d\n", chatText, clientNum);

	/* Build packet: <type:1><clientId:4><slot:1><guid:32><msgLen:1><message:N> */
	packet[pos++] = VOICE_CMD_QUICK_LOOKUP;

	/* Client ID (4 bytes, for etman-server packet routing) */
	uint32_t clientIdNet = htonl((uint32_t)clientNum);
	memcpy(&packet[pos], &clientIdNet, 4);
	pos += 4;

	/* Slot (1 byte) */
	packet[pos++] = (uint8_t)clientNum;

	/* GUID (32 bytes) */
	int guidLen = strlen(guid);
	if (guidLen > ADMIN_GUID_LEN) guidLen = ADMIN_GUID_LEN;
	memset(&packet[pos], 0, ADMIN_GUID_LEN);
	memcpy(&packet[pos], guid, guidLen);
	pos += ADMIN_GUID_LEN;

	/* Message length and content */
	int msgLen = strlen(chatText);
	if (msgLen > 127) msgLen = 127;
	packet[pos++] = (uint8_t)msgLen;
	memcpy(&packet[pos], chatText, msgLen);
	pos += msgLen;

	/* Send to etman-server */
	ETMan_SendPacket(packet, pos);

	/* Mark this client as having a pending quick command lookup */
	etman_pending_quick[clientNum] = qtrue;
	etman_pending_mode[clientNum] = mode;
	Q_strncpyz(etman_pending_chat[clientNum], chatText,
	           sizeof(etman_pending_chat[0]));

	G_Printf("[ETMan] Quick command lookup sent for slot %d\n", clientNum);

	return qtrue;  /* Message sent for lookup - caller should defer chat */
#else
	return qfalse;
#endif
}
