# ETMan Admin Commands System - Implementation Plan

## Overview

Implement a Jaymod-style `!command` system with PostgreSQL-backed permissions, integrated with ETPanel for web-based administration.

**Architecture: Rename `voice-server` to `etman-server` - a unified sidecar process handling all extended features (voice, sounds, admin) with shared PostgreSQL access.**

---

## Goals

1. **In-game `!commands`** - Players type `!rotate`, `!nextmap`, `!kick player`, etc. in chat
2. **Permission levels** - Hierarchical levels (Guest, Regular, VIP, Admin, Senior Admin, Owner)
3. **Per-player permissions** - Override level permissions for specific players
4. **Fuzzy player matching** - `!kick eth` matches "Ethan" or "^1E^2than"
5. **PostgreSQL storage** - Shared with ETPanel for web integration
6. **ETPanel integration** - View/edit permissions, run commands from web UI
7. **GUID-based identification** - Persistent across name changes and sessions

---

## Architecture Decision: ETMan Server

### Why Rename voice-server to etman-server?

The current `voice-server` already handles:
- Voice chat relay (real-time audio)
- Sound file management (PostgreSQL)
- Playlists & sharing (PostgreSQL)
- Player verification codes (PostgreSQL)

Adding admin commands fits naturally. Rather than pretend it's still just a "voice server", we acknowledge it's the **ETMan sidecar** - handling all features that need:
- Database access (PostgreSQL via libpq)
- Persistent state across map changes
- Communication with both game server and ETPanel

### Module Organization

```
etman-server/                    # Renamed from voice-server
├── main.c                       # Entry point, UDP listener, module init
├── common/
│   ├── db.c                     # PostgreSQL connection pool
│   ├── db.h
│   ├── utils.c                  # Shared utilities (color strip, string helpers)
│   └── utils.h
├── voice/
│   ├── voice.c                  # Voice packet routing (existing)
│   └── voice.h
├── sounds/
│   ├── sound_manager.c          # Sound system (existing, reorganized)
│   ├── sound_manager.h
│   ├── db_manager.c             # Sound DB operations (existing, reorganized)
│   └── db_manager.h
├── admin/
│   ├── admin.c                  # Admin system init, command dispatch
│   ├── admin.h                  # Public API, packet definitions
│   ├── permissions.c            # Permission checking, level management
│   ├── permissions.h
│   ├── players.c                # Player tracking, GUID lookup, aliases
│   ├── players.h
│   ├── commands.c               # All !command implementations
│   └── commands.h
├── CMakeLists.txt
└── etman-server.service         # Renamed systemd service
```

---

## Refactoring Steps (Pre-requisite)

### Step 1: Rename voice-server → etman-server

```bash
# Directory rename
mv voice-server/ etman-server/

# Update all references:
# - CMakeLists.txt (target name)
# - systemd service file
# - publish.sh / deploy scripts
# - CLAUDE.md documentation
# - Any hardcoded paths
```

### Step 2: Reorganize into modules

```bash
# Create module directories
mkdir -p etman-server/{common,voice,sounds,admin}

# Move existing files
mv main.c → keep in root (or create modules that it calls)
mv db_manager.c → common/db.c (extract shared DB connection)
mv sound_manager.c → sounds/
mv db_manager.c sound-specific parts → sounds/db_manager.c

# Extract voice routing into voice/
# (currently embedded in main.c)
```

### Step 3: Extract shared database connection

Currently `db_manager.c` has both:
- Generic PostgreSQL connection management
- Sound-specific queries

Split into:
- `common/db.c` - Connection pool, generic query helpers
- `sounds/db_manager.c` - Sound-specific queries
- `admin/permissions.c` - Admin-specific queries

---

## Database Schema (PostgreSQL)

Add these tables to the existing `etlegacy` database:

