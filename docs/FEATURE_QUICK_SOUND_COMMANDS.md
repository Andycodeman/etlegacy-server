# Quick Sound Commands Feature - Implementation Plan

**Author:** Claude (AI Assistant)
**Requested by:** CandyPants
**Date:** January 2026
**Status:** Phase 1 ✅ Complete, Phase 2 ✅ Complete, Phase 3 ✅ Complete
**Version:** 1.3 (Phase 1 + Phase 2 + Phase 3 Implementation Complete)

---

## 1. Feature Overview

### 1.1 Summary
Allow players to trigger sound playback directly from in-game chat using a configurable prefix + quick command alias, with optional chat text replacement.

### 1.2 Example Flow
1. Player uses the default quick command prefix `@` (configurable via ETPanel)
2. Player assigns quick command alias `lol` to their "laugh" sound
3. Player sets chat text replacement to `LOLOL`
4. In-game, player types in chat: `@lol`
5. Server intercepts the message, recognizes the prefix + alias combo
6. Server plays the "laugh" sound to all players
7. **AND** broadcasts `LOLOL` as the player's chat message

### 1.3 Chat Text Replacement Options
- **With replacement text**: `@lol` → plays sound + shows "LOLOL" in chat
- **Empty replacement**: `@lol` → plays sound only (no chat message)
- The replacement text is per-alias, allowing different messages for each sound

### 1.4 Fallback Behavior
- If `@lol` doesn't match any of the player's quick command aliases, fall back to searching:
  1. Public sounds where alias matches exactly
  2. Public sounds where alias matches fuzzily (e.g., "lol" matches "lolcat")
- If no match found, let the chat message through normally (user may have meant to type `@lol` literally)
- **Note**: Public sound fallback does NOT have chat replacement (just plays sound, no chat)

---

## 2. Architecture Overview

### 2.1 Components to Modify

| Component | Location | Changes |
|-----------|----------|---------|
| **Database Schema** | `etpanel/backend/src/db/schema.ts` | Add `player_settings` table, `quick_command_aliases` table with `chat_text` |
| **ETPanel Backend** | `etpanel/backend/src/routes/sounds.ts` | New endpoints for quick command management |
| **ETPanel Frontend** | `etpanel/frontend/src/pages/MySounds.tsx` | UI for managing quick commands + chat text |
| **etman-server** | `etman-server/db_manager.c`, `sound_manager.c` | New DB queries, quick command lookup with chat text |
| **qagame C mod** | `src/src/game/g_etman.c`, `g_cmds.c` | Intercept chat, send to etman-server, handle replacement text |

### 2.2 Data Flow

```
Player types "*lol" in chat
         ↓
    [qagame C mod]
         ↓
    G_Say_f() intercepts chat text
         ↓
    G_ETMan_CheckQuickCommand() - new function
         ↓ (UDP packet to etman-server)
    [etman-server]
         ↓
    QuickCmd_Lookup(guid, "*lol")
         ↓
    1. Get player's prefix from player_settings
    2. If prefix matches start of message, extract alias
    3. Look up quick_command_aliases for player
    4. If found → play sound, return success + chat_text
    5. If not found → search public sounds (exact then fuzzy)
    6. If still not found → return "not found"
         ↓ (UDP response with chat_text)
    [qagame]
         ↓
    If handled with chat_text → send replacement as chat
    If handled without chat_text → suppress chat
    If not handled → let original chat through
```

---

## 3. Database Schema Changes

### 3.1 New Table: `player_settings`

Stores per-player configuration options (extensible for future settings).

```sql
CREATE TABLE player_settings (
    id              SERIAL PRIMARY KEY,
    guid            VARCHAR(32) NOT NULL UNIQUE,
    quick_cmd_prefix VARCHAR(4) NOT NULL DEFAULT '@',
    -- Future settings can be added here
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_player_settings_guid ON player_settings(guid);
```

**Notes:**
- `quick_cmd_prefix`: Default is `@` (since `!` is reserved for admin commands, `/` and `\` for console)
- Max 4 characters to prevent abuse
- Can be alphanumeric or special characters
- **BLOCKED PREFIXES**: `!` (admin commands) - see Section 3.4 for full list

### 3.2 New Table: `quick_command_aliases`

Maps a player's custom short alias to a sound they can access, with optional chat text.

```sql
CREATE TABLE quick_command_aliases (
    id              SERIAL PRIMARY KEY,
    guid            VARCHAR(32) NOT NULL,
    alias           VARCHAR(16) NOT NULL,      -- Short alias like "lol", "gg", "rekt"
    user_sound_id   INTEGER REFERENCES user_sounds(id) ON DELETE CASCADE,
    sound_file_id   INTEGER REFERENCES sound_files(id) ON DELETE CASCADE,
    is_public       BOOLEAN NOT NULL DEFAULT FALSE, -- True if pointing to public sound
    chat_text       VARCHAR(128),               -- Optional replacement text for chat (NULL = no chat)
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),

    CONSTRAINT unique_player_alias UNIQUE (guid, alias),
    CONSTRAINT valid_reference CHECK (
        (user_sound_id IS NOT NULL AND sound_file_id IS NULL AND is_public = FALSE) OR
        (user_sound_id IS NULL AND sound_file_id IS NOT NULL AND is_public = TRUE)
    )
);

