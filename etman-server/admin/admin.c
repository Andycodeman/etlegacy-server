/**
 * @file admin.c
 * @brief ETMan Admin Commands System - Core implementation
 *
 * Provides command dispatch, player tracking, and permission checking.
 */

#include "admin.h"
#include "../db_manager.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <ctype.h>
#include <libpq-fe.h>

/*
 * Static state
 */
static AdminPlayer g_players[ADMIN_MAX_PLAYERS];
static bool        g_initialized = false;

/* Socket for sending responses back to qagame */
static int         g_adminSocket = -1;
static struct sockaddr_in g_qagameAddr;
static bool        g_qagameAddrSet = false;

/* Forward declarations */
extern int getAdminSocket(void);
void Admin_SetQagameAddr(struct sockaddr_in *addr);

/*
 * Command registry
 */
static const AdminCommand g_commands[] = {
    /* Level 0 (Guest) commands */
    { "help",       Cmd_Help,       0, "!help [command]",              "Show available commands" },
    { "admintest",  Cmd_AdminTest,  0, "!admintest",                   "Show your admin level" },
    { "time",       Cmd_Time,       0, "!time",                        "Show server time" },
    { "maplist",    Cmd_MapList,    0, "!maplist",                     "Show map rotation" },

    /* Level 1 (Regular) commands */
    { "nextmap",    Cmd_NextMap,    1, "!nextmap",                     "Show next map in rotation" },
    { "stats",      Cmd_Stats,      1, "!stats [player]",              "Show player statistics" },

    /* Level 2 (VIP) commands */
    { "players",    Cmd_Players,    2, "!players",                     "List players with slot IDs" },
    { "spec999",    Cmd_Spec999,    2, "!spec999",                     "Force yourself to spectator" },

    /* Level 3 (Admin) commands */
    { "rotate",     Cmd_Rotate,     3, "!rotate",                      "Advance to next map" },
    { "map",        Cmd_Map,        3, "!map <mapname>",               "Change to specific map" },
    { "restart",    Cmd_Restart,    3, "!restart",                     "Restart current map" },
    { "kick",       Cmd_Kick,       3, "!kick <player> [reason]",      "Kick a player" },
    { "mute",       Cmd_Mute,       3, "!mute <player> [duration]",    "Mute player chat" },
    { "unmute",     Cmd_Unmute,     3, "!unmute <player>",             "Unmute player" },
    { "warn",       Cmd_Warn,       3, "!warn <player> <reason>",      "Warn a player" },
    { "put",        Cmd_Put,        3, "!put <player> <team>",         "Force to team (a/b/s)" },
    { "finger",     Cmd_Finger,     3, "!finger <player>",             "Show player info" },
    { "aliases",    Cmd_Aliases,    3, "!aliases <player>",            "Show player name history" },
    { "listadmins", Cmd_ListAdmins, 3, "!listadmins",                  "List online admins" },

    /* Level 4 (Senior Admin) commands */
    { "ban",        Cmd_Ban,        4, "!ban <player> <duration> [reason]", "Ban a player" },
    { "unban",      Cmd_Unban,      4, "!unban <guid>",                "Unban by GUID" },
    { "slap",       Cmd_Slap,       4, "!slap <player> [damage]",      "Slap player" },
    { "gib",        Cmd_Gib,        4, "!gib <player>",                "Gib player" },
    { "setlevel",   Cmd_SetLevel,   4, "!setlevel <player> <level>",   "Set admin level" },
    { "fling",      Cmd_Fling,      4, "!fling <player> [strength]",   "Fling player randomly" },
    { "up",         Cmd_Up,         4, "!up <player> [strength]",      "Launch player into sky" },
    { "kickbots",   Cmd_KickBots,   3, "!kickbots",                    "Remove all bots" },
    { "putbots",    Cmd_PutBots,    3, "!putbots [count]",             "Add bots (default: 12)" },

    { NULL, NULL, 0, NULL, NULL }  /* Terminator */
};

/*
 * Utility: Strip ET color codes (^0-^9, ^a-^z, ^A-^Z)
 */
void Admin_StripColors(const char *src, char *dst, int dstLen) {
    int i = 0, j = 0;

    if (!src || !dst || dstLen <= 0) return;

    while (src[i] && j < dstLen - 1) {
        if (src[i] == '^' && src[i + 1] && isalnum((unsigned char)src[i + 1])) {
            i += 2;  /* Skip color code */
        } else {
            dst[j++] = src[i++];
        }
    }
    dst[j] = '\0';
}

/*
 * Utility: Convert to lowercase
 */