```sql
-- Admin levels (hierarchical permission tiers)
CREATE TABLE admin_levels (
    id SERIAL PRIMARY KEY,
    level INTEGER NOT NULL UNIQUE,  -- 0=Guest, 1=Regular, 2=VIP, 3=Admin, 4=Senior, 5=Owner
    name VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Commands registry (all available !commands)
CREATE TABLE admin_commands (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,  -- 'rotate', 'kick', 'map', etc.
    description TEXT,
    usage VARCHAR(255),  -- '!kick <player> [reason]'
    default_level INTEGER NOT NULL DEFAULT 5,  -- minimum level required by default
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Level permissions (which levels can use which commands)
CREATE TABLE admin_level_permissions (
    level_id INTEGER REFERENCES admin_levels(id) ON DELETE CASCADE,
    command_id INTEGER REFERENCES admin_commands(id) ON DELETE CASCADE,
    PRIMARY KEY (level_id, command_id)
);

-- Players (identified by GUID)
CREATE TABLE admin_players (
    id SERIAL PRIMARY KEY,
    guid VARCHAR(32) NOT NULL UNIQUE,  -- ET cl_guid (32 hex chars)
    level_id INTEGER REFERENCES admin_levels(id) DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW(),
    times_seen INTEGER DEFAULT 1
);

-- Player aliases (name history with fuzzy search support)
CREATE TABLE admin_aliases (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES admin_players(id) ON DELETE CASCADE,
    alias VARCHAR(64) NOT NULL,  -- raw name with color codes
    clean_alias VARCHAR(64) NOT NULL,  -- stripped, lowercase for search
    last_used TIMESTAMP DEFAULT NOW(),
    times_used INTEGER DEFAULT 1
);
CREATE INDEX idx_aliases_clean ON admin_aliases(clean_alias);
CREATE INDEX idx_aliases_player ON admin_aliases(player_id);

-- Per-player permission overrides
CREATE TABLE admin_player_permissions (
    player_id INTEGER REFERENCES admin_players(id) ON DELETE CASCADE,
    command_id INTEGER REFERENCES admin_commands(id) ON DELETE CASCADE,
    granted BOOLEAN NOT NULL,  -- TRUE = grant, FALSE = revoke
    granted_by INTEGER REFERENCES admin_players(id),
    granted_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (player_id, command_id)
);

-- Command execution log (audit trail)
CREATE TABLE admin_command_log (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES admin_players(id),
    command VARCHAR(50) NOT NULL,
    args TEXT,
    target_player_id INTEGER REFERENCES admin_players(id),
    success BOOLEAN,
    executed_at TIMESTAMP DEFAULT NOW(),
    source VARCHAR(20) DEFAULT 'game'  -- 'game', 'etpanel', 'rcon'
);
CREATE INDEX idx_command_log_player ON admin_command_log(player_id);
CREATE INDEX idx_command_log_time ON admin_command_log(executed_at);

-- Bans
CREATE TABLE admin_bans (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES admin_players(id) ON DELETE CASCADE,
    banned_by INTEGER REFERENCES admin_players(id),
    reason TEXT,
    issued_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,  -- NULL = permanent
    active BOOLEAN DEFAULT TRUE
);
CREATE INDEX idx_bans_player ON admin_bans(player_id);
CREATE INDEX idx_bans_active ON admin_bans(active) WHERE active = TRUE;

-- Mutes
CREATE TABLE admin_mutes (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES admin_players(id) ON DELETE CASCADE,
    muted_by INTEGER REFERENCES admin_players(id),
    reason TEXT,
    issued_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    active BOOLEAN DEFAULT TRUE,
    voice_mute BOOLEAN DEFAULT FALSE
);

-- Warnings
CREATE TABLE admin_warnings (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES admin_players(id) ON DELETE CASCADE,
    warned_by INTEGER REFERENCES admin_players(id),
    reason TEXT NOT NULL,
    issued_at TIMESTAMP DEFAULT NOW()
);

-- Insert default levels
INSERT INTO admin_levels (level, name) VALUES
    (0, 'Guest'),
    (1, 'Regular'),
    (2, 'VIP'),
    (3, 'Admin'),
    (4, 'Senior Admin'),
    (5, 'Owner');
```

---

## Default Levels & Permissions

| Level | Name | Example Permissions |
|-------|------|---------------------|
| 0 | Guest | `help`, `time`, `maplist`, `admintest` |
| 1 | Regular | + `nextmap`, `stats` |
| 2 | VIP | + `players`, `spec999` |
| 3 | Admin | + `kick`, `mute`, `warn`, `rotate`, `map`, `restart` |
| 4 | Senior Admin | + `ban`, `setlevel`, `shuffle`, `slap`, `gib` |
| 5 | Owner | All commands |

---

## Commands List (Phase 1 - Core)

