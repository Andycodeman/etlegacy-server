/**
 * @file commands.c
 * @brief ETMan Admin Commands - Command implementations
 *
 * Individual !command handler functions.
 */

#include "admin.h"
#include "../db_manager.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <libpq-fe.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

/* Use DB_GetConnection() from db_manager.h for database access */

/*
 * !help [command] - Show available commands
 */
void Cmd_Help(int slot, AdminPlayer *caller, const char *args) {
    if (args && args[0]) {
        /* Help for specific command */
        /* Look up command in database for description */
        if (DB_IsConnected()) {
            PGconn *conn = DB_GetConnection();
            if (conn) {
                const char *query =
                    "SELECT c.usage, c.description, c.default_level "
                    "FROM admin_commands c WHERE c.name = $1 AND c.enabled = true";
                const char *params[1] = { args };
                PGresult *res = PQexecParams(conn, query, 1, NULL, params, NULL, NULL, 0);

                if (PQresultStatus(res) == PGRES_TUPLES_OK && PQntuples(res) > 0) {
                    Admin_SendResponse(slot, "^3%s ^7- %s (Level %s)",
                        PQgetvalue(res, 0, 0),
                        PQgetvalue(res, 0, 1),
                        PQgetvalue(res, 0, 2));
                } else {
                    Admin_SendResponse(slot, "^1Unknown command: ^3!%s", args);
                }
                PQclear(res);
                return;
            }
        }
        Admin_SendResponse(slot, "^1Help system not available (database offline)");
        return;
    }

    /* List commands at or below player's level */
    Admin_SendResponse(slot, "^3=== Available Commands (Level %d) ===", caller->level);

    if (DB_IsConnected()) {
        PGconn *conn = DB_GetConnection();
        if (conn) {
            const char *query =
                "SELECT c.name FROM admin_commands c "
                "WHERE c.enabled = true AND c.default_level <= $1 "
                "ORDER BY c.default_level, c.name";

            char levelStr[8];
            snprintf(levelStr, sizeof(levelStr), "%d", caller->level);
            const char *params[1] = { levelStr };
            PGresult *res = PQexecParams(conn, query, 1, NULL, params, NULL, NULL, 0);

            if (PQresultStatus(res) == PGRES_TUPLES_OK) {
                char cmdList[1024] = "";
                int count = PQntuples(res);
                for (int i = 0; i < count; i++) {
                    if (i > 0) strcat(cmdList, ", ");
                    strcat(cmdList, "!");
                    strcat(cmdList, PQgetvalue(res, i, 0));

                    /* Line wrap */
                    if (strlen(cmdList) > 80 && i < count - 1) {
                        Admin_SendResponse(slot, "^7%s", cmdList);
                        cmdList[0] = '\0';
                    }
                }
                if (cmdList[0]) {
                    Admin_SendResponse(slot, "^7%s", cmdList);
                }
            }
            PQclear(res);
        }
    } else {
        Admin_SendResponse(slot, "^7!help, !admintest, !time, !maplist");
    }

    Admin_SendResponse(slot, "^3Type ^7!help <command> ^3for details.");
}

/*
 * !admintest - Show your admin level
 */
void Cmd_AdminTest(int slot, AdminPlayer *caller, const char *args) {
    (void)args;

    const char *levelNames[] = {
        "Guest", "Regular", "VIP", "Admin", "Senior Admin", "Owner"
    };

    const char *levelName = (caller->level >= 0 && caller->level <= 5)
        ? levelNames[caller->level] : "Unknown";

    Admin_SendResponse(slot, "^3You are level ^2%d ^3(^7%s^3)",
        caller->level, levelName);
}

/*
 * !time - Show server time
 */
void Cmd_Time(int slot, AdminPlayer *caller, const char *args) {
    (void)caller;
    (void)args;

    time_t now = time(NULL);
    struct tm *tm = localtime(&now);
    char timeStr[64];

    strftime(timeStr, sizeof(timeStr), "%Y-%m-%d %H:%M:%S %Z", tm);
    Admin_SendResponse(slot, "^3Server time: ^7%s", timeStr);
}

/*
 * Helper: Load maps from maplist.txt
 * Returns number of maps loaded, stores in maps array
 * maplist.txt format: one map per line, # for comments
 * This is the SAME file the C server reads (sv_ccmds.c SV_LoadMapRotation)
 */
