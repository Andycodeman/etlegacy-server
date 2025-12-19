/*
 * ET:Legacy - ETMan ETPanel Stats Module
 * Copyright (C) 2024 ETMan
 *
 * Non-blocking HTTP stats reporting to ETPanel API.
 * Uses fork() + curl for fire-and-forget HTTP POST.
 */

#include "g_etpanel.h"

#ifndef _WIN32
#include <unistd.h>
#include <sys/wait.h>
#include <signal.h>
#include <time.h>
#endif

// CVARs - use same names as existing Lua config for compatibility
vmCvar_t etpanel_enabled;
vmCvar_t etpanel_api_url;
vmCvar_t etpanel_api_key;
vmCvar_t etpanel_debug;

// Track connect times for playtime calculation
static int playerConnectTime[MAX_CLIENTS];

/**
 * @brief Initialize the ETPanel system
 */
void G_ETPanel_Init(void)
{
	int i;

	// Register CVARs - use same names as existing config
	trap_Cvar_Register(&etpanel_enabled, "etpanel_enabled", "1", CVAR_ARCHIVE);
	trap_Cvar_Register(&etpanel_api_url, "etpanel_api_url", "http://localhost:3000/api/stats", CVAR_ARCHIVE);
	trap_Cvar_Register(&etpanel_api_key, "etpanel_api_key", "", CVAR_ARCHIVE);
	trap_Cvar_Register(&etpanel_debug, "etpanel_debug", "0", CVAR_ARCHIVE);

	// Clear connect times
	for (i = 0; i < MAX_CLIENTS; i++)
	{
		playerConnectTime[i] = 0;
	}

	if (etpanel_enabled.integer)
	{
		G_Printf("[ETPanel] Stats reporting enabled - URL: %s\n", etpanel_api_url.string);
	}
	else
	{
		G_Printf("[ETPanel] Stats reporting disabled\n");
	}
}

/**
 * @brief Check if a client is a bot
 */
static qboolean ETPanel_IsBot(int clientNum)
{
	gentity_t *ent;

	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return qtrue;
	}

	ent = &g_entities[clientNum];
	if (!ent->client)
	{
		return qtrue;
	}

	return (ent->r.svFlags & SVF_BOT) ? qtrue : qfalse;
}

/**
 * @brief Get player GUID (returns "BOT_name" for bots)
 */
static const char *ETPanel_GetGuid(int clientNum)
{
	static char botGuid[64];
	gentity_t   *ent;

	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return "WORLD";
	}

	ent = &g_entities[clientNum];
	if (!ent->client)
	{
		return "UNKNOWN";
	}

	if (ent->r.svFlags & SVF_BOT)
	{
		Com_sprintf(botGuid, sizeof(botGuid), "BOT_%s", ent->client->pers.netname);
		return botGuid;
	}

	return ent->client->pers.cl_guid;
}

/**
 * @brief Get player name - tries netname first, falls back to userinfo
 */
static const char *ETPanel_GetName(int clientNum)
{
	gentity_t  *ent;
	const char *name;
	char       userinfo[MAX_INFO_STRING];

	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return "World";
	}

	ent = &g_entities[clientNum];
	if (!ent->client)
	{
		return "Unknown";
	}

	// Try netname first (set after ClientBegin)
	name = ent->client->pers.netname;
	if (name && name[0])
	{
		return name;
	}

	// Fall back to userinfo (available at ClientConnect)
	trap_GetUserinfo(clientNum, userinfo, sizeof(userinfo));
	name = Info_ValueForKey(userinfo, "name");
	if (name && name[0])
	{
		return name;
	}

	return "Unknown";
}

/**
 * @brief Get player team (1=Axis, 2=Allies, 3=Spectator)
 */
static int ETPanel_GetTeam(int clientNum)
{
	gentity_t *ent;

	if (clientNum < 0 || clientNum >= MAX_CLIENTS)
	{
		return 0;
	}

	ent = &g_entities[clientNum];
	if (!ent->client)
	{
		return 0;
	}

	return ent->client->sess.sessionTeam;
}

/**
 * @brief Escape a string for JSON
 * Handles quotes, backslashes, control characters, and ET color codes
 * Players can have weird characters in names - this ensures valid JSON
 */