void Admin_ToLower(char *str) {
    if (!str) return;
    for (; *str; str++) {
        *str = tolower((unsigned char)*str);
    }
}

/*
 * Initialize admin system
 */
bool Admin_Init(void) {
    if (g_initialized) {
        return true;
    }

    /* Clear player state */
    memset(g_players, 0, sizeof(g_players));

    /* Database connection is already handled by db_manager */
    if (!DB_IsConnected()) {
        printf("[ADMIN] Warning: Database not connected, admin features limited\n");
    } else {
        printf("[ADMIN] Database connected, admin system ready\n");
    }

    g_initialized = true;
    g_qagameAddrSet = false;
    printf("[ADMIN] Admin system initialized with %d commands\n",
           (int)(sizeof(g_commands) / sizeof(g_commands[0]) - 1));

    return true;
}

/**
 * Set the qagame address for sending responses.
 * Called by main.c when receiving admin commands.
 */
void Admin_SetQagameAddr(struct sockaddr_in *addr) {
    if (addr) {
        memcpy(&g_qagameAddr, addr, sizeof(g_qagameAddr));
        g_qagameAddrSet = true;
    }
}

/*
 * Shutdown admin system
 */
void Admin_Shutdown(void) {
    if (!g_initialized) return;

    memset(g_players, 0, sizeof(g_players));
    g_initialized = false;

    printf("[ADMIN] Admin system shutdown\n");
}

/*
 * Find command by name
 */
static const AdminCommand* findCommand(const char *name) {
    for (int i = 0; g_commands[i].name; i++) {
        if (strcasecmp(g_commands[i].name, name) == 0) {
            return &g_commands[i];
        }
    }
    return NULL;
}

/*
 * Get player level from database
 */
static int getPlayerLevel(const char *guid) {
    if (!DB_IsConnected() || !guid || !guid[0]) {
        return ADMIN_LEVEL_GUEST;
    }

    PGconn *conn = DB_GetConnection();
    if (!conn) return ADMIN_LEVEL_GUEST;

    const char *query =
        "SELECT COALESCE(l.level, 0) "
        "FROM admin_players p "
        "JOIN admin_levels l ON p.level_id = l.id "
        "WHERE p.guid = $1";

    const char *params[1] = { guid };
    PGresult *res = PQexecParams(conn, query, 1, NULL, params, NULL, NULL, 0);

    int level = ADMIN_LEVEL_GUEST;
    if (PQresultStatus(res) == PGRES_TUPLES_OK && PQntuples(res) > 0) {
        level = atoi(PQgetvalue(res, 0, 0));
    }

    PQclear(res);
    return level;
}

/*
 * Check if player has permission (with per-player overrides)
 */
bool Admin_HasPermission(const char *guid, const char *cmdName) {
    const AdminCommand *cmd = findCommand(cmdName);
    if (!cmd) return false;

    /* Get player level */
    int playerLevel = getPlayerLevel(guid);

    /* Check for per-player override in database */
    if (DB_IsConnected()) {
        PGconn *conn = DB_GetConnection();
        if (conn) {
            const char *query =
                "SELECT pp.granted FROM admin_player_permissions pp "
                "JOIN admin_players p ON pp.player_id = p.id "
                "JOIN admin_commands c ON pp.command_id = c.id "
                "WHERE p.guid = $1 AND c.name = $2";

            const char *params[2] = { guid, cmdName };
            PGresult *res = PQexecParams(conn, query, 2, NULL, params, NULL, NULL, 0);

            if (PQresultStatus(res) == PGRES_TUPLES_OK && PQntuples(res) > 0) {
                bool granted = PQgetvalue(res, 0, 0)[0] == 't';
                PQclear(res);
                return granted;
            }
            PQclear(res);
        }
    }

    /* Fall back to level check */
    return playerLevel >= cmd->minLevel;
}

/*
 * Handle incoming admin command
 */