### Map/Server Commands
| Command | Usage | Level | Description |
|---------|-------|-------|-------------|
| `!rotate` | `!rotate` | 3 | Advance to next map |
| `!nextmap` | `!nextmap` | 1 | Show next map in rotation |
| `!map` | `!map <mapname>` | 3 | Change to specific map |
| `!maplist` | `!maplist` | 0 | Show map rotation |
| `!restart` | `!restart` | 3 | Restart current map |

### Player Management
| Command | Usage | Level | Description |
|---------|-------|-------|-------------|
| `!kick` | `!kick <player> [reason]` | 3 | Kick player |
| `!ban` | `!ban <player> <duration> [reason]` | 4 | Ban player |
| `!mute` | `!mute <player> [duration]` | 3 | Mute player chat |
| `!unmute` | `!unmute <player>` | 3 | Unmute player |
| `!warn` | `!warn <player> <reason>` | 3 | Warn player |
| `!slap` | `!slap <player> [damage]` | 4 | Slap player |
| `!gib` | `!gib <player>` | 4 | Gib player |
| `!put` | `!put <player> <team>` | 3 | Force to team |

### Info Commands
| Command | Usage | Level | Description |
|---------|-------|-------|-------------|
| `!help` | `!help [command]` | 0 | Show help |
| `!time` | `!time` | 0 | Server time |
| `!players` | `!players` | 2 | List players with IDs |
| `!finger` | `!finger <player>` | 3 | Player info |
| `!aliases` | `!aliases <player>` | 3 | Name history |

### Admin Commands
| Command | Usage | Level | Description |
|---------|-------|-------|-------------|
| `!setlevel` | `!setlevel <player> <level>` | 4 | Set admin level |
| `!admintest` | `!admintest` | 0 | Show your level |
| `!listadmins` | `!listadmins` | 3 | Online admins |

---

## Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         ETPanel (Web)                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Permissions │  │  Run Cmds   │  │    View Logs/Players    │  │
│  │   Editor    │  │   (API)     │  │                         │  │
│  └──────┬──────┘  └──────┬──────┘  └────────────┬────────────┘  │
└─────────┼────────────────┼──────────────────────┼───────────────┘
          │                │                      │
          ▼                ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PostgreSQL Database                         │
│  sound_files, user_sounds, playlists, admin_players, admin_*    │
└─────────────────────────────────────────────────────────────────┘
          ▲                                       ▲
          │                                       │
┌─────────┴───────────────────────────────────────┴───────────────┐
│                      ETMan Server (C)                            │
│                    (formerly voice-server)                       │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌──────────────┐  │
│  │  common/  │  │  voice/   │  │  sounds/  │  │    admin/    │  │
│  │   db.c    │  │ routing   │  │ manager   │  │  commands    │  │
│  │  utils.c  │  │           │  │ playlists │  │  permissions │  │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └──────┬───────┘  │
│        └──────────────┴──────────────┴───────────────┘          │
│                              ▲                                   │
│                              │ UDP                               │
└──────────────────────────────┼──────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────┐
│              Game Server (qagame.mp.*.so)                        │
│  ┌───────────────────────────┴───────────────────────────────┐  │
│  │  g_cmds.c: Intercepts "say" with ! prefix                 │  │
│  │  g_etman.c: UDP client to etman-server                    │  │
│  │                                                            │  │
│  │  Flow:                                                     │  │
│  │  1. Player types "!kick eth"                              │  │
│  │  2. qagame sends: ADMIN_CMD <slot> <guid> <name> kick eth │  │
│  │  3. etman-server checks perms, finds player               │  │
│  │  4. etman-server sends RCON: clientkick 3                 │  │
│  │  5. etman-server sends: ADMIN_RESP <slot> "Kicked Ethan"  │  │
│  │  6. qagame displays message to admin                      │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. UDP Protocol Extension

Add new packet types to existing protocol:

```c
// Packet types (add to existing)
#define PKT_ADMIN_CMD       0x20  // Game → ETMan: admin command
#define PKT_ADMIN_RESP      0x21  // ETMan → Game: response message
#define PKT_ADMIN_ACTION    0x22  // ETMan → Game: execute action
#define PKT_PLAYER_LIST     0x23  // Game → ETMan: current player list
#define PKT_PLAYER_UPDATE   0x24  // Game → ETMan: player connect/disconnect

// ADMIN_CMD packet
struct admin_cmd_packet {
    uint8_t type;           // PKT_ADMIN_CMD
    uint8_t client_slot;    // 0-63
    char guid[32];          // Player GUID
    char name[36];          // Player name (for alias tracking)
    char command[256];      // "kick eth" or "rotate"
};

// ADMIN_RESP packet
struct admin_resp_packet {
    uint8_t type;           // PKT_ADMIN_RESP
    uint8_t client_slot;    // Who to send message to
    char message[256];      // "^2Kicked Ethan"
};

// ADMIN_ACTION packet
struct admin_action_packet {
    uint8_t type;           // PKT_ADMIN_ACTION
    uint8_t action;         // ADMIN_ACTION_KICK, etc.
    uint8_t target_slot;    // Target player (if applicable)
    char data[256];         // Action-specific data
};

// Action types
#define ADMIN_ACTION_KICK       1
#define ADMIN_ACTION_BAN        2
#define ADMIN_ACTION_MUTE       3
#define ADMIN_ACTION_SLAP       4
#define ADMIN_ACTION_GIB        5
#define ADMIN_ACTION_PUT        6
#define ADMIN_ACTION_MAP        7
#define ADMIN_ACTION_RESTART    8
#define ADMIN_ACTION_RCON       9   // Raw rcon command
```

### 2. Game Server Integration (g_etman.c)

```c
// Intercept !commands in say
qboolean G_CheckAdminCommand(gentity_t *ent, const char *chatText) {
    if (chatText[0] != '!') return qfalse;

    int clientNum = ent - g_entities;
    char userinfo[MAX_INFO_STRING];
    char guid[33], name[MAX_NAME_LENGTH];

    trap_GetUserinfo(clientNum, userinfo, sizeof(userinfo));
    Q_strncpyz(guid, Info_ValueForKey(userinfo, "cl_guid"), sizeof(guid));
    Q_strncpyz(name, ent->client->pers.netname, sizeof(name));

    // Send to etman-server
    G_ETMan_SendAdminCmd(clientNum, guid, name, chatText + 1);

    return qtrue;  // Suppress chat message
}

// Handle response from etman-server
void G_ETMan_HandleAdminResp(int clientSlot, const char *message) {
    if (clientSlot >= 0 && clientSlot < MAX_CLIENTS) {
        trap_SendServerCommand(clientSlot, va("chat \"%s\"", message));
    }
}

// Handle action from etman-server
void G_ETMan_HandleAdminAction(int action, int targetSlot, const char *data) {
    switch (action) {
        case ADMIN_ACTION_KICK:
            trap_DropClient(targetSlot, data, 0);
            break;
        case ADMIN_ACTION_MAP:
            trap_SendConsoleCommand(EXEC_APPEND, va("map %s\n", data));
            break;
        case ADMIN_ACTION_SLAP:
            if (g_entities[targetSlot].client) {
                G_Damage(&g_entities[targetSlot], NULL, NULL, NULL, NULL,
                        atoi(data), DAMAGE_NO_PROTECTION, MOD_ADMKILL);
            }
            break;
        // ... etc
    }
}
```

### 3. ETMan Server Admin Handler (admin/admin.c)

```c
void Admin_HandleCommand(int clientSlot, const char *guid, const char *name,
                         const char *cmdText) {
    char cmd[64] = {0};
    char args[256] = {0};
    admin_player_t *player;

    // Parse command and args
    if (sscanf(cmdText, "%63s %255[^\n]", cmd, args) < 1) return;
    str_tolower(cmd);

    // Get or create player record
    player = Admin_GetOrCreatePlayer(guid);
    Admin_UpdatePlayerAlias(player, name);
    Admin_UpdateLastSeen(player);

    // Check permission
    if (!Admin_HasPermission(player, cmd)) {
        Admin_SendResponse(clientSlot,
            "^1You don't have permission to use ^3!%s", cmd);
        return;
    }

    // Find and execute command
    admin_cmd_handler_t *handler = Admin_FindCommand(cmd);
    if (handler) {
        handler->func(clientSlot, player, args);
        Admin_LogCommand(player, cmd, args);
    } else {
        Admin_SendResponse(clientSlot,
            "^1Unknown command: ^3!%s^1. Type ^3!help ^1for commands.", cmd);
    }
}
```

### 4. Fuzzy Player Matching (admin/players.c)