static int LoadMapList(char maps[][64], int maxMaps) {
    FILE *fp = fopen("/home/andy/etlegacy/legacy/maplist.txt", "r");
    if (!fp) {
        return 0;
    }

    char line[256];
    int mapCount = 0;

    while (fgets(line, sizeof(line), fp) && mapCount < maxMaps) {
        /* Trim leading whitespace */
        char *p = line;
        while (*p == ' ' || *p == '\t') p++;

        /* Skip empty lines and comments */
        if (*p == '\0' || *p == '\n' || *p == '\r' || *p == '#' || *p == '/') {
            continue;
        }

        /* Trim trailing whitespace/newline */
        int len = strlen(p);
        while (len > 0 && (p[len-1] == ' ' || p[len-1] == '\t' || p[len-1] == '\n' || p[len-1] == '\r')) {
            p[--len] = '\0';
        }

        if (len > 0) {
            strncpy(maps[mapCount], p, 63);
            maps[mapCount][63] = '\0';
            mapCount++;
        }
    }
    fclose(fp);
    return mapCount;
}

/*
 * Helper: Query current map from game server via rcon
 * Sends "rcon <password> currentmap" and parses response
 */
static int QueryCurrentMap(char *outMap, int maxLen) {
    int sock;
    struct sockaddr_in serverAddr;
    char request[128];
    char response[512];
    int len;
    struct timeval tv;

    /* Create UDP socket */
    sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        return 0;
    }

    /* Set timeout */
    tv.tv_sec = 1;
    tv.tv_usec = 0;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    /* Server address */
    memset(&serverAddr, 0, sizeof(serverAddr));
    serverAddr.sin_family = AF_INET;
    serverAddr.sin_port = htons(27960);
    serverAddr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    /* Build rcon request: \xff\xff\xff\xffrcon <password> currentmap */
    snprintf(request, sizeof(request), "\xff\xff\xff\xff" "rcon emma01 currentmap");

    /* Send request */
    if (sendto(sock, request, strlen(request), 0,
               (struct sockaddr *)&serverAddr, sizeof(serverAddr)) < 0) {
        close(sock);
        return 0;
    }

    /* Receive response */
    len = recv(sock, response, sizeof(response) - 1, 0);
    close(sock);

    if (len <= 0) {
        return 0;
    }
    response[len] = '\0';

    /* Response format: \xff\xff\xff\xffprint\n<mapname>\n */
    char *p = response;
    /* Skip header */
    if (len > 4 && memcmp(p, "\xff\xff\xff\xff", 4) == 0) {
        p += 4;
    }
    /* Skip "print\n" */
    if (strncmp(p, "print\n", 6) == 0) {
        p += 6;
    }

    /* Copy map name, trim whitespace */
    int mapLen = 0;
    while (*p && *p != '\n' && *p != '\r' && mapLen < maxLen - 1) {
        outMap[mapLen++] = *p++;
    }
    outMap[mapLen] = '\0';

    return mapLen > 0 ? 1 : 0;
}

/*
 * !nextmap - Show next map in rotation
 * Queries current map via rcon, finds next in maplist.txt
 */
void Cmd_NextMap(int slot, AdminPlayer *caller, const char *args) {
    (void)caller;
    (void)args;

    char maps[64][64];
    int mapCount = LoadMapList(maps, 64);

    if (mapCount == 0) {
        Admin_SendResponse(slot, "^1Error: Could not read maplist.txt or no maps defined");
        return;
    }

    /* Query current map from game server */
    char currentMap[64] = "";
    if (!QueryCurrentMap(currentMap, sizeof(currentMap))) {
        Admin_SendResponse(slot, "^1Error: Could not query current map from server");
        return;
    }

    /* Find current map in rotation */
    int currentIndex = -1;
    for (int i = 0; i < mapCount; i++) {
        if (strcasecmp(currentMap, maps[i]) == 0) {
            currentIndex = i;
            break;
        }
    }

    if (currentIndex < 0) {
        /* Current map not in rotation, next will be first map */
        Admin_SendResponse(slot, "^3Current: ^7%s ^1(not in rotation)", currentMap);
        Admin_SendResponse(slot, "^3Next map: ^7%s", maps[0]);
    } else {
        int nextIndex = (currentIndex + 1) % mapCount;
        Admin_SendResponse(slot, "^3Current: ^7%s ^3(%d/%d)", currentMap, currentIndex + 1, mapCount);
        Admin_SendResponse(slot, "^3Next map: ^7%s", maps[nextIndex]);
    }

    Admin_SendResponse(slot, "^7Use ^3!rotate ^7to change now.");
}

/*
 * !maplist - Show map rotation
 * Reads from maplist.txt (same as server C code)
 */