CREATE INDEX idx_quick_cmd_guid ON quick_command_aliases(guid);
CREATE INDEX idx_quick_cmd_alias ON quick_command_aliases(guid, alias);
```

**Notes:**
- `alias`: Max 16 chars, alphanumeric + underscore only
- `chat_text`: Max 128 chars. NULL or empty = no chat message. Otherwise, this text is sent as chat.
- Either `user_sound_id` (player's own sound) OR `sound_file_id` (public sound) is set
- The CHECK constraint ensures data integrity

### 3.3 Drizzle Schema (TypeScript)

Add to `etpanel/backend/src/db/schema.ts`:

```typescript
// Player settings (quick command prefix and future settings)
export const playerSettings = pgTable(
  'player_settings',
  {
    id: serial('id').primaryKey(),
    guid: varchar('guid', { length: 32 }).notNull().unique(),
    quickCmdPrefix: varchar('quick_cmd_prefix', { length: 4 }).notNull().default('*'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    guidIdx: index('idx_player_settings_guid').on(table.guid),
  })
);

// Quick command aliases for chat-triggered sounds
export const quickCommandAliases = pgTable(
  'quick_command_aliases',
  {
    id: serial('id').primaryKey(),
    guid: varchar('guid', { length: 32 }).notNull(),
    alias: varchar('alias', { length: 16 }).notNull(),
    userSoundId: integer('user_sound_id')
      .references(() => userSounds.id, { onDelete: 'cascade' }),
    soundFileId: integer('sound_file_id')
      .references(() => soundFiles.id, { onDelete: 'cascade' }),
    isPublic: boolean('is_public').notNull().default(false),
    chatText: varchar('chat_text', { length: 128 }),  // Optional chat replacement
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    guidAliasIdx: uniqueIndex('quick_cmd_guid_alias_idx').on(table.guid, table.alias),
    guidIdx: index('quick_cmd_guid_idx').on(table.guid),
  })
);

// Type exports
export type PlayerSettings = typeof playerSettings.$inferSelect;
export type NewPlayerSettings = typeof playerSettings.$inferInsert;
export type QuickCommandAlias = typeof quickCommandAliases.$inferSelect;
export type NewQuickCommandAlias = typeof quickCommandAliases.$inferInsert;
```

### 3.4 Blocked Prefixes

The following prefixes are **BLOCKED** because they conflict with existing ET functionality:

| Prefix | Reason |
|--------|--------|
| `!` | Reserved for ETMan admin commands (`!kick`, `!ban`, etc.) |
| `/` | Console command prefix |
| `\` | Console command prefix (alternative) |

**Validation Logic:**
```typescript
const BLOCKED_PREFIXES = ['!', '/', '\\'];