static void ETPanel_EscapeJson(const char *in, char *out, int outSize)
{
	int          i = 0, j = 0;
	unsigned char c;

	while (in[i] && j < outSize - 6)  // Leave room for \uXXXX escape
	{
		c = (unsigned char)in[i];

		// Skip ET color codes (^X)
		if (c == '^' && in[i + 1])
		{
			i += 2;
			continue;
		}

		// Handle characters that need escaping in JSON
		switch (c)
		{
		case '"':
			out[j++] = '\\';
			out[j++] = '"';
			break;
		case '\\':
			out[j++] = '\\';
			out[j++] = '\\';
			break;
		case '\n':
			out[j++] = '\\';
			out[j++] = 'n';
			break;
		case '\r':
			out[j++] = '\\';
			out[j++] = 'r';
			break;
		case '\t':
			out[j++] = '\\';
			out[j++] = 't';
			break;
		case '\b':
			out[j++] = '\\';
			out[j++] = 'b';
			break;
		case '\f':
			out[j++] = '\\';
			out[j++] = 'f';
			break;
		default:
			// Skip control characters (0x00-0x1F) except those handled above
			if (c < 0x20)
			{
				// Skip these - they're invalid in JSON strings
			}
			// Skip high-bit characters (0x80-0xFF) that might not be valid UTF-8
			// This is conservative - drops extended ASCII but ensures valid JSON
			else if (c >= 0x80)
			{
				// Replace with underscore to preserve some visual indication
				out[j++] = '_';
			}
			else
			{
				// Normal printable ASCII
				out[j++] = c;
			}
			break;
		}
		i++;
	}
	out[j] = '\0';
}

/**
 * @brief Send stats event via non-blocking HTTP POST (fork + curl)
 * @param[in] endpoint The API endpoint path (e.g., "game/kill")
 * @param[in] json The JSON payload to send
 */
static void ETPanel_SendEvent(const char *endpoint, const char *json)
{
#ifndef _WIN32
	pid_t pid;
	char  fullUrl[512];

	if (!etpanel_enabled.integer)
	{
		return;
	}

	// Build full URL: base_url + "/" + endpoint
	Com_sprintf(fullUrl, sizeof(fullUrl), "%s/%s", etpanel_api_url.string, endpoint);

	if (etpanel_debug.integer)
	{
		G_Printf("[ETPanel] POST %s: %s\n", fullUrl, json);
	}

	// Reap any zombie child processes
	while (waitpid(-1, NULL, WNOHANG) > 0)
		;

	pid = fork();
	if (pid == 0)
	{
		// Child process - do the HTTP POST and exit
		char authHeader[256];
		char contentType[] = "Content-Type: application/json";

		// Build auth header if API key is set
		if (etpanel_api_key.string[0])
		{
			Com_sprintf(authHeader, sizeof(authHeader), "X-API-Key: %s", etpanel_api_key.string);
			execl("/usr/bin/curl", "curl",
			      "-s",                    // Silent
			      "-X", "POST",            // POST method
			      "-H", contentType,       // Content-Type header
			      "-H", authHeader,        // API key header
			      "-d", json,              // POST data
			      "--connect-timeout", "2", // 2 second connect timeout
			      "--max-time", "5",       // 5 second max time
			      fullUrl,                 // Full URL with endpoint
			      (char *)NULL);
		}
		else
		{
			execl("/usr/bin/curl", "curl",
			      "-s",
			      "-X", "POST",
			      "-H", contentType,
			      "-d", json,
			      "--connect-timeout", "2",
			      "--max-time", "5",
			      fullUrl,
			      (char *)NULL);
		}

		// If execl fails, exit
		_exit(1);
	}
	else if (pid < 0)
	{
		G_Printf("[ETPanel] Warning: fork() failed\n");
	}
	// Parent continues immediately - non-blocking
#else
	// Windows: not implemented (would need CreateProcess or similar)
	if (etpanel_debug.integer)
	{
		G_Printf("[ETPanel] Windows not supported, event: %s\n", json);
	}
#endif
}

/**
 * @brief Get current Unix timestamp in seconds
 */
static int ETPanel_GetTimestamp(void)
{
	return (int)time(NULL);
}

/**
 * @brief Player connected
 */
void G_ETPanel_PlayerConnect(int clientNum, qboolean firstTime, qboolean isBot)
{
	char json[1024];
	char nameEsc[MAX_NETNAME * 2];
	char guidEsc[128];

	if (!etpanel_enabled.integer)
	{
		return;
	}

	// Skip bots
	if (isBot || ETPanel_IsBot(clientNum))
	{
		return;
	}

	// Track connect time
	playerConnectTime[clientNum] = level.time;

	ETPanel_EscapeJson(ETPanel_GetName(clientNum), nameEsc, sizeof(nameEsc));
	ETPanel_EscapeJson(ETPanel_GetGuid(clientNum), guidEsc, sizeof(guidEsc));

	Com_sprintf(json, sizeof(json),
	            "{\"slot\":%d,\"name\":\"%s\",\"guid\":\"%s\",\"timestamp\":%d}",
	            clientNum,
	            nameEsc,
	            guidEsc,
	            ETPanel_GetTimestamp());

	ETPanel_SendEvent("game/player-connect", json);
}