void Cmd_MapList(int slot, AdminPlayer *caller, const char *args) {
    (void)caller;
    (void)args;

    char allMaps[64][64];
    int mapCount = LoadMapList(allMaps, 64);

    Admin_SendResponse(slot, "^3=== Map Rotation (%d maps) ===", mapCount);

    if (mapCount == 0) {
        Admin_SendResponse(slot, "^1No maps found in maplist.txt");
        return;
    }

    /* Build comma-separated list */
    char mapStr[512] = "";
    for (int i = 0; i < mapCount; i++) {
        if (i > 0) {
            strncat(mapStr, ", ", sizeof(mapStr) - strlen(mapStr) - 1);
        }
        strncat(mapStr, allMaps[i], sizeof(mapStr) - strlen(mapStr) - 1);
    }

    Admin_SendResponse(slot, "^7%s", mapStr);
    Admin_SendResponse(slot, "^3Use ^7!rotate ^3to advance, ^7!map <name> ^3to change.");
}

/*
 * !players - List players with slot IDs
 */
void Cmd_Players(int slot, AdminPlayer *caller, const char *args) {
    (void)caller;
    (void)args;

    int count = Admin_GetPlayerCount();
    Admin_SendResponse(slot, "^3=== Players Online: %d ===", count);

    for (int i = 0; i < ADMIN_MAX_PLAYERS; i++) {
        AdminPlayer *p = Admin_GetPlayer(i);
        if (!p) continue;

        const char *teamStr;
        switch (p->team) {
            case ADMIN_TEAM_AXIS:    teamStr = "^1Axis"; break;
            case ADMIN_TEAM_ALLIES:  teamStr = "^4Allies"; break;
            case ADMIN_TEAM_SPECTATOR: teamStr = "^7Spec"; break;
            default: teamStr = "^3?"; break;
        }

        Admin_SendResponse(slot, "^7[%d] %s ^7(%s^7) L%d",
            i, p->name, teamStr, p->level);
    }
}

/*
 * !rotate - Advance to next map
 */
void Cmd_Rotate(int slot, AdminPlayer *caller, const char *args) {
    (void)args;

    Admin_SendResponse(255, "^3%s ^7rotated to next map.", caller->name);
    Admin_SendAction(ADMIN_ACTION_RCON, 0, "rotate");
}

/*
 * !map <mapname> - Change to specific map
 */
void Cmd_Map(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!map <mapname>");
        return;
    }

    char mapName[64];
    sscanf(args, "%63s", mapName);

    /* TODO: Validate map exists */

    Admin_SendResponse(255, "^3%s ^7changed map to ^3%s", caller->name, mapName);

    char cmd[128];
    snprintf(cmd, sizeof(cmd), "map %s", mapName);
    Admin_SendAction(ADMIN_ACTION_MAP, 0, mapName);
}

/*
 * !restart - Restart current map
 */
void Cmd_Restart(int slot, AdminPlayer *caller, const char *args) {
    (void)args;

    Admin_SendResponse(255, "^3%s ^7restarted the map.", caller->name);
    Admin_SendAction(ADMIN_ACTION_RESTART, 0, "");
}

/*
 * !kick <player> [reason] - Kick a player
 */
void Cmd_Kick(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!kick <player> [reason]");
        return;
    }

    char target[64];
    char reason[256] = "Kicked by admin";

    if (sscanf(args, "%63s %255[^\n]", target, reason) < 1) {
        Admin_SendResponse(slot, "^1Usage: ^3!kick <player> [reason]");
        return;
    }

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount == 0) {
        Admin_SendResponse(slot, "^1No player found matching ^3%s", target);
        return;
    }

    if (matchCount > 1) {
        Admin_SendResponse(slot, "^1Multiple players match ^3%s^1. Be more specific:", target);
        for (int i = 0; i < matchCount; i++) {
            AdminPlayer *p = Admin_GetPlayer(matches[i]);
            if (p) {
                Admin_SendResponse(slot, "  ^7[%d] %s", matches[i], p->name);
            }
        }
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) {
        Admin_SendResponse(slot, "^1Player not found.");
        return;
    }

    /* Can't kick higher level admins */
    if (targetPlayer->level >= caller->level && caller->level < ADMIN_LEVEL_OWNER) {
        Admin_SendResponse(slot, "^1Cannot kick ^3%s ^1- equal or higher level.", targetPlayer->name);
        return;
    }

    Admin_SendResponse(255, "^3%s ^7was kicked by ^3%s^7: %s",
        targetPlayer->name, caller->name, reason);
    Admin_SendAction(ADMIN_ACTION_KICK, matches[0], reason);
}

/*
 * !mute <player> [duration] - Mute player
 */
void Cmd_Mute(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!mute <player> [duration]");
        return;
    }

    char target[64];
    char duration[32] = "";

    sscanf(args, "%63s %31s", target, duration);

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount == 0) {
        Admin_SendResponse(slot, "^1No player found matching ^3%s", target);
        return;
    }

    if (matchCount > 1) {
        Admin_SendResponse(slot, "^1Multiple players match ^3%s^1. Be more specific.", target);
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) {
        Admin_SendResponse(slot, "^1Player not found.");
        return;
    }

    /* TODO: Parse duration, store in database */

    Admin_SendResponse(255, "^3%s ^7was muted by ^3%s",
        targetPlayer->name, caller->name);
    Admin_SendAction(ADMIN_ACTION_MUTE, matches[0], duration[0] ? duration : "0");
}