function validatePrefix(prefix: string): { valid: boolean; error?: string } {
  if (!prefix || prefix.length === 0) {
    return { valid: false, error: 'Prefix cannot be empty' };
  }
  if (prefix.length > 4) {
    return { valid: false, error: 'Prefix must be 4 characters or less' };
  }
  if (/\s/.test(prefix)) {
    return { valid: false, error: 'Prefix cannot contain whitespace' };
  }
  for (const blocked of BLOCKED_PREFIXES) {
    if (prefix.startsWith(blocked)) {
      return { valid: false, error: `Prefix cannot start with "${blocked}" (reserved)` };
    }
  }
  return { valid: true };
}
```

---

## 4. ETPanel Backend API

### 4.1 New Endpoints

Add to `etpanel/backend/src/routes/sounds.ts` or create new `settings.ts`:

#### GET `/api/settings/quick-command`
Get player's quick command settings.

**Response:**
```json
{
  "prefix": "*",
  "aliases": [
    {
      "alias": "lol",
      "soundAlias": "laugh",
      "isPublic": false,
      "chatText": "LOLOL"
    },
    {
      "alias": "gg",
      "soundAlias": "good_game",
      "isPublic": true,
      "chatText": null
    }
  ]
}
```

#### PUT `/api/settings/quick-command/prefix`
Update quick command prefix.

**Request:**
```json
{ "prefix": "**" }
```

**Validation:**
- Length: 1-4 characters
- No whitespace
- Cannot start with blocked prefixes (`!`, `/`, `\`)

**Error Responses:**
- 400: `{"error": "Prefix cannot start with \"!\" (reserved for admin commands)"}`
- 400: `{"error": "Prefix must be 4 characters or less"}`

#### POST `/api/settings/quick-command/alias`
Create or update a quick command alias.

**Request:**
```json
{
  "alias": "lol",
  "soundAlias": "laugh",    // User's sound alias (optional if publicSoundId set)
  "publicSoundId": null,    // Public sound file ID (optional if soundAlias set)
  "chatText": "LOLOL"       // Optional - chat replacement text (null/empty = no chat)
}
```

**Validation:**
- `alias`: 1-16 chars, alphanumeric + underscore only
- `chatText`: 0-128 chars, optional
- Either `soundAlias` or `publicSoundId` must be provided
- Cannot duplicate existing alias for this player

#### PUT `/api/settings/quick-command/alias/:alias`
Update an existing quick command alias (e.g., just change chat text).

**Request:**
```json
{
  "chatText": "NEW TEXT HERE"
}
```

#### DELETE `/api/settings/quick-command/alias/:alias`
Remove a quick command alias.

---

## 5. ETPanel Frontend Changes

### 5.1 MySounds.tsx Modifications

#### 5.1.1 Sound Library Table Changes

Add new columns to display quick command alias and chat text:

| Alias | Quick Cmd | Chat Text | Size | Duration | Visibility | Actions |
|-------|-----------|-----------|------|----------|------------|---------|
| laugh | `(lol)` | "LOLOL" | 45 KB | 0:03 | 🔒 | ... |
| boom  | `(bang)` | — | 120 KB | 0:05 | 🌐 | ... |
| music | `(+)` | — | 2 MB | 1:30 | 🔒 | ... |

**UI Behavior:**
- Quick command shown in parentheses, cyan color
- `(+)` shown when no quick command assigned (clickable to add)
- Chat text shown in quotes, gray/muted color
- `—` shown when no chat text (sound only)
- Both columns are clickable to edit inline

#### 5.1.2 Quick Command Column Implementation

```tsx
// In the table row for each sound
<td className="px-4 py-2">
  {sound.quickCommand ? (
    <span
      className="text-cyan-400 cursor-pointer hover:text-cyan-300"
      onClick={() => openQuickCmdEditor(sound.alias)}
    >
      ({sound.quickCommand})
    </span>
  ) : (
    <span
      className="text-gray-500 cursor-pointer hover:text-gray-400"
      onClick={() => openQuickCmdEditor(sound.alias)}
    >
      (+)
    </span>
  )}
</td>
<td className="px-4 py-2">
  {sound.quickCommand ? (
    sound.chatText ? (
      <span
        className="text-gray-400 cursor-pointer hover:text-gray-300 truncate max-w-32"
        onClick={() => openChatTextEditor(sound.alias)}
        title={sound.chatText}
      >
        "{sound.chatText}"
      </span>
    ) : (
      <span
        className="text-gray-600 cursor-pointer hover:text-gray-500"
        onClick={() => openChatTextEditor(sound.alias)}
      >
        —
      </span>
    )
  ) : (
    <span className="text-gray-700">—</span>
  )}
</td>
```

#### 5.1.3 Quick Command Editor Modal

When clicking on the quick command or chat text, open a small editor modal:

```
┌─────────────────────────────────────────────────────┐
│ Quick Command for "laugh"                      [X]  │
├─────────────────────────────────────────────────────┤
│ Quick Alias: [lol_______]                           │
│ (Type *lol in chat to trigger)                      │
│                                                     │
│ Chat Text: [LOLOL___________________________]       │
│ (Optional - leave empty for sound only)             │
│                                                     │
│                          [Cancel] [Save]            │
└─────────────────────────────────────────────────────┘
```

#### 5.1.4 Settings Section

Add a settings panel (collapsible) at the top of MySounds page:

```
⚙️ Quick Command Settings
┌─────────────────────────────────────────────────────┐
│ Prefix: [*___]                                      │
│                                                     │
│ ℹ️ How it works:                                    │
│ Type your prefix + alias in chat to play a sound.  │
│ Example: *lol plays your sound and shows chat text │
│                                                     │
│ ⚠️ Blocked prefixes: ! (admin), / and \ (console)  │
└─────────────────────────────────────────────────────┘
```

### 5.2 API Client Updates

Add to `etpanel/frontend/src/api/client.ts`:

```typescript
export interface QuickCommandAlias {
  alias: string;
  soundAlias: string;
  isPublic: boolean;
  chatText: string | null;
}