void Admin_HandleCommand(int clientSlot, const char *guid, const char *name,
                         const char *cmdText) {
    if (!g_initialized) {
        Admin_Init();
    }

    if (clientSlot < 0 || clientSlot >= ADMIN_MAX_PLAYERS) {
        return;
    }

    /* Parse command and arguments */
    char cmd[64] = {0};
    char args[ADMIN_MAX_ARGS_LEN] = {0};

    if (sscanf(cmdText, "%63s %511[^\n]", cmd, args) < 1) {
        return;
    }

    /* Convert command to lowercase for matching */
    Admin_ToLower(cmd);

    printf("[ADMIN] Player %d (%s) executed: !%s %s\n",
           clientSlot, name, cmd, args);

    /* Update player info */
    AdminPlayer *player = &g_players[clientSlot];
    player->connected = true;
    player->slot = clientSlot;
    strncpy(player->guid, guid, ADMIN_GUID_LEN);
    player->guid[ADMIN_GUID_LEN] = '\0';
    strncpy(player->name, name, ADMIN_MAX_NAME_LEN);
    player->name[ADMIN_MAX_NAME_LEN] = '\0';
    Admin_StripColors(name, player->cleanName, ADMIN_MAX_NAME_LEN);
    Admin_ToLower(player->cleanName);
    player->level = getPlayerLevel(guid);

    /* Update database (player record, alias) */
    if (DB_IsConnected()) {
        PGconn *conn = DB_GetConnection();
        if (conn) {
            /* Call get_or_create_player function */
            const char *q1 = "SELECT get_or_create_player($1)";
            const char *p1[1] = { guid };
            PGresult *r1 = PQexecParams(conn, q1, 1, NULL, p1, NULL, NULL, 0);
            if (PQresultStatus(r1) == PGRES_TUPLES_OK && PQntuples(r1) > 0) {
                player->playerId = atoi(PQgetvalue(r1, 0, 0));
            }
            PQclear(r1);

            /* Update alias */
            const char *q2 = "SELECT update_player_alias($1, $2)";
            char playerIdStr[16];
            snprintf(playerIdStr, sizeof(playerIdStr), "%d", player->playerId);
            const char *p2[2] = { playerIdStr, name };
            PGresult *r2 = PQexecParams(conn, q2, 2, NULL, p2, NULL, NULL, 0);
            PQclear(r2);
        }
    }

    /* Find command */
    const AdminCommand *command = findCommand(cmd);
    if (!command) {
        Admin_SendResponse(clientSlot,
            "^1Unknown command: ^3!%s^1. Type ^3!help ^1for available commands.", cmd);
        return;
    }

    /* Check permission */
    if (!Admin_HasPermission(guid, cmd)) {
        Admin_SendResponse(clientSlot,
            "^1Permission denied for ^3!%s^1. Required level: %d, your level: %d",
            cmd, command->minLevel, player->level);
        return;
    }

    /* Execute command */
    command->func(clientSlot, player, args);

    /* Log command execution */
    if (DB_IsConnected()) {
        PGconn *conn = DB_GetConnection();
        if (conn) {
            const char *query =
                "INSERT INTO admin_command_log (player_id, command, args, success, source) "
                "VALUES ($1, $2, $3, true, 'game')";

            char playerIdStr[16];
            snprintf(playerIdStr, sizeof(playerIdStr), "%d", player->playerId);
            const char *params[3] = { playerIdStr, cmd, args[0] ? args : NULL };
            PGresult *res = PQexecParams(conn, query, 3, NULL, params, NULL, NULL, 0);
            PQclear(res);
        }
    }
}

/*
 * Player events
 */
void Admin_PlayerConnect(int slot, const char *guid, const char *name, uint8_t team) {
    if (slot < 0 || slot >= ADMIN_MAX_PLAYERS) return;

    AdminPlayer *p = &g_players[slot];
    memset(p, 0, sizeof(*p));

    p->connected = true;
    p->slot = slot;
    strncpy(p->guid, guid, ADMIN_GUID_LEN);
    strncpy(p->name, name, ADMIN_MAX_NAME_LEN);
    Admin_StripColors(name, p->cleanName, ADMIN_MAX_NAME_LEN);
    Admin_ToLower(p->cleanName);
    p->team = team;
    p->connectTime = time(NULL);
    p->level = getPlayerLevel(guid);
    p->playerId = -1;

    /* Get or create player in database and update alias */
    if (DB_IsConnected()) {
        PGconn *conn = DB_GetConnection();
        if (conn) {
            /* Call get_or_create_player function */
            const char *q1 = "SELECT get_or_create_player($1)";
            const char *p1[1] = { guid };
            PGresult *r1 = PQexecParams(conn, q1, 1, NULL, p1, NULL, NULL, 0);
            if (PQresultStatus(r1) == PGRES_TUPLES_OK && PQntuples(r1) > 0) {
                p->playerId = atoi(PQgetvalue(r1, 0, 0));
            }
            PQclear(r1);

            /* Update alias */
            if (p->playerId > 0) {
                const char *q2 = "SELECT update_player_alias($1, $2)";
                char playerIdStr[16];
                snprintf(playerIdStr, sizeof(playerIdStr), "%d", p->playerId);
                const char *p2[2] = { playerIdStr, name };
                PGresult *r2 = PQexecParams(conn, q2, 2, NULL, p2, NULL, NULL, 0);
                PQclear(r2);
            }
        }
    }

    printf("[ADMIN] Player connected: slot=%d guid=%s name=%s level=%d dbId=%d\n",
           slot, guid, name, p->level, p->playerId);

    /* Check ban status */
    char banReason[256];
    time_t banExpires;
    if (Admin_IsBanned(guid, banReason, &banExpires)) {
        /* Send kick action to qagame */
        char kickData[512];
        if (banExpires) {
            snprintf(kickData, sizeof(kickData), "Banned until %s: %s",
                     ctime(&banExpires), banReason);
        } else {
            snprintf(kickData, sizeof(kickData), "Permanently banned: %s", banReason);
        }
        Admin_SendAction(ADMIN_ACTION_KICK, slot, kickData);
    }
}