```c
// Match by: slot number, partial name, GUID prefix
int Admin_FindPlayer(const char *search, player_match_t *matches, int max) {
    int count = 0;
    char searchLower[64];

    strncpy(searchLower, search, sizeof(searchLower));
    str_tolower(searchLower);

    // Check slot number first
    char *endptr;
    long slot = strtol(search, &endptr, 10);
    if (*endptr == '\0' && slot >= 0 && slot < 64) {
        if (g_players[slot].connected) {
            matches[0].slot = slot;
            strncpy(matches[0].name, g_players[slot].name, MAX_NAME_LENGTH);
            return 1;
        }
    }

    // Fuzzy name match
    for (int i = 0; i < 64 && count < max; i++) {
        if (!g_players[i].connected) continue;

        char cleanName[MAX_NAME_LENGTH];
        Admin_StripColors(g_players[i].name, cleanName);
        str_tolower(cleanName);

        if (strstr(cleanName, searchLower)) {
            matches[count].slot = i;
            strncpy(matches[count].name, g_players[i].name, MAX_NAME_LENGTH);
            count++;
        }
    }

    return count;
}
```

---

## Files to Create/Modify

### Rename & Reorganize (Step 1)

```bash
# Rename directory
voice-server/ → etman-server/

# Update references in:
- scripts/build-all.sh
- scripts/publish.sh
- scripts/deploy.sh
- CLAUDE.md (both)
- etman-server/CMakeLists.txt (target name)
- etman-server/etman-server.service (was voice-server.service)
- VPS systemd (voice-server.service → etman-server.service)
```

### New Files

```
etman-server/
├── common/
│   ├── db.c                    # Extract from db_manager.c
│   ├── db.h
│   ├── utils.c                 # Color stripping, string helpers
│   └── utils.h
├── admin/
│   ├── admin.c                 # Command dispatch, init
│   ├── admin.h
│   ├── permissions.c           # Permission checks
│   ├── permissions.h
│   ├── players.c               # Player tracking, aliases
│   ├── players.h
│   ├── commands.c              # !command implementations
│   └── commands.h

src/src/game/
├── g_etman.c                   # UDP client (rename from voice parts)
└── g_etman.h

sql/
└── admin_schema.sql            # New tables

etpanel/backend/src/routes/
└── admin.ts                    # Admin API

etpanel/frontend/src/pages/
├── AdminPlayers.tsx
├── AdminPermissions.tsx
└── AdminLogs.tsx
```

### Modified Files

```
etman-server/
├── main.c                      # Add admin packet handling
├── CMakeLists.txt              # Add admin/ sources
├── sounds/sound_manager.c      # Reorganize (optional)
└── sounds/db_manager.c         # Reorganize (optional)

src/src/game/
├── g_cmds.c                    # Intercept !commands
├── g_main.c                    # Init etman connection
└── CMakeLists.txt              # Add g_etman.c

etpanel/
├── backend/src/index.ts        # Register admin routes
└── frontend/src/App.tsx        # Add admin pages
```

---

## Implementation Phases

### Phase 0: Refactor (Pre-requisite)
1. Rename voice-server → etman-server
2. Update all scripts and docs
3. Deploy and verify nothing breaks
4. (Optional) Reorganize into modules

### Phase 1: Core Admin System
1. Create database schema
2. Implement admin/ module in etman-server
3. Add UDP packet handlers
4. Implement basic commands: `!help`, `!admintest`, `!rotate`, `!nextmap`, `!maplist`
5. Add g_etman.c to qagame for !command interception

### Phase 2: Player Commands
1. Implement `!kick`, `!mute`, `!warn`
2. Add fuzzy player matching
3. Add alias tracking
4. Implement `!players`, `!finger`, `!aliases`

### Phase 3: Full Commands
1. Add `!ban`, `!slap`, `!gib`, `!put`
2. Add `!setlevel`, `!listadmins`
3. Command logging
4. Ban checking on connect

### Phase 4: ETPanel Integration
1. Add admin API routes
2. Create permissions editor UI
3. Player management UI
4. Command log viewer
5. Web command execution

---

## Security Considerations

1. **GUID Spoofing** - GUIDs can be changed; consider IP correlation for high-level admins
2. **Rate Limiting** - Prevent command spam (e.g., max 5 commands/10 sec)
3. **Audit Trail** - Log all admin actions
4. **Level Caps** - Can only setlevel to below your own level
5. **ETPanel Auth** - Web commands require authenticated session

---

## References

- WolfAdmin schema: `src/build/legacy/wolfadmin/database/new/sqlite.sql`
- Existing voice-server: `voice-server/main.c`
- Existing sound system: `voice-server/sound_manager.c`
- ET:Legacy game code: `src/src/game/g_cmds.c`