export interface QuickCommandSettings {
  prefix: string;
  aliases: QuickCommandAlias[];
}

export const settings = {
  getQuickCommand: () =>
    api.get('/settings/quick-command').json<QuickCommandSettings>(),

  updatePrefix: (prefix: string) =>
    api.put('/settings/quick-command/prefix', { json: { prefix } }).json(),

  setQuickAlias: (
    alias: string,
    soundAlias?: string,
    publicSoundId?: number,
    chatText?: string | null
  ) =>
    api.post('/settings/quick-command/alias', {
      json: { alias, soundAlias, publicSoundId, chatText }
    }).json(),

  updateQuickAlias: (alias: string, updates: { chatText?: string | null }) =>
    api.put(`/settings/quick-command/alias/${alias}`, { json: updates }).json(),

  removeQuickAlias: (alias: string) =>
    api.delete(`/settings/quick-command/alias/${alias}`).json(),
};
```

---

## 6. etman-server Changes

### 6.1 New Packet Types

Add to `etman-server/sound_manager.h`:

```c
/* Quick command packets (qagame -> etman-server) */
#define VOICE_CMD_QUICK_LOOKUP    0x50  /* Look up quick command: <slot><guid><message> */
#define VOICE_RESP_QUICK_FOUND    0x51  /* Found: <slot><chatTextLen><chatText> */
#define VOICE_RESP_QUICK_NOTFOUND 0x52  /* Not found, let chat through */

#define QUICK_CMD_MAX_CHAT_TEXT   128   /* Max length of chat replacement text */
```

### 6.2 Database Queries

Add to `etman-server/db_manager.h`:

```c
/**
 * Quick command lookup result
 */
typedef struct {
    char    filePath[513];          /* Sound file path to play */
    char    chatText[129];          /* Chat replacement text (empty = no chat) */
    bool    hasChatText;            /* True if chatText should be sent */
} DBQuickCmdResult;

/**
 * Get player's quick command prefix.
 * @param guid Player GUID
 * @param outPrefix Output buffer (min 5 bytes)
 * @return true if found, false uses default "*"
 */
bool DB_GetQuickCmdPrefix(const char *guid, char *outPrefix);

/**
 * Look up a quick command alias for a player.
 * @param guid Player GUID
 * @param alias The alias to look up (e.g., "lol")
 * @param outResult Output struct with file path and chat text
 * @return true if found
 */
bool DB_LookupQuickCommand(const char *guid, const char *alias,
                           DBQuickCmdResult *outResult);

/**
 * Fuzzy search for public sounds by alias.
 * Note: Public fallback does NOT include chat text.
 * @param alias Partial alias to search
 * @param outFilePath Output buffer for sound file path
 * @param outLen Output buffer length
 * @return true if found
 */
bool DB_FuzzySearchPublicSound(const char *alias, char *outFilePath, int outLen);

/**
 * Check if a prefix is blocked (reserved for other systems).
 * @param prefix The prefix to check
 * @return true if blocked
 */
bool DB_IsPrefixBlocked(const char *prefix);
```

### 6.3 Implementation in db_manager.c

```c
// Blocked prefixes - must match frontend validation
static const char *BLOCKED_PREFIXES[] = { "!", "/", "\\", NULL };

bool DB_IsPrefixBlocked(const char *prefix) {
    if (!prefix || !prefix[0]) return true;

    for (int i = 0; BLOCKED_PREFIXES[i] != NULL; i++) {
        if (strncmp(prefix, BLOCKED_PREFIXES[i], strlen(BLOCKED_PREFIXES[i])) == 0) {
            return true;
        }
    }
    return false;
}

bool DB_GetQuickCmdPrefix(const char *guid, char *outPrefix) {
    if (!conn || !guid || !outPrefix) return false;

    char escaped[65];
    DB_EscapeString(guid, escaped, sizeof(escaped));

    char query[256];
    snprintf(query, sizeof(query),
        "SELECT quick_cmd_prefix FROM player_settings WHERE guid = '%s'",
        escaped);

    PGresult *res = PQexec(conn, query);
    if (PQresultStatus(res) != PGRES_TUPLES_OK || PQntuples(res) == 0) {
        PQclear(res);
        strcpy(outPrefix, "*");  // Default prefix (not !)
        return false;
    }

    strncpy(outPrefix, PQgetvalue(res, 0, 0), 4);
    outPrefix[4] = '\0';
    PQclear(res);
    return true;
}