void Admin_PlayerDisconnect(int slot) {
    if (slot < 0 || slot >= ADMIN_MAX_PLAYERS) return;

    AdminPlayer *p = &g_players[slot];
    printf("[ADMIN] Player disconnected: slot=%d name=%s\n", slot, p->name);
    memset(p, 0, sizeof(*p));
}

void Admin_PlayerTeamChange(int slot, uint8_t team) {
    if (slot < 0 || slot >= ADMIN_MAX_PLAYERS) return;
    g_players[slot].team = team;
}

void Admin_PlayerNameChange(int slot, const char *newName) {
    if (slot < 0 || slot >= ADMIN_MAX_PLAYERS) return;

    AdminPlayer *p = &g_players[slot];
    strncpy(p->name, newName, ADMIN_MAX_NAME_LEN);
    Admin_StripColors(newName, p->cleanName, ADMIN_MAX_NAME_LEN);
    Admin_ToLower(p->cleanName);

    /* Update alias in database */
    if (DB_IsConnected() && p->playerId > 0) {
        PGconn *conn = DB_GetConnection();
        if (conn) {
            const char *query = "SELECT update_player_alias($1, $2)";
            char playerIdStr[16];
            snprintf(playerIdStr, sizeof(playerIdStr), "%d", p->playerId);
            const char *params[2] = { playerIdStr, newName };
            PGresult *res = PQexecParams(conn, query, 2, NULL, params, NULL, NULL, 0);
            PQclear(res);
        }
    }
}

/*
 * Send response to player via qagame
 */
void Admin_SendResponse(int slot, const char *fmt, ...) {
    char message[ADMIN_MAX_RESPONSE_LEN];
    va_list args;
    AdminRespPacket pkt;

    va_start(args, fmt);
    vsnprintf(message, sizeof(message), fmt, args);
    va_end(args);

    printf("[ADMIN] Response to slot %d: %s\n", slot, message);

    /* Send response packet to qagame */
    if (!g_qagameAddrSet) {
        printf("[ADMIN] Warning: qagame address not set, cannot send response\n");
        return;
    }

    int sock = getAdminSocket();
    if (sock < 0) {
        printf("[ADMIN] Warning: no socket available for response\n");
        return;
    }

    memset(&pkt, 0, sizeof(pkt));
    pkt.type = PKT_ADMIN_RESP;
    pkt.clientSlot = (slot >= 0 && slot < 255) ? (uint8_t)slot : 255;
    strncpy(pkt.message, message, ADMIN_MAX_RESPONSE_LEN - 1);
    pkt.message[ADMIN_MAX_RESPONSE_LEN - 1] = '\0';

    int sent = sendto(sock, &pkt, sizeof(pkt), 0,
                      (struct sockaddr *)&g_qagameAddr, sizeof(g_qagameAddr));
    if (sent < 0) {
        printf("[ADMIN] Failed to send response packet\n");
    }
}

/*
 * Send action to qagame
 */
void Admin_SendAction(uint8_t action, uint8_t targetSlot, const char *data) {
    AdminActionPacket pkt;

    printf("[ADMIN] Action: type=%d target=%d data=%s\n", action, targetSlot, data ? data : "");

    /* Send action packet to qagame */
    if (!g_qagameAddrSet) {
        printf("[ADMIN] Warning: qagame address not set, cannot send action\n");
        return;
    }

    int sock = getAdminSocket();
    if (sock < 0) {
        printf("[ADMIN] Warning: no socket available for action\n");
        return;
    }

    memset(&pkt, 0, sizeof(pkt));
    pkt.type = PKT_ADMIN_ACTION;
    pkt.action = action;
    pkt.targetSlot = targetSlot;
    if (data) {
        strncpy(pkt.data, data, ADMIN_MAX_ARGS_LEN - 1);
        pkt.data[ADMIN_MAX_ARGS_LEN - 1] = '\0';
    }

    int sent = sendto(sock, &pkt, sizeof(pkt), 0,
                      (struct sockaddr *)&g_qagameAddr, sizeof(g_qagameAddr));
    if (sent < 0) {
        printf("[ADMIN] Failed to send action packet\n");
    }
}