/*
 * !unmute <player> - Unmute player
 */
void Cmd_Unmute(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!unmute <player>");
        return;
    }

    char target[64];
    sscanf(args, "%63s", target);

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount != 1) {
        Admin_SendResponse(slot, matchCount == 0
            ? "^1No player found matching ^3%s"
            : "^1Multiple players match ^3%s^1. Be more specific.", target);
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) return;

    Admin_SendResponse(255, "^3%s ^7was unmuted by ^3%s",
        targetPlayer->name, caller->name);
    Admin_SendAction(ADMIN_ACTION_UNMUTE, matches[0], "");
}

/*
 * !warn <player> <reason> - Warn a player
 */
void Cmd_Warn(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!warn <player> <reason>");
        return;
    }

    char target[64];
    char reason[256] = "";

    if (sscanf(args, "%63s %255[^\n]", target, reason) < 2 || !reason[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!warn <player> <reason>");
        return;
    }

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount != 1) {
        Admin_SendResponse(slot, matchCount == 0
            ? "^1No player found matching ^3%s"
            : "^1Multiple players match.", target);
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) return;

    /* Store warning in database */
    if (DB_IsConnected() && targetPlayer->playerId > 0 && caller->playerId > 0) {
        PGconn *conn = DB_GetConnection();
        if (conn) {
            const char *query =
                "INSERT INTO admin_warnings (player_id, warned_by, reason) VALUES ($1, $2, $3)";
            char pid[16], wid[16];
            snprintf(pid, sizeof(pid), "%d", targetPlayer->playerId);
            snprintf(wid, sizeof(wid), "%d", caller->playerId);
            const char *params[3] = { pid, wid, reason };
            PGresult *res = PQexecParams(conn, query, 3, NULL, params, NULL, NULL, 0);
            PQclear(res);
        }
    }

    Admin_SendResponse(255, "^3%s ^7was warned by ^3%s^7: %s",
        targetPlayer->name, caller->name, reason);

    /* Send center print to warned player */
    char cpMsg[256];
    snprintf(cpMsg, sizeof(cpMsg), "You have been warned: %s", reason);
    Admin_SendAction(ADMIN_ACTION_CPRINT, matches[0], cpMsg);
}

/*
 * !ban <player> <duration> [reason] - Ban a player
 */
void Cmd_Ban(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!ban <player> <duration> [reason]");
        Admin_SendResponse(slot, "^7Duration: 1h, 1d, 1w, 1m, perm");
        return;
    }

    char target[64], duration[32], reason[256] = "Banned";
    if (sscanf(args, "%63s %31s %255[^\n]", target, duration, reason) < 2) {
        Admin_SendResponse(slot, "^1Usage: ^3!ban <player> <duration> [reason]");
        return;
    }

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount != 1) {
        Admin_SendResponse(slot, matchCount == 0
            ? "^1No player found matching ^3%s"
            : "^1Multiple players match.", target);
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) return;

    if (targetPlayer->level >= caller->level && caller->level < ADMIN_LEVEL_OWNER) {
        Admin_SendResponse(slot, "^1Cannot ban ^3%s ^1- equal or higher level.", targetPlayer->name);
        return;
    }

    /* TODO: Parse duration, store ban in database */

    Admin_SendResponse(255, "^3%s ^7was banned by ^3%s ^7(%s): %s",
        targetPlayer->name, caller->name, duration, reason);
    Admin_SendAction(ADMIN_ACTION_BAN, matches[0], reason);
}

/*
 * !unban <guid> - Unban by GUID
 */
void Cmd_Unban(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!unban <guid>");
        return;
    }

    char guid[ADMIN_GUID_LEN + 1];
    sscanf(args, "%32s", guid);

    if (!DB_IsConnected()) {
        Admin_SendResponse(slot, "^1Database not available.");
        return;
    }

    PGconn *conn = DB_GetConnection();
    if (!conn) return;

    const char *query =
        "UPDATE admin_bans SET active = false "
        "WHERE player_id = (SELECT id FROM admin_players WHERE guid = $1) "
        "AND active = true";

    const char *params[1] = { guid };
    PGresult *res = PQexecParams(conn, query, 1, NULL, params, NULL, NULL, 0);

    if (PQresultStatus(res) == PGRES_COMMAND_OK) {
        int affected = atoi(PQcmdTuples(res));
        if (affected > 0) {
            Admin_SendResponse(slot, "^2Unbanned GUID ^7%s", guid);
        } else {
            Admin_SendResponse(slot, "^1No active ban found for GUID ^7%s", guid);
        }
    } else {
        Admin_SendResponse(slot, "^1Database error.");
    }

    PQclear(res);
}