bool DB_LookupQuickCommand(const char *guid, const char *alias,
                           DBQuickCmdResult *outResult) {
    if (!conn || !guid || !alias || !outResult) return false;

    memset(outResult, 0, sizeof(*outResult));

    char escapedGuid[65], escapedAlias[33];
    DB_EscapeString(guid, escapedGuid, sizeof(escapedGuid));
    DB_EscapeString(alias, escapedAlias, sizeof(escapedAlias));

    // Query: join quick_command_aliases with user_sounds/sound_files, get chat_text
    char query[768];
    snprintf(query, sizeof(query),
        "SELECT COALESCE(sf1.file_path, sf2.file_path) AS file_path, "
        "       qca.chat_text "
        "FROM quick_command_aliases qca "
        "LEFT JOIN user_sounds us ON qca.user_sound_id = us.id "
        "LEFT JOIN sound_files sf1 ON us.sound_file_id = sf1.id "
        "LEFT JOIN sound_files sf2 ON qca.sound_file_id = sf2.id "
        "WHERE qca.guid = '%s' AND LOWER(qca.alias) = LOWER('%s')",
        escapedGuid, escapedAlias);

    PGresult *res = PQexec(conn, query);
    if (PQresultStatus(res) != PGRES_TUPLES_OK || PQntuples(res) == 0) {
        PQclear(res);
        return false;
    }

    const char *path = PQgetvalue(res, 0, 0);
    if (!path || !path[0]) {
        PQclear(res);
        return false;
    }

    strncpy(outResult->filePath, path, sizeof(outResult->filePath) - 1);

    // Get chat text (may be NULL)
    if (!PQgetisnull(res, 0, 1)) {
        const char *chatText = PQgetvalue(res, 0, 1);
        if (chatText && chatText[0]) {
            strncpy(outResult->chatText, chatText, sizeof(outResult->chatText) - 1);
            outResult->hasChatText = true;
        }
    }

    PQclear(res);
    return true;
}

bool DB_FuzzySearchPublicSound(const char *alias, char *outFilePath, int outLen) {
    if (!conn || !alias || !outFilePath) return false;

    char escapedAlias[33];
    DB_EscapeString(alias, escapedAlias, sizeof(escapedAlias));

    // Exact match first on public sounds
    char query[512];
    snprintf(query, sizeof(query),
        "SELECT file_path FROM sound_files "
        "WHERE is_public = true AND LOWER(original_name) = LOWER('%s') "
        "LIMIT 1",
        escapedAlias);

    PGresult *res = PQexec(conn, query);
    if (PQresultStatus(res) == PGRES_TUPLES_OK && PQntuples(res) > 0) {
        strncpy(outFilePath, PQgetvalue(res, 0, 0), outLen - 1);
        outFilePath[outLen - 1] = '\0';
        PQclear(res);
        return true;
    }
    PQclear(res);

    // Fuzzy match (LIKE with prefix)
    snprintf(query, sizeof(query),
        "SELECT file_path FROM sound_files "
        "WHERE is_public = true AND LOWER(original_name) LIKE LOWER('%s%%') "
        "ORDER BY LENGTH(original_name) ASC LIMIT 1",
        escapedAlias);

    res = PQexec(conn, query);
    if (PQresultStatus(res) == PGRES_TUPLES_OK && PQntuples(res) > 0) {
        strncpy(outFilePath, PQgetvalue(res, 0, 0), outLen - 1);
        outFilePath[outLen - 1] = '\0';
        PQclear(res);
        return true;
    }
    PQclear(res);

    return false;
}
```

### 6.4 Handler in sound_manager.c

Add handler for `VOICE_CMD_QUICK_LOOKUP`:

```c
static void sendQuickFound(uint32_t clientId, const char *chatText) {
    uint8_t packet[256];
    int pos = 0;

    packet[pos++] = VOICE_RESP_QUICK_FOUND;
    packet[pos++] = (uint8_t)clientId;

    // Chat text length and content
    int chatLen = chatText ? strlen(chatText) : 0;
    if (chatLen > QUICK_CMD_MAX_CHAT_TEXT) chatLen = QUICK_CMD_MAX_CHAT_TEXT;
    packet[pos++] = (uint8_t)chatLen;

    if (chatLen > 0) {
        memcpy(&packet[pos], chatText, chatLen);
        pos += chatLen;
    }

    // Send to client via their address
    sendPacketToClient(clientId, packet, pos);
}

static void sendQuickNotFound(uint32_t clientId) {
    uint8_t packet[4];
    packet[0] = VOICE_RESP_QUICK_NOTFOUND;
    packet[1] = (uint8_t)clientId;
    sendPacketToClient(clientId, packet, 2);
}