/**
 * @brief Player fully entered the game
 */
void G_ETPanel_PlayerBegin(int clientNum)
{
	// Could send a "player_begin" event if needed
	// For now, connect event is sufficient
}

/**
 * @brief Player disconnected
 */
void G_ETPanel_PlayerDisconnect(int clientNum)
{
	char json[1024];
	char nameEsc[MAX_NETNAME * 2];
	char guidEsc[128];
	int  playtime;

	if (!etpanel_enabled.integer)
	{
		return;
	}

	// Skip bots
	if (ETPanel_IsBot(clientNum))
	{
		return;
	}

	// Calculate playtime
	playtime = 0;
	if (playerConnectTime[clientNum] > 0)
	{
		playtime = (level.time - playerConnectTime[clientNum]) / 1000; // Convert to seconds
	}
	playerConnectTime[clientNum] = 0;

	ETPanel_EscapeJson(ETPanel_GetName(clientNum), nameEsc, sizeof(nameEsc));
	ETPanel_EscapeJson(ETPanel_GetGuid(clientNum), guidEsc, sizeof(guidEsc));

	Com_sprintf(json, sizeof(json),
	            "{\"slot\":%d,\"name\":\"%s\",\"guid\":\"%s\",\"playtime\":%d,\"timestamp\":%d}",
	            clientNum,
	            nameEsc,
	            guidEsc,
	            playtime,
	            ETPanel_GetTimestamp());

	ETPanel_SendEvent("game/player-disconnect", json);
}

/**
 * @brief Kill event
 */
void G_ETPanel_Kill(int victim, int killer, int meansOfDeath)
{
	char       json[1024];
	char       killerNameEsc[MAX_NETNAME * 2];
	char       victimNameEsc[MAX_NETNAME * 2];
	char       killerGuidEsc[128];
	char       victimGuidEsc[128];
	qboolean   killerIsBot, victimIsBot;
	qboolean   isTeamKill;
	const char *weapon;
	int        timestamp;

	if (!etpanel_enabled.integer)
	{
		return;
	}

	killerIsBot = (killer < 0 || killer >= MAX_CLIENTS || killer == 1022) ? qtrue : ETPanel_IsBot(killer);
	victimIsBot = ETPanel_IsBot(victim);

	// Skip bot vs bot
	if (killerIsBot && victimIsBot)
	{
		return;
	}

	// Get weapon name from MOD
	weapon = GetMODTableData(meansOfDeath)->modName;
	timestamp = ETPanel_GetTimestamp();

	// Check for team kill
	isTeamKill = qfalse;
	if (killer >= 0 && killer < MAX_CLIENTS && killer != victim)
	{
		int killerTeam = ETPanel_GetTeam(killer);
		int victimTeam = ETPanel_GetTeam(victim);
		if (killerTeam == victimTeam && (killerTeam == TEAM_AXIS || killerTeam == TEAM_ALLIES))
		{
			isTeamKill = qtrue;
		}
	}

	// Escape strings
	if (killer >= 0 && killer < MAX_CLIENTS)
	{
		ETPanel_EscapeJson(ETPanel_GetName(killer), killerNameEsc, sizeof(killerNameEsc));
		ETPanel_EscapeJson(ETPanel_GetGuid(killer), killerGuidEsc, sizeof(killerGuidEsc));
	}
	else
	{
		Q_strncpyz(killerNameEsc, "World", sizeof(killerNameEsc));
		Q_strncpyz(killerGuidEsc, "WORLD", sizeof(killerGuidEsc));
	}

	ETPanel_EscapeJson(ETPanel_GetName(victim), victimNameEsc, sizeof(victimNameEsc));
	ETPanel_EscapeJson(ETPanel_GetGuid(victim), victimGuidEsc, sizeof(victimGuidEsc));

	// Check for suicide
	if (victim == killer || killer < 0 || killer == 1022)
	{
		// Suicide/world kill - only report if victim is human
		if (!victimIsBot)
		{
			Com_sprintf(json, sizeof(json),
			            "{\"slot\":%d,\"name\":\"%s\",\"guid\":\"%s\",\"cause\":\"%s\",\"death_type\":\"suicide\",\"map\":\"%s\",\"timestamp\":%d}",
			            victim,
			            victimNameEsc,
			            victimGuidEsc,
			            weapon,
			            level.rawmapname,
			            timestamp);
			ETPanel_SendEvent("game/death", json);
		}
		return;
	}

	// Regular kill - report kill event for human killer
	if (!killerIsBot)
	{
		Com_sprintf(json, sizeof(json),
		            "{\"killer_slot\":%d,\"killer_name\":\"%s\",\"killer_guid\":\"%s\","
		            "\"victim_slot\":%d,\"victim_name\":\"%s\",\"victim_guid\":\"%s\","
		            "\"victim_is_bot\":%s,\"is_team_kill\":%s,\"weapon\":\"%s\",\"map\":\"%s\",\"timestamp\":%d}",
		            killer,
		            killerNameEsc,
		            killerGuidEsc,
		            victim,
		            victimNameEsc,
		            victimGuidEsc,
		            victimIsBot ? "true" : "false",
		            isTeamKill ? "true" : "false",
		            weapon,
		            level.rawmapname,
		            timestamp);
		ETPanel_SendEvent("game/kill", json);
	}

	// Report death event for human victim
	if (!victimIsBot)
	{
		Com_sprintf(json, sizeof(json),
		            "{\"slot\":%d,\"name\":\"%s\",\"guid\":\"%s\","
		            "\"killer_slot\":%d,\"killer_name\":\"%s\",\"killer_guid\":\"%s\","
		            "\"killer_is_bot\":%s,\"is_team_kill\":%s,\"cause\":\"%s\",\"death_type\":\"%s\",\"map\":\"%s\",\"timestamp\":%d}",
		            victim,
		            victimNameEsc,
		            victimGuidEsc,
		            killer,
		            killerNameEsc,
		            killerGuidEsc,
		            killerIsBot ? "true" : "false",
		            isTeamKill ? "true" : "false",
		            weapon,
		            isTeamKill ? "teamkill" : (killerIsBot ? "bot" : "human"),
		            level.rawmapname,
		            timestamp);
		ETPanel_SendEvent("game/death", json);
	}
}