/*
 * !slap <player> [damage] - Slap player
 */
void Cmd_Slap(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!slap <player> [damage]");
        return;
    }

    char target[64];
    int damage = 20;

    sscanf(args, "%63s %d", target, &damage);
    if (damage < 0) damage = 0;
    if (damage > 999) damage = 999;

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount != 1) {
        Admin_SendResponse(slot, matchCount == 0
            ? "^1No player found matching ^3%s"
            : "^1Multiple players match.", target);
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) return;

    char dmgStr[16];
    snprintf(dmgStr, sizeof(dmgStr), "%d", damage);

    Admin_SendResponse(255, "^3%s ^7was slapped by ^3%s ^7(%d damage)",
        targetPlayer->name, caller->name, damage);
    Admin_SendAction(ADMIN_ACTION_SLAP, matches[0], dmgStr);
}

/*
 * !gib <player> - Gib player
 */
void Cmd_Gib(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!gib <player>");
        return;
    }

    char target[64];
    sscanf(args, "%63s", target);

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount != 1) {
        Admin_SendResponse(slot, matchCount == 0
            ? "^1No player found matching ^3%s"
            : "^1Multiple players match.", target);
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) return;

    Admin_SendResponse(255, "^3%s ^7was gibbed by ^3%s",
        targetPlayer->name, caller->name);
    Admin_SendAction(ADMIN_ACTION_GIB, matches[0], "");
}

/*
 * !put <player> <team> - Force to team
 */
void Cmd_Put(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!put <player> <team>");
        Admin_SendResponse(slot, "^7Teams: a/axis, b/allies, s/spec");
        return;
    }

    char target[64], teamStr[16];
    if (sscanf(args, "%63s %15s", target, teamStr) < 2) {
        Admin_SendResponse(slot, "^1Usage: ^3!put <player> <team>");
        return;
    }

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount != 1) {
        Admin_SendResponse(slot, matchCount == 0
            ? "^1No player found matching ^3%s"
            : "^1Multiple players match.", target);
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) return;

    const char *teamCode;
    const char *teamName;

    if (teamStr[0] == 'a' || teamStr[0] == 'r' || teamStr[0] == '1') {
        teamCode = "r";  /* axis = "r" (red) */
        teamName = "Axis";
    } else if (teamStr[0] == 'b' || teamStr[0] == '2') {
        teamCode = "b";  /* allies = "b" (blue) */
        teamName = "Allies";
    } else if (teamStr[0] == 's' || teamStr[0] == '3') {
        teamCode = "s";  /* spectator = "s" */
        teamName = "Spectator";
    } else {
        Admin_SendResponse(slot, "^1Invalid team. Use: a/axis, b/allies, s/spec");
        return;
    }

    Admin_SendResponse(255, "^3%s ^7was moved to ^3%s ^7by ^3%s",
        targetPlayer->name, teamName, caller->name);

    Admin_SendAction(ADMIN_ACTION_PUT, matches[0], teamCode);
}

/*
 * !setlevel <player> <level> - Set admin level
 */
void Cmd_SetLevel(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!setlevel <player> <level>");
        Admin_SendResponse(slot, "^7Levels: 0=Guest, 1=Regular, 2=VIP, 3=Admin, 4=Senior, 5=Owner");
        return;
    }

    char target[64];
    int level = -1;

    if (sscanf(args, "%63s %d", target, &level) < 2) {
        Admin_SendResponse(slot, "^1Usage: ^3!setlevel <player> <level>");
        return;
    }

    if (level < 0 || level > 5) {
        Admin_SendResponse(slot, "^1Invalid level. Must be 0-5.");
        return;
    }

    /* Can only set levels below your own */
    if (level >= caller->level && caller->level < ADMIN_LEVEL_OWNER) {
        Admin_SendResponse(slot, "^1Cannot set level >= your own (%d).", caller->level);
        return;
    }

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount != 1) {
        Admin_SendResponse(slot, matchCount == 0
            ? "^1No player found matching ^3%s"
            : "^1Multiple players match.", target);
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) return;

    if (targetPlayer->level >= caller->level && caller->level < ADMIN_LEVEL_OWNER) {
        Admin_SendResponse(slot, "^1Cannot modify ^3%s ^1- equal or higher level.", targetPlayer->name);
        return;
    }

    /* Update database */
    if (!DB_IsConnected()) {
        Admin_SendResponse(slot, "^1Database not available.");
        return;
    }

    PGconn *conn = DB_GetConnection();
    if (!conn) return;

    const char *query =
        "UPDATE admin_players SET level_id = "
        "(SELECT id FROM admin_levels WHERE level = $1) "
        "WHERE guid = $2";

    char levelStr[8];
    snprintf(levelStr, sizeof(levelStr), "%d", level);
    const char *params[2] = { levelStr, targetPlayer->guid };
    PGresult *res = PQexecParams(conn, query, 2, NULL, params, NULL, NULL, 0);

    if (PQresultStatus(res) == PGRES_COMMAND_OK) {
        targetPlayer->level = level;
        const char *levelNames[] = { "Guest", "Regular", "VIP", "Admin", "Senior Admin", "Owner" };
        Admin_SendResponse(255, "^3%s ^7set level of ^3%s ^7to ^2%d ^7(^3%s^7)",
            caller->name, targetPlayer->name, level, levelNames[level]);
    } else {
        Admin_SendResponse(slot, "^1Database error.");
    }

    PQclear(res);
}