static void handleQuickLookup(uint32_t clientId, const uint8_t *data, int dataLen) {
    // Parse: <slot:1><guid:32><messageLen:1><message:N>
    if (dataLen < 1 + SOUND_GUID_LEN + 2) return;

    int pos = 0;
    uint8_t slot = data[pos++];

    char guid[SOUND_GUID_LEN + 1];
    memcpy(guid, &data[pos], SOUND_GUID_LEN);
    guid[SOUND_GUID_LEN] = '\0';
    pos += SOUND_GUID_LEN;

    uint8_t msgLen = data[pos++];
    if (dataLen < pos + msgLen) return;

    char message[128];
    int copyLen = (msgLen < sizeof(message) - 1) ? msgLen : sizeof(message) - 1;
    memcpy(message, &data[pos], copyLen);
    message[copyLen] = '\0';

    // Get player's prefix
    char prefix[5];
    DB_GetQuickCmdPrefix(guid, prefix);

    // Check if message starts with prefix
    int prefixLen = strlen(prefix);
    if (strncmp(message, prefix, prefixLen) != 0) {
        // Doesn't start with prefix, not a quick command
        sendQuickNotFound(slot);
        return;
    }

    // Extract alias (everything after prefix)
    const char *alias = message + prefixLen;
    if (!alias[0]) {
        sendQuickNotFound(slot);
        return;
    }

    DBQuickCmdResult result;

    // Step 1: Look up player's quick command aliases
    if (DB_LookupQuickCommand(guid, alias, &result)) {
        // Found! Play the sound
        playQuickSound(slot, guid, result.filePath);
        // Send response with chat text (may be empty)
        sendQuickFound(slot, result.hasChatText ? result.chatText : NULL);
        return;
    }

    // Step 2: Search public sounds (exact match first)
    char filePath[513];
    if (DB_GetPublicSoundByName(alias, filePath, sizeof(filePath))) {
        playQuickSound(slot, guid, filePath);
        sendQuickFound(slot, NULL);  // No chat text for public fallback
        return;
    }

    // Step 3: Fuzzy search public sounds
    if (DB_FuzzySearchPublicSound(alias, filePath, sizeof(filePath))) {
        playQuickSound(slot, guid, filePath);
        sendQuickFound(slot, NULL);  // No chat text for public fallback
        return;
    }

    // Not found
    sendQuickNotFound(slot);
}
```

---

## 7. qagame C Mod Changes

### 7.1 New Definitions in g_etman.h

```c
/* Quick command packet types */
#define VOICE_CMD_QUICK_LOOKUP    0x50
#define VOICE_RESP_QUICK_FOUND    0x51
#define VOICE_RESP_QUICK_NOTFOUND 0x52

#define QUICK_CMD_MAX_CHAT_TEXT   128

/* Quick command pending state */
extern qboolean etman_pending_quick[MAX_CLIENTS];
extern char     etman_pending_chat[MAX_CLIENTS][MAX_SAY_TEXT];
extern int      etman_pending_mode[MAX_CLIENTS];  // SAY_ALL, SAY_TEAM, etc.

/* Check if a chat message is a quick sound command */
qboolean G_ETMan_CheckQuickCommand(gentity_t *ent, const char *chatText, int mode);
```

### 7.2 New Function in g_etman.c

```c
// Pending quick command state
qboolean etman_pending_quick[MAX_CLIENTS];
char     etman_pending_chat[MAX_CLIENTS][MAX_SAY_TEXT];
int      etman_pending_mode[MAX_CLIENTS];

// Characters that can start a quick command prefix
// Note: '!' is NOT included - reserved for admin commands
static const char *QUICK_PREFIX_CHARS = "*#$@~^&%+=";

/**
 * Check if a chat message might be a quick sound command.
 * Sends to etman-server for lookup, returns immediately.
 * The response is handled in G_ETMan_Frame().
 *
 * @param ent Player entity
 * @param chatText The chat message
 * @param mode Chat mode (SAY_ALL, SAY_TEAM, etc.)
 * @return qtrue if message was sent for lookup
 */