/**
 * @brief Round ended
 */
void G_ETPanel_RoundEnd(int winner)
{
	char json[512];

	if (!etpanel_enabled.integer)
	{
		return;
	}

	// winner: 0 = draw, 1 = axis, 2 = allies
	Com_sprintf(json, sizeof(json),
	            "{\"winner\":%d,\"map\":\"%s\",\"timestamp\":%d}",
	            winner,
	            level.rawmapname,
	            ETPanel_GetTimestamp());

	ETPanel_SendEvent("game/round-end", json);
}

/**
 * @brief Map ended
 */
void G_ETPanel_MapEnd(void)
{
	char json[512];

	if (!etpanel_enabled.integer)
	{
		return;
	}

	Com_sprintf(json, sizeof(json),
	            "{\"map\":\"%s\",\"timestamp\":%d}",
	            level.rawmapname,
	            ETPanel_GetTimestamp());

	ETPanel_SendEvent("game/map-end", json);
}

/**
 * @brief Chat message
 */
void G_ETPanel_Chat(int clientNum, int mode, const char *message)
{
	char json[2048];
	char nameEsc[MAX_NETNAME * 2];
	char guidEsc[128];
	char msgEsc[1024];

	if (!etpanel_enabled.integer)
	{
		return;
	}

	// Skip bots
	if (ETPanel_IsBot(clientNum))
	{
		return;
	}

	ETPanel_EscapeJson(ETPanel_GetName(clientNum), nameEsc, sizeof(nameEsc));
	ETPanel_EscapeJson(ETPanel_GetGuid(clientNum), guidEsc, sizeof(guidEsc));
	ETPanel_EscapeJson(message, msgEsc, sizeof(msgEsc));

	// mode: 0 = all, 1 = team, 2 = fireteam
	Com_sprintf(json, sizeof(json),
	            "{\"slot\":%d,\"name\":\"%s\",\"guid\":\"%s\",\"message\":\"%s\",\"team\":%s,\"timestamp\":%d}",
	            clientNum,
	            nameEsc,
	            guidEsc,
	            msgEsc,
	            mode > 0 ? "true" : "false",
	            ETPanel_GetTimestamp());

	ETPanel_SendEvent("game/chat", json);
}