/*
 * !listadmins - List online admins
 */
void Cmd_ListAdmins(int slot, AdminPlayer *caller, const char *args) {
    (void)caller;
    (void)args;

    Admin_SendResponse(slot, "^3=== Online Admins ===");

    int found = 0;
    for (int i = 0; i < ADMIN_MAX_PLAYERS; i++) {
        AdminPlayer *p = Admin_GetPlayer(i);
        if (!p || p->level < ADMIN_LEVEL_ADMIN) continue;

        const char *levelNames[] = { "Guest", "Regular", "VIP", "Admin", "Senior Admin", "Owner" };
        Admin_SendResponse(slot, "^7[%d] %s ^3(L%d %s)",
            i, p->name, p->level, levelNames[p->level]);
        found++;
    }

    if (found == 0) {
        Admin_SendResponse(slot, "^7No admins online.");
    }
}

/*
 * !finger <player> - Show player info
 */
void Cmd_Finger(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!finger <player>");
        return;
    }

    char target[64];
    sscanf(args, "%63s", target);

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount != 1) {
        Admin_SendResponse(slot, matchCount == 0
            ? "^1No player found matching ^3%s"
            : "^1Multiple players match.", target);
        return;
    }

    AdminPlayer *p = Admin_GetPlayer(matches[0]);
    if (!p) return;

    const char *levelNames[] = { "Guest", "Regular", "VIP", "Admin", "Senior Admin", "Owner" };
    const char *teamNames[] = { "Free", "Axis", "Allies", "Spectator" };

    Admin_SendResponse(slot, "^3=== Player Info ===");
    Admin_SendResponse(slot, "^7Name: %s", p->name);
    Admin_SendResponse(slot, "^7Slot: %d", p->slot);
    Admin_SendResponse(slot, "^7GUID: %s", p->guid);
    Admin_SendResponse(slot, "^7Team: %s", teamNames[p->team]);
    Admin_SendResponse(slot, "^7Level: %d (%s)", p->level, levelNames[p->level]);

    /* Show online time */
    time_t online = time(NULL) - p->connectTime;
    int hours = (int)(online / 3600);
    int mins = (int)((online % 3600) / 60);
    Admin_SendResponse(slot, "^7Online: %dh %dm", hours, mins);
}

/*
 * !aliases <player> - Show player name history
 */
void Cmd_Aliases(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!aliases <player>");
        return;
    }

    char target[64];
    sscanf(args, "%63s", target);

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount != 1) {
        Admin_SendResponse(slot, matchCount == 0
            ? "^1No player found matching ^3%s"
            : "^1Multiple players match.", target);
        return;
    }

    AdminPlayer *p = Admin_GetPlayer(matches[0]);
    if (!p || !DB_IsConnected()) {
        Admin_SendResponse(slot, "^1Data not available.");
        return;
    }

    PGconn *conn = DB_GetConnection();
    if (!conn) return;

    const char *query =
        "SELECT alias, times_used, last_used "
        "FROM admin_aliases "
        "WHERE player_id = (SELECT id FROM admin_players WHERE guid = $1) "
        "ORDER BY last_used DESC LIMIT 10";

    const char *params[1] = { p->guid };
    PGresult *res = PQexecParams(conn, query, 1, NULL, params, NULL, NULL, 0);

    Admin_SendResponse(slot, "^3=== Aliases for %s ===", p->name);

    if (PQresultStatus(res) == PGRES_TUPLES_OK) {
        int count = PQntuples(res);
        if (count == 0) {
            Admin_SendResponse(slot, "^7No aliases recorded.");
        } else {
            for (int i = 0; i < count; i++) {
                Admin_SendResponse(slot, "^7%s ^3(used %sx)",
                    PQgetvalue(res, i, 0),
                    PQgetvalue(res, i, 1));
            }
        }
    }

    PQclear(res);
}