qboolean G_ETMan_CheckQuickCommand(gentity_t *ent, const char *chatText, int mode)
{
    if (!etman_initialized || !ent || !ent->client)
        return qfalse;

    // Skip if empty
    if (!chatText || !chatText[0])
        return qfalse;

    // Quick check: must start with a potential prefix character
    // Skip '!' - that's for admin commands
    char c = chatText[0];
    if (!strchr(QUICK_PREFIX_CHARS, c))
        return qfalse;

    int clientNum = ent - g_entities;

    // Build packet
    uint8_t packet[512];
    int pos = 0;

    packet[pos++] = VOICE_CMD_QUICK_LOOKUP;
    packet[pos++] = (uint8_t)clientNum;  // slot

    // GUID
    const char *guid = ent->client->sess.guid;
    memcpy(&packet[pos], guid, ADMIN_GUID_LEN);
    pos += ADMIN_GUID_LEN;

    // Message length and content
    int msgLen = strlen(chatText);
    if (msgLen > 127) msgLen = 127;
    packet[pos++] = (uint8_t)msgLen;
    memcpy(&packet[pos], chatText, msgLen);
    pos += msgLen;

    // Send to etman-server
    ETMan_SendPacket(packet, pos);

    // Mark this client as having a pending quick command lookup
    etman_pending_quick[clientNum] = qtrue;
    etman_pending_mode[clientNum] = mode;
    Q_strncpyz(etman_pending_chat[clientNum], chatText,
               sizeof(etman_pending_chat[0]));

    return qtrue;
}
```

### 7.3 Modify G_Say_f in g_cmds.c

```c
void G_Say_f(gentity_t *ent, int mode)
{
    const char *chatText;

    if (ent->client->sess.muted)
    {
        trap_SendServerCommand(ent - g_entities, "print \"Can't chat - you are muted\n\"");
        return;
    }

    if (trap_Argc() < 2)
    {
        return;
    }

    chatText = ConcatArgs(1);

    // ETMan: Check for !admin commands - suppress chat if command handled
    if (G_ETMan_CheckCommand(ent, chatText))
    {
        return;
    }

    // ETMan: Check for quick sound commands (prefix + alias)
    // This is async - if we send a lookup, we defer the chat
    if (G_ETMan_CheckQuickCommand(ent, chatText, mode))
    {
        // Message sent to etman-server for lookup
        // The actual chat will be handled in G_ETMan_Frame()
        // based on the response
        return;
    }

    G_Say(ent, NULL, mode, chatText);
}
```

### 7.4 Handle Response in G_ETMan_Frame

```c
// In G_ETMan_Frame(), add handling for quick command responses:

static void ETMan_HandleQuickFound(uint8_t *data, int len)
{
    if (len < 3) return;

    uint8_t slot = data[1];
    uint8_t chatTextLen = data[2];

    if (slot >= MAX_CLIENTS || !etman_pending_quick[slot])
        return;

    etman_pending_quick[slot] = qfalse;

    // If there's chat text, send it as the player's chat
    if (chatTextLen > 0 && len >= 3 + chatTextLen) {
        char chatText[QUICK_CMD_MAX_CHAT_TEXT + 1];
        int copyLen = (chatTextLen < QUICK_CMD_MAX_CHAT_TEXT) ? chatTextLen : QUICK_CMD_MAX_CHAT_TEXT;
        memcpy(chatText, &data[3], copyLen);
        chatText[copyLen] = '\0';

        gentity_t *ent = &g_entities[slot];
        if (ent->client) {
            G_Say(ent, NULL, etman_pending_mode[slot], chatText);
        }
    }
    // If no chat text, the sound plays but no chat is sent (silent)
}

static void ETMan_HandleQuickNotFound(uint8_t *data, int len)
{
    if (len < 2) return;

    uint8_t slot = data[1];

    if (slot >= MAX_CLIENTS || !etman_pending_quick[slot])
        return;

    etman_pending_quick[slot] = qfalse;

    // Not a valid quick command, send the original chat
    gentity_t *ent = &g_entities[slot];
    if (ent->client) {
        G_Say(ent, NULL, etman_pending_mode[slot], etman_pending_chat[slot]);
    }
}

// In the main packet handling switch:
case VOICE_RESP_QUICK_FOUND:
    ETMan_HandleQuickFound(buffer, recvLen);
    break;

case VOICE_RESP_QUICK_NOTFOUND:
    ETMan_HandleQuickNotFound(buffer, recvLen);
    break;
```

---

## 8. Implementation Phases

### Phase 1: Database & Backend API (4-6 hours)
1. Add database tables (`player_settings`, `quick_command_aliases` with `chat_text`)
2. Run Drizzle migrations
3. Implement backend API endpoints with prefix validation
4. Add blocked prefix checking
5. Test with curl/Postman

### Phase 2: Frontend UI (4-5 hours)
1. Add quick command and chat text columns to MySounds table
2. Implement quick command editor modal (alias + chat text)
3. Add settings panel for prefix configuration with blocked prefix warning
4. Update API client
5. Test in browser

### Phase 3: etman-server Changes (3-4 hours)
1. Add new packet types to header
2. Implement DB_GetQuickCmdPrefix() with default `*`
3. Implement DB_LookupQuickCommand() with chat_text
4. Implement DB_FuzzySearchPublicSound()
5. Add packet handler with chat text in response
6. Test with manual packets

### Phase 4: qagame C Mod Changes (3-4 hours)
1. Add G_ETMan_CheckQuickCommand() with prefix char filtering
2. Modify G_Say_f() to intercept quick commands
3. Handle async response with chat text replacement
4. Add pending command state tracking
5. Build and test on server

### Phase 5: Integration Testing (2-3 hours)
1. Test end-to-end: chat → lookup → play + chat replacement
2. Test empty chat text (sound only, no chat)
3. Test fallback to public sounds (no chat text)
4. Test blocked prefix rejection
5. Test edge cases
6. Performance testing

**Total Estimated Time: 16-22 hours**

---

## 9. Testing Checklist

### Unit Tests
- [ ] Prefix validation rejects `!`, `/`, `\`
- [ ] Prefix validation allows `*`, `#`, `$`, `**`, `abc`
- [ ] Alias validation (alphanumeric + underscore only)
- [ ] Chat text can be NULL, empty, or up to 128 chars
- [ ] DB_LookupQuickCommand returns file path and chat text
- [ ] DB_FuzzySearchPublicSound finds partial matches