/*
 * Get player by slot
 */
AdminPlayer* Admin_GetPlayer(int slot) {
    if (slot < 0 || slot >= ADMIN_MAX_PLAYERS) return NULL;
    if (!g_players[slot].connected) return NULL;
    return &g_players[slot];
}

/*
 * Find player by name/slot
 */
int Admin_FindPlayer(const char *search, int *outSlots, int maxResults) {
    if (!search || !outSlots || maxResults <= 0) return 0;

    int count = 0;
    char searchLower[ADMIN_MAX_NAME_LEN];

    /* Check if it's a slot number */
    char *endptr;
    long slot = strtol(search, &endptr, 10);
    if (*endptr == '\0' && slot >= 0 && slot < ADMIN_MAX_PLAYERS) {
        if (g_players[slot].connected) {
            outSlots[0] = (int)slot;
            return 1;
        }
        return 0;
    }

    /* Fuzzy name match */
    strncpy(searchLower, search, sizeof(searchLower) - 1);
    searchLower[sizeof(searchLower) - 1] = '\0';
    Admin_ToLower(searchLower);

    for (int i = 0; i < ADMIN_MAX_PLAYERS && count < maxResults; i++) {
        if (!g_players[i].connected) continue;

        /* Get clean name for matching */
        const char *matchName = g_players[i].cleanName;

        /* Skip [bot] prefix if present for fuzzy matching */
        if (strncmp(matchName, "[bot]", 5) == 0) {
            matchName += 5;
        }

        /* Check if search matches the name (with or without [bot] prefix) */
        if (strstr(g_players[i].cleanName, searchLower) || strstr(matchName, searchLower)) {
            outSlots[count++] = i;
        }
    }

    return count;
}

/*
 * Get player count
 */
int Admin_GetPlayerCount(void) {
    int count = 0;
    for (int i = 0; i < ADMIN_MAX_PLAYERS; i++) {
        if (g_players[i].connected) count++;
    }
    return count;
}

/*
 * Check ban status
 */
bool Admin_IsBanned(const char *guid, char *outReason, time_t *outExpires) {
    if (!DB_IsConnected() || !guid) return false;

    PGconn *conn = DB_GetConnection();
    if (!conn) return false;

    const char *query =
        "SELECT b.reason, b.expires_at "
        "FROM admin_bans b "
        "JOIN admin_players p ON b.player_id = p.id "
        "WHERE p.guid = $1 AND b.active = true "
        "AND (b.expires_at IS NULL OR b.expires_at > NOW()) "
        "ORDER BY b.issued_at DESC LIMIT 1";

    const char *params[1] = { guid };
    PGresult *res = PQexecParams(conn, query, 1, NULL, params, NULL, NULL, 0);

    bool banned = false;
    if (PQresultStatus(res) == PGRES_TUPLES_OK && PQntuples(res) > 0) {
        banned = true;
        if (outReason) {
            strncpy(outReason, PQgetvalue(res, 0, 0), 255);
        }
        if (outExpires) {
            const char *expiresStr = PQgetvalue(res, 0, 1);
            if (expiresStr && expiresStr[0]) {
                /* Parse timestamp - simplified */
                *outExpires = 0;  /* TODO: proper parsing */
            } else {
                *outExpires = 0;  /* Permanent */
            }
        }
    }

    PQclear(res);
    return banned;
}

/*
 * Check mute status
 */
bool Admin_IsMuted(const char *guid) {
    if (!DB_IsConnected() || !guid) return false;

    PGconn *conn = DB_GetConnection();
    if (!conn) return false;

    const char *query =
        "SELECT 1 FROM admin_mutes m "
        "JOIN admin_players p ON m.player_id = p.id "
        "WHERE p.guid = $1 AND m.active = true "
        "AND (m.expires_at IS NULL OR m.expires_at > NOW()) "
        "LIMIT 1";

    const char *params[1] = { guid };
    PGresult *res = PQexecParams(conn, query, 1, NULL, params, NULL, NULL, 0);

    bool muted = (PQresultStatus(res) == PGRES_TUPLES_OK && PQntuples(res) > 0);
    PQclear(res);

    return muted;
}