/*
 * !stats [player] - Show player statistics
 */
void Cmd_Stats(int slot, AdminPlayer *caller, const char *args) {
    AdminPlayer *target = caller;

    /* If player name provided, look them up */
    if (args && args[0]) {
        char targetName[64];
        sscanf(args, "%63s", targetName);

        int matches[5];
        int matchCount = Admin_FindPlayer(targetName, matches, 5);

        if (matchCount == 0) {
            Admin_SendResponse(slot, "^1No player found matching ^3%s", targetName);
            return;
        } else if (matchCount > 1) {
            Admin_SendResponse(slot, "^1Multiple players match. Be more specific.");
            return;
        }

        target = Admin_GetPlayer(matches[0]);
        if (!target) return;
    }

    /* Show basic stats */
    Admin_SendResponse(slot, "^3=== Stats for %s ===", target->name);
    Admin_SendResponse(slot, "^7Slot: ^3%d ^7| Team: ^3%s ^7| Level: ^3%d",
        target->slot,
        target->team == ADMIN_TEAM_AXIS ? "Axis" :
        target->team == ADMIN_TEAM_ALLIES ? "Allies" :
        target->team == ADMIN_TEAM_SPECTATOR ? "Spec" : "?",
        target->level);

    /* Query database for more stats */
    if (DB_IsConnected() && target->guid[0]) {
        PGconn *conn = DB_GetConnection();
        if (conn) {
            const char *query =
                "SELECT p.times_seen, p.created_at, p.last_seen, "
                "(SELECT COUNT(*) FROM admin_warnings WHERE player_id = p.id) as warns, "
                "(SELECT COUNT(*) FROM admin_bans WHERE player_id = p.id) as bans "
                "FROM admin_players p WHERE p.guid = $1";

            const char *params[1] = { target->guid };
            PGresult *res = PQexecParams(conn, query, 1, NULL, params, NULL, NULL, 0);

            if (PQresultStatus(res) == PGRES_TUPLES_OK && PQntuples(res) > 0) {
                Admin_SendResponse(slot, "^7Times seen: ^3%s ^7| Warns: ^3%s ^7| Bans: ^3%s",
                    PQgetvalue(res, 0, 0),
                    PQgetvalue(res, 0, 3),
                    PQgetvalue(res, 0, 4));
            }
            PQclear(res);
        }
    }
}

/*
 * !spec999 - Force yourself to spectator (useful if stuck)
 */
void Cmd_Spec999(int slot, AdminPlayer *caller, const char *args) {
    (void)caller;
    (void)args;

    Admin_SendResponse(slot, "^3Moving you to spectator...");
    Admin_SendAction(ADMIN_ACTION_PUT, slot, "s");  /* "s" = spectator */
}

/*
 * !fling <player> [strength] - Fling player in random direction
 */
void Cmd_Fling(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!fling <player> [strength]");
        return;
    }

    char target[64];
    int strength = 1000;

    sscanf(args, "%63s %d", target, &strength);
    if (strength < 100) strength = 100;
    if (strength > 5000) strength = 5000;

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount == 0) {
        Admin_SendResponse(slot, "^1No player found matching ^3%s", target);
        return;
    } else if (matchCount > 1) {
        Admin_SendResponse(slot, "^1Multiple players match. Be more specific.");
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) return;

    char data[32];
    snprintf(data, sizeof(data), "%d", strength);

    Admin_SendResponse(255, "^3%s ^7was flung by ^3%s^7!", targetPlayer->name, caller->name);
    Admin_SendAction(ADMIN_ACTION_FLING, matches[0], data);
}

/*
 * !up <player> [strength] - Launch player into the sky
 */
void Cmd_Up(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!up <player> [strength]");
        return;
    }

    char target[64];
    int strength = 1000;

    sscanf(args, "%63s %d", target, &strength);
    if (strength < 100) strength = 100;
    if (strength > 5000) strength = 5000;

    int matches[5];
    int matchCount = Admin_FindPlayer(target, matches, 5);

    if (matchCount == 0) {
        Admin_SendResponse(slot, "^1No player found matching ^3%s", target);
        return;
    } else if (matchCount > 1) {
        Admin_SendResponse(slot, "^1Multiple players match. Be more specific.");
        return;
    }

    AdminPlayer *targetPlayer = Admin_GetPlayer(matches[0]);
    if (!targetPlayer) return;

    char data[32];
    snprintf(data, sizeof(data), "%d", strength);

    Admin_SendResponse(255, "^3%s ^7was launched by ^3%s^7!", targetPlayer->name, caller->name);
    Admin_SendAction(ADMIN_ACTION_UP, matches[0], data);
}