### Integration Tests
- [ ] Player can set prefix via ETPanel (not `!`)
- [ ] Player can assign quick command with chat text
- [ ] Player can assign quick command without chat text
- [ ] Quick command + chat text shows in MySounds table
- [ ] Editing chat text updates in database
- [ ] Blocked prefix shows error message

### End-to-End Tests
- [ ] Chat `*lol` plays sound AND shows chat text
- [ ] Chat `*lol` with empty chat text plays sound only
- [ ] Chat `*unknown` falls back to public (sound only)
- [ ] Chat `*xyzzy123` with no match lets original chat through
- [ ] Chat `Hello` (no prefix) goes through normally
- [ ] Player with `!` prefix (impossible) - blocked at API level

---

## 10. Security Considerations

1. **Rate Limiting**: Apply same rate limits as regular sound play
2. **SQL Injection**: All queries use parameterized/escaped values
3. **Prefix Abuse**: Limit prefix length (max 4 chars), block reserved
4. **Alias Abuse**: Limit alias length (max 16 chars)
5. **Chat Text Abuse**: Limit to 128 chars, sanitize for ET color codes
6. **Message Length**: Truncate messages >127 chars in packets
7. **Authentication**: Verify player GUID matches their session

---

## 11. Future Enhancements

1. **Team-only sounds**: Add option to play sound only to team
2. **Cooldown per alias**: Individual cooldowns per quick command
3. **Sound preview**: Show which sound will play when typing prefix
4. **Alias suggestions**: Auto-suggest aliases based on sound name
5. **Import/Export**: Share quick command configurations
6. **Global defaults**: Server-wide default quick commands

---

## 12. Files to Modify (Summary)

### New Files
- `docs/FEATURE_QUICK_SOUND_COMMANDS.md` (this file)

### Backend (ETPanel)
- `etpanel/backend/src/db/schema.ts` - Add new tables with `chat_text`
- `etpanel/backend/src/routes/sounds.ts` or new `settings.ts` - API endpoints

### Frontend (ETPanel)
- `etpanel/frontend/src/pages/MySounds.tsx` - UI changes (2 columns + modal)
- `etpanel/frontend/src/api/client.ts` - API client updates

### etman-server (C)
- `etman-server/sound_manager.h` - New packet types
- `etman-server/db_manager.h` - New function declarations
- `etman-server/db_manager.c` - New DB queries with chat_text
- `etman-server/sound_manager.c` - Packet handler

### qagame (C)
- `src/src/game/g_etman.h` - New function declaration
- `src/src/game/g_etman.c` - Quick command handling with chat replacement
- `src/src/game/g_cmds.c` - Modify G_Say_f()

---

## 13. Notes for Implementation Session

**CandyPants' Requirements Recap:**
1. ✅ Per-player quick command prefix (single value in profile)
2. ✅ Prefix can be alphanumeric or special characters (1-4 chars)
3. ✅ Blocked prefixes: `!` (admin), `/` and `\` (console)
4. ✅ Per-player quick command aliases (maps alias to sound)
5. ✅ Per-alias chat text replacement (optional)
6. ✅ Empty chat text = sound only, no chat
7. ✅ Non-empty chat text = sound + replacement shown in chat
8. ✅ New database table for aliases with chat_text column
9. ✅ Chat interception in server mod
10. ✅ Fallback to public sounds (exact then fuzzy, no chat text)
11. ✅ Frontend UI in MySounds with quick cmd + chat text columns
12. ✅ Clickable to edit, show indicator when none set

**Critical Rules Reminder:**
- ❌ No git commands - CandyPants handles git
- ❌ No sed - use proper file editing
- ✅ Use build-all, deploy, publish scripts for finalization
- ✅ Follow existing code style
- ✅ Add comments for complex logic

---

*Document ready for implementation session handoff. v1.1 - Updated with chat text replacement and prefix restrictions.*