/*
 * !kickbots - Remove all bots from the server
 * Uses omnibot commands: bot maxbots -1 disables auto-fill, bot kickall removes all
 */
void Cmd_KickBots(int slot, AdminPlayer *caller, const char *args) {
    (void)args;

    Admin_SendResponse(255, "^3%s ^7kicked all bots.", caller->name);
    /* Disable auto-fill by setting maxbots to -1, set minbots to 0, then kick all */
    Admin_SendAction(ADMIN_ACTION_RCON, 0, "bot maxbots -1; bot minbots 0; bot kickall");
}

/*
 * !putbots [count] - Add bots to the server
 * Uses omnibot commands: bot minbots/maxbots to set population
 * Note: maxbots is TOTAL players (bots + humans), so we set it to count + current humans
 */
void Cmd_PutBots(int slot, AdminPlayer *caller, const char *args) {
    int count = 12;  /* default */

    if (args && args[0]) {
        count = atoi(args);
        if (count < 1) count = 1;
        if (count > 20) count = 20;
    }

    Admin_SendResponse(255, "^3%s ^7set bot count to ^3%d^7.", caller->name, count);

    /* minbots = desired bot count, maxbots = minbots (so it maintains exactly that many) */
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "bot minbots %d; bot maxbots %d", count, count);
    Admin_SendAction(ADMIN_ACTION_RCON, 0, cmd);
}

/*
 * Helper: Query server status to get elapsed time
 * Returns elapsed seconds, or -1 on error
 */
static int QueryElapsedTime(void) {
    int sock;
    struct sockaddr_in serverAddr;
    char response[2048];
    int len;
    struct timeval tv;

    sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) return -1;

    tv.tv_sec = 1;
    tv.tv_usec = 0;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    memset(&serverAddr, 0, sizeof(serverAddr));
    serverAddr.sin_family = AF_INET;
    serverAddr.sin_port = htons(27960);
    serverAddr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    /* Query server status */
    const char *request = "\xff\xff\xff\xff" "getstatus";
    if (sendto(sock, request, strlen(request), 0,
               (struct sockaddr *)&serverAddr, sizeof(serverAddr)) < 0) {
        close(sock);
        return -1;
    }

    len = recv(sock, response, sizeof(response) - 1, 0);
    close(sock);

    if (len <= 0) return -1;
    response[len] = '\0';

    /* Look for g_levelStartTime in response */
    char *p = strstr(response, "g_levelStartTime\\");
    if (p) {
        p += 17; /* Skip "g_levelStartTime\" */
        int startTime = atoi(p);

        /* Also need current server time - look for leveltime or similar */
        /* Actually getstatus doesn't give us current time directly */
    }

    /* Fallback: we can't get elapsed time from getstatus easily
     * Let's just return -1 and handle it in the command */
    return -1;
}

/*
 * !timeleft <mm:ss> - Set remaining time on the map
 * Sets timelimit so that remaining time equals specified value
 *
 * Since we can't easily query elapsed time, we use a workaround:
 * We query the server for current timelimit and time remaining via rcon status,
 * but that's complex. For simplicity, we'll just set timelimit to a low value
 * which will cause the map to end approximately when specified.
 *
 * Better approach: Add a C command "settimeleft" that does the calculation server-side.
 */
void Cmd_TimeLeft(int slot, AdminPlayer *caller, const char *args) {
    if (!args || !args[0]) {
        Admin_SendResponse(slot, "^1Usage: ^3!timeleft <mm:ss>");
        Admin_SendResponse(slot, "^7Example: ^3!timeleft 0:30 ^7(30 sec remaining)");
        return;
    }

    int minutes = 0, seconds = 0;

    /* Parse mm:ss format */
    if (strchr(args, ':')) {
        sscanf(args, "%d:%d", &minutes, &seconds);
    } else {
        /* Just seconds or just minutes */
        int val = atoi(args);
        if (val >= 60) {
            minutes = val;
            seconds = 0;
        } else {
            minutes = 0;
            seconds = val;
        }
    }

    if (minutes < 0) minutes = 0;
    if (seconds < 0) seconds = 0;
    if (minutes == 0 && seconds < 5) {
        seconds = 5; /* Minimum 5 seconds */
    }

    int totalSeconds = minutes * 60 + seconds;

    /* Use the settimeleft rcon command we'll add to the server */
    char cmd[64];
    snprintf(cmd, sizeof(cmd), "settimeleft %d", totalSeconds);

    Admin_SendResponse(255, "^3%s ^7set time remaining to ^3%d:%02d",
                       caller->name, minutes, seconds);
    Admin_SendAction(ADMIN_ACTION_RCON, 0, cmd);
}
