# Voice Server Custom Sounds Upgrade - Implementation Plan

> **Project:** ET:Legacy Voice Server Sound Management System
> **Created:** 2025-12-27
> **Status:** In Progress
> **Last Updated:** 2025-12-28

---

## Overview

This document outlines the implementation plan for upgrading the ET:Legacy voice server custom sounds system to use PostgreSQL database integration, add playlist/category support, and create ETPanel web interface for sound management.

### Current State
- Voice server (`voice-server/`) written in C, uses file-based storage (`sounds/<guid>/<name>.mp3`)
- ETPanel already uses PostgreSQL with Drizzle ORM
- Basic sound commands exist: `/etman add`, `/etman play`, `/etman list`, `/etman delete`, `/etman rename`
- Sounds stored per-player by GUID with 100 sound limit per user

### Goals
1. **Database Integration**: Migrate sound metadata to PostgreSQL while keeping MP3 files on disk
2. **Playlist/Category System**: Allow users to organize sounds into named playlists
3. **Ordered Playback**: Support `/etman playlist <name> <#>` to play by position
4. **Sharing System**: Private (default), shared (with approval), public sounds
5. **ETPanel Integration**: Web UI for managing sounds, playlists, sharing

---

## Progress Tracking Legend

| Symbol | Status |
|--------|--------|
| ⬜ | Not Started |
| 🔄 | In Progress |
| ✅ | Completed |
| ❌ | Blocked |
| 🔍 | Needs Review |

---

## Phase 1: Database Schema Design

### 1.1 Architecture Overview

**Key Design Principle:** Separate actual sound files from user references using junction tables.

This enables:
- Multiple users can reference the same file (shared/public sounds)
- Deleting from a user's list only removes their reference, not the file
- Files only deleted when no references remain (or marked for cleanup)
- Each user has their own alias for any sound they reference

```
┌─────────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│   sound_files   │◄──────│   user_sounds        │──────►│     users       │
│   (actual MP3s) │       │   (junction table)   │       │   (by GUID)     │
└─────────────────┘       └──────────────────────┘       └─────────────────┘
        │                          │
        │                          ▼
        │                 ┌──────────────────────┐
        │                 │ sound_playlist_items │
        │                 └──────────────────────┘
        │                          │
        │                          ▼
        │                 ┌──────────────────────┐
        └────────────────►│   sound_playlists    │
                          └──────────────────────┘
```

### 1.2 Core Tables ⬜

#### `sound_files` table
Master table for actual MP3 files on disk. One entry per unique file.

```sql
CREATE TABLE sound_files (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(64) NOT NULL,          -- Unique filename (UUID or hash-based)
  original_name VARCHAR(64) NOT NULL,     -- Original upload name
  file_path VARCHAR(512) NOT NULL UNIQUE, -- Full path to MP3 file
  file_size INTEGER NOT NULL,             -- File size in bytes
  duration_seconds INTEGER,               -- Duration (calculated on add)
  added_by_guid VARCHAR(32) NOT NULL,     -- Who originally uploaded this file
  reference_count INTEGER DEFAULT 1,      -- How many user_sounds reference this
  is_public BOOLEAN DEFAULT FALSE,        -- Available in public library
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX idx_sound_files_public ON sound_files(is_public) WHERE is_public = TRUE;
CREATE INDEX idx_sound_files_added_by ON sound_files(added_by_guid);
```

#### `user_sounds` table (Junction Table)
Links users to sound files with their personal alias. This is the user's "sound library".

```sql
CREATE TABLE user_sounds (
  id SERIAL PRIMARY KEY,
  guid VARCHAR(32) NOT NULL,              -- User's ET GUID
  sound_file_id INTEGER REFERENCES sound_files(id) ON DELETE RESTRICT,
  alias VARCHAR(32) NOT NULL,             -- User's custom name for this sound
  visibility VARCHAR(10) DEFAULT 'private' NOT NULL,  -- 'private', 'shared', 'public'
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(guid, alias),                    -- Each user has unique aliases
  UNIQUE(guid, sound_file_id)             -- User can only have one ref to each file
);
CREATE INDEX idx_user_sounds_guid ON user_sounds(guid);
CREATE INDEX idx_user_sounds_file ON user_sounds(sound_file_id);
```

#### `sound_playlists` table
User-created playlists/categories.

```sql
CREATE TABLE sound_playlists (
  id SERIAL PRIMARY KEY,
  guid VARCHAR(32) NOT NULL,              -- Owner's ET GUID (or 'PUBLIC' for public playlists)
  name VARCHAR(32) NOT NULL,              -- Playlist name
  description TEXT,
  is_public BOOLEAN DEFAULT FALSE,        -- True = server-wide public playlist
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(guid, name)
);
CREATE INDEX idx_playlists_guid ON sound_playlists(guid);
CREATE INDEX idx_playlists_public ON sound_playlists(is_public) WHERE is_public = TRUE;
```

#### `sound_playlist_items` table
Many-to-many between playlists and user_sounds with ordering.

```sql
CREATE TABLE sound_playlist_items (
  id SERIAL PRIMARY KEY,
  playlist_id INTEGER REFERENCES sound_playlists(id) ON DELETE CASCADE,
  user_sound_id INTEGER REFERENCES user_sounds(id) ON DELETE CASCADE,
  order_number INTEGER NOT NULL,          -- User-editable order
  added_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(playlist_id, user_sound_id)
);
CREATE INDEX idx_playlist_items_playlist ON sound_playlist_items(playlist_id);
```

#### `sound_shares` table
Track pending and accepted share requests between users.

```sql
CREATE TABLE sound_shares (
  id SERIAL PRIMARY KEY,
  sound_file_id INTEGER REFERENCES sound_files(id) ON DELETE CASCADE,
  from_guid VARCHAR(32) NOT NULL,         -- Who shared it
  to_guid VARCHAR(32) NOT NULL,           -- Who it's shared with
  suggested_alias VARCHAR(32),            -- Suggested name for recipient
  status VARCHAR(10) DEFAULT 'pending' NOT NULL,  -- 'pending', 'accepted', 'rejected'
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  responded_at TIMESTAMP,
  UNIQUE(sound_file_id, from_guid, to_guid)  -- One share request per file per pair
);
CREATE INDEX idx_shares_to_guid ON sound_shares(to_guid);
CREATE INDEX idx_shares_status ON sound_shares(status);
CREATE INDEX idx_shares_pending ON sound_shares(to_guid, status) WHERE status = 'pending';
```

### 1.3 Deletion Logic ⬜

**Critical: File deletion rules**

When a user deletes a sound from their library:

1. **Check visibility:**
   - If `visibility = 'private'` AND `reference_count = 1`:
     - Delete the `user_sounds` entry
     - Delete the `sound_files` entry
     - Delete the actual MP3 file from disk
   - If `visibility = 'shared'` OR `visibility = 'public'` OR `reference_count > 1`:
     - Only delete the `user_sounds` entry
     - Decrement `reference_count` on `sound_files`
     - File stays on disk for other users

2. **Cleanup job (optional):**
   - Periodic task to find `sound_files` with `reference_count = 0`
   - Delete orphaned files after grace period (e.g., 24 hours)

```sql
-- Example: Safe delete function
CREATE OR REPLACE FUNCTION delete_user_sound(p_user_sound_id INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
  v_sound_file_id INTEGER;
  v_visibility VARCHAR(10);
  v_ref_count INTEGER;
  v_file_path VARCHAR(512);
BEGIN
  -- Get the sound file info
  SELECT us.sound_file_id, us.visibility, sf.reference_count, sf.file_path
  INTO v_sound_file_id, v_visibility, v_ref_count, v_file_path
  FROM user_sounds us
  JOIN sound_files sf ON sf.id = us.sound_file_id
  WHERE us.id = p_user_sound_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Delete user's reference
  DELETE FROM user_sounds WHERE id = p_user_sound_id;

  -- Decrement reference count
  UPDATE sound_files SET reference_count = reference_count - 1
  WHERE id = v_sound_file_id;

  -- If private and was only reference, mark for deletion
  IF v_visibility = 'private' AND v_ref_count = 1 THEN
    -- Delete sound_files entry (triggers file cleanup)
    DELETE FROM sound_files WHERE id = v_sound_file_id;
    -- Note: Actual file deletion handled by application
    RETURN TRUE;  -- Indicates file should be deleted
  END IF;

  RETURN FALSE;  -- File should NOT be deleted
END;
$$ LANGUAGE plpgsql;
```

### 1.4 Adding Sounds Workflow ⬜

**When user adds a new sound (upload/URL):**
1. Create entry in `sound_files` (new MP3 file)
2. Create entry in `user_sounds` linking user to that file
3. Set `reference_count = 1`

**When user adds from public library:**
1. Find existing `sound_files` entry
2. Create new `user_sounds` entry for this user
3. Increment `reference_count`
4. No file copy needed!

**When user accepts a share:**
1. Find the `sound_files` from the share
2. Create new `user_sounds` entry
3. Increment `reference_count`
4. Update share status to 'accepted'

### 1.5 Making Sound Public ⬜

When user marks their sound as `visibility = 'public'`:
1. Update `user_sounds.visibility` to 'public'
2. Set `sound_files.is_public = TRUE`
3. Sound now appears in public library

When admin removes from public:
1. Set `sound_files.is_public = FALSE`
2. Update `user_sounds.visibility` to 'private' for owner
3. Other users who added it keep their copies (with visibility 'private')

### 1.6 Drizzle Schema (TypeScript) ✅

Added to `etpanel/backend/src/db/schema.ts`:

- [x] `soundFiles` table definition (with indexes for public/addedBy)
- [x] `userSounds` table definition (junction with proper unique indexes)
- [x] `soundPlaylists` table definition (with currentPosition for playback tracking)
- [x] `soundPlaylistItems` table definition
- [x] `soundShares` table definition
- [x] `verificationCodes` table for in-game registration
- [x] Updated `users` table with optional `guid` field
- [x] Relations between tables
- [x] Type exports for all new tables

```typescript
// Sound files - actual MP3s on disk
export const soundFiles = pgTable('sound_files', {
  id: serial('id').primaryKey(),
  filename: varchar('filename', { length: 64 }).notNull(),
  originalName: varchar('original_name', { length: 64 }).notNull(),
  filePath: varchar('file_path', { length: 512 }).notNull().unique(),
  fileSize: integer('file_size').notNull(),
  durationSeconds: integer('duration_seconds'),
  addedByGuid: varchar('added_by_guid', { length: 32 }).notNull(),
  referenceCount: integer('reference_count').default(1).notNull(),
  isPublic: boolean('is_public').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// User sounds - junction table linking users to files
export const userSounds = pgTable('user_sounds', {
  id: serial('id').primaryKey(),
  guid: varchar('guid', { length: 32 }).notNull(),
  soundFileId: integer('sound_file_id').references(() => soundFiles.id).notNull(),
  alias: varchar('alias', { length: 32 }).notNull(),
  visibility: varchar('visibility', { length: 10 }).default('private').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  guidAliasIdx: uniqueIndex('user_sounds_guid_alias_idx').on(table.guid, table.alias),
  guidFileIdx: uniqueIndex('user_sounds_guid_file_idx').on(table.guid, table.soundFileId),
}));

// Playlists
export const soundPlaylists = pgTable('sound_playlists', {
  id: serial('id').primaryKey(),
  guid: varchar('guid', { length: 32 }).notNull(),
  name: varchar('name', { length: 32 }).notNull(),
  description: text('description'),
  isPublic: boolean('is_public').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  guidNameIdx: uniqueIndex('playlists_guid_name_idx').on(table.guid, table.name),
}));

// Playlist items
export const soundPlaylistItems = pgTable('sound_playlist_items', {
  id: serial('id').primaryKey(),
  playlistId: integer('playlist_id').references(() => soundPlaylists.id, { onDelete: 'cascade' }).notNull(),
  userSoundId: integer('user_sound_id').references(() => userSounds.id, { onDelete: 'cascade' }).notNull(),
  orderNumber: integer('order_number').notNull(),
  addedAt: timestamp('added_at').defaultNow().notNull(),
}, (table) => ({
  playlistSoundIdx: uniqueIndex('playlist_sound_idx').on(table.playlistId, table.userSoundId),
}));

// Share requests
export const soundShares = pgTable('sound_shares', {
  id: serial('id').primaryKey(),
  soundFileId: integer('sound_file_id').references(() => soundFiles.id, { onDelete: 'cascade' }).notNull(),
  fromGuid: varchar('from_guid', { length: 32 }).notNull(),
  toGuid: varchar('to_guid', { length: 32 }).notNull(),
  suggestedAlias: varchar('suggested_alias', { length: 32 }),
  status: varchar('status', { length: 10 }).default('pending').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  respondedAt: timestamp('responded_at'),
}, (table) => ({
  shareUniqueIdx: uniqueIndex('share_unique_idx').on(table.soundFileId, table.fromGuid, table.toGuid),
}));
```

### 1.7 Migration Script ✅

- [x] Migration file created: `0002_bitter_otto_octavius.sql`
- [x] Migration run on VPS (2025-12-27)
- [ ] Create migration script to import existing sounds from filesystem

**Tables created on VPS:**
- `sound_files` - Centralized MP3 storage
- `user_sounds` - User-file junction table
- `sound_playlists` - Playlist definitions
- `sound_playlist_items` - Playlist contents
- `sound_shares` - Share requests
- `verification_codes` - In-game registration

---

## Phase 2: Voice Server C Updates

### 2.1 PostgreSQL Integration ✅

**Files to modify:** `voice-server/sound_manager.c`, `voice-server/sound_manager.h`

- [x] Add libpq dependency to CMakeLists.txt
- [x] Create database connection module (`db_manager.c/.h`)
- [x] Environment variable for DATABASE_URL
- [x] Connection pooling (or single persistent connection)
- [x] Query helper functions

**Completed 2025-12-27:**
- Created `db_manager.h` with full API for all database operations
- Created `db_manager.c` with libpq implementation
- Updated `CMakeLists.txt` with libpq and uuid dependencies
- Integrated DB initialization in `SoundMgr_Init()`
- Added fallback to filesystem mode when DATABASE_URL not set
- Build tested successfully

### 2.2 Updated Sound Commands ✅

**New packet types added to `sound_manager.h`:**

```c
/* Phase 2: Playlist and visibility commands */
#define VOICE_CMD_SOUND_PLAYLIST_CREATE   0x19  /* Create playlist: <guid><name> */
#define VOICE_CMD_SOUND_PLAYLIST_DELETE   0x1A  /* Delete playlist: <guid><name> */
#define VOICE_CMD_SOUND_PLAYLIST_LIST     0x1B  /* List playlists: <guid> */
#define VOICE_CMD_SOUND_PLAYLIST_ADD      0x1C  /* Add to playlist: <guid><playlist><sound> */
#define VOICE_CMD_SOUND_PLAYLIST_REMOVE   0x1D  /* Remove from playlist: <guid><playlist><sound> */
#define VOICE_CMD_SOUND_PLAYLIST_REORDER  0x1E  /* Reorder: <guid><playlist><order> */
#define VOICE_CMD_SOUND_PLAYLIST_PLAY     0x1F  /* Play by position: <guid><playlist><#> */
#define VOICE_CMD_SOUND_CATEGORIES        0x20  /* Alias for playlist list */
#define VOICE_CMD_SOUND_SET_VISIBILITY    0x21  /* Set visibility: <guid><name><visibility> */
#define VOICE_CMD_SOUND_PUBLIC_LIST       0x22  /* List public sounds */
#define VOICE_CMD_SOUND_PUBLIC_ADD        0x23  /* Add from public: <guid><soundFileId><alias> */
#define VOICE_CMD_SOUND_PENDING           0x24  /* List pending shares: <guid> */

/* Phase 7: Registration commands */
#define VOICE_CMD_ACCOUNT_REGISTER        0x30  /* Request registration code: <guid><playerName> */
#define VOICE_RESP_REGISTER_CODE          0x31  /* Registration code response */
```

### 2.3 Database Query Functions ✅

**Implemented in `db_manager.c`:**

- [x] `DB_Init()` - Initialize PostgreSQL connection
- [x] `DB_Shutdown()` - Close connection
- [x] `DB_IsConnected()` - Check connection status
- [x] `DB_Reconnect()` - Reconnect if disconnected
- [x] `DB_AddSound()` - Insert new sound record (sound_files + user_sounds)
- [x] `DB_GetSoundByAlias()` - Lookup sound for playback
- [x] `DB_ListSounds()` - Get user's sounds (ordered alphabetically)
- [x] `DB_GetSoundCount()` - Count user's sounds
- [x] `DB_DeleteSound()` - Remove sound record (handles reference counting)
- [x] `DB_RenameSound()` - Update alias
- [x] `DB_SetVisibility()` - Change sound visibility
- [x] `DB_ListPublicSounds()` - Get public library
- [x] `DB_AddFromPublic()` - Add public sound to user's list
- [x] `DB_CreatePlaylist()` - New playlist
- [x] `DB_DeletePlaylist()` - Remove playlist
- [x] `DB_ListPlaylists()` - Get user's playlists
- [x] `DB_GetPlaylistSounds()` - Get sounds in playlist
- [x] `DB_AddToPlaylist()` - Add sound to playlist with order
- [x] `DB_RemoveFromPlaylist()` - Remove from playlist
- [x] `DB_ReorderPlaylist()` - Update order numbers
- [x] `DB_GetPlaylistPosition()` / `DB_SetPlaylistPosition()` - Track playback position
- [x] `DB_GetPlaylistSoundAtPosition()` - Get sound for playback
- [x] `DB_CreateShare()` - Create share request
- [x] `DB_ListPendingShares()` - List pending share requests
- [x] `DB_AcceptShare()` / `DB_RejectShare()` - Handle share responses
- [x] `DB_CreateVerificationCode()` - Generate registration code
- [x] `DB_VerifyCode()` / `DB_MarkCodeUsed()` - Verify and consume codes

### 2.4 Packet Handler Integration ✅

**All new handlers wired up in `SoundMgr_HandlePacket()`:**

- [x] Playlist handlers: CREATE, DELETE, LIST, ADD, REMOVE, PLAY
- [x] Visibility handler: SET_VISIBILITY
- [x] Public library handlers: PUBLIC_LIST, PUBLIC_ADD
- [x] Share handlers: SHARE, ACCEPT, REJECT, PENDING
- [x] Registration handler: ACCOUNT_REGISTER
- [x] Added `SoundMgr_PlaySoundByPath()` for DB-mode playback
- [x] All handlers check `g_soundMgr.dbMode` and return error if DB not available
- [x] Build tested successfully

---

## Phase 2.5: In-Game Commands (cgame) ✅

**Implemented in `cg_etman.c/h` (2025-12-27):**

All packet types and command handlers added. New commands available:

**Playlists:**
- `/etman playlists` - List all playlists
- `/etman playlist create <name>` - Create playlist
- `/etman playlist delete <name>` - Delete playlist
- `/etman playlist add <playlist> <sound>` - Add sound
- `/etman playlist remove <playlist> <sound>` - Remove sound
- `/etman playlist <name> <#>` - Play by position

**Sharing:**
- `/etman share <name> <player>` - Share with player
- `/etman pending` - List pending shares
- `/etman accept <id> [alias]` - Accept share
- `/etman reject <id>` - Reject share

**Visibility & Public:**
- `/etman visibility <name> <private|shared|public>` - Set visibility
- `/etman public [page]` - Browse public sounds
- `/etman getpublic <id> <alias>` - Add from public library

**Registration:**
- `/etman register` - Get ETPanel registration code

Build tested successfully.

---

## Phase 2.6: Original Command Reference ⬜

**Original commands for reference:**

| Command | Description |
|---------|-------------|
| `/etman playlist create <name>` | Create new playlist |
| `/etman playlist delete <name>` | Delete playlist |
| `/etman playlist add <playlist> <sound>` | Add sound to playlist |
| `/etman playlist remove <playlist> <sound>` | Remove from playlist |
| `/etman playlist <name>` | List sounds in playlist |
| `/etman playlist <name> <#>` | Play sound by position number |
| `/etman playlists` | List all your playlists |
| `/etman categories` | Alias for playlists |
| `/etman public` | List public sounds |
| `/etman visibility <sound> <private/shared/public>` | Change visibility |
| `/etman accept <from> <sound>` | Accept shared sound |
| `/etman reject <from> <sound>` | Reject shared sound |
| `/etman pending` | List pending share requests |

---

## Phase 3: ETPanel Backend API ✅

### 3.1 New API Routes ✅

**File:** `etpanel/backend/src/routes/sounds.ts` (created 2025-12-27)

#### User Sound Management
- [x] `GET /api/sounds` - List current user's sounds
- [x] `GET /api/sounds/:alias` - Get sound details
- [x] `PATCH /api/sounds/:alias` - Rename sound
- [x] `DELETE /api/sounds/:alias` - Delete sound
- [x] `PATCH /api/sounds/:alias/visibility` - Change visibility

#### Playlist Management
- [x] `GET /api/sounds/playlists` - List user's playlists
- [x] `GET /api/sounds/playlists/:name` - Get playlist with sounds
- [x] `POST /api/sounds/playlists` - Create playlist
- [x] `DELETE /api/sounds/playlists/:name` - Delete playlist
- [x] `POST /api/sounds/playlists/:name/sounds` - Add sound to playlist
- [x] `DELETE /api/sounds/playlists/:name/sounds/:soundAlias` - Remove from playlist
- [x] `PUT /api/sounds/playlists/:name/reorder` - Reorder sounds

#### Sharing
- [x] `GET /api/sounds/shares/pending` - List pending shares to user
- [x] `POST /api/sounds/shares/:shareId/accept` - Accept share
- [x] `POST /api/sounds/shares/:shareId/reject` - Reject share

#### Public Library
- [x] `GET /api/sounds/public/library` - List public sounds (paginated)
- [x] `POST /api/sounds/public/:soundFileId` - Add public sound to user's library

#### Registration / GUID Linking
- [x] `POST /api/sounds/verify-code` - Verify registration code and link GUID
- [x] `GET /api/sounds/account/guid` - Check if GUID is linked

#### Implementation Notes
- All endpoints require authentication via JWT
- GUID is retrieved from user account (linked via verify-code)
- Full Zod validation on all inputs
- Proper error handling with status codes
- Reference counting for shared sound files
- Build tested successfully

### 3.2 File Upload Handler ⬜

- [ ] Multipart form handler for MP3 uploads
- [ ] Validate MP3 format
- [ ] Store file in `sounds/<guid>/` directory
- [ ] Max file size enforcement (5MB)
- [ ] Optional: URL download from server-side

### 3.3 User-GUID Linking ⬜

Need to link ETPanel users to their in-game GUIDs:

- [ ] Add `guids` table or field to users table
- [ ] API to link/unlink GUIDs
- [ ] Verification mechanism (optional: in-game verification code)

---

## Phase 4: ETPanel Frontend Pages

### 4.1 My Sounds Page ⬜

**File:** `etpanel/frontend/src/pages/MySounds.tsx`

Features:
- [ ] Grid/list view of user's sounds
- [ ] Play preview (if possible via web audio)
- [ ] Edit alias inline
- [ ] Delete with confirmation
- [ ] Upload new sound (drag & drop or file picker)
- [ ] Add from URL
- [ ] Change visibility (private/shared/public)
- [ ] Show file size, duration, created date

### 4.2 Playlists Page ⬜

**File:** `etpanel/frontend/src/pages/Playlists.tsx`

Features:
- [ ] List all playlists with sound count
- [ ] Create new playlist modal
- [ ] Click playlist to view/edit contents
- [ ] Drag & drop reorder sounds
- [ ] Add sounds to playlist (search/select)
- [ ] Remove sounds from playlist
- [ ] Delete playlist

### 4.3 Public Library Page ⬜

**File:** `etpanel/frontend/src/pages/PublicSounds.tsx`

Features:
- [ ] Browse public sound library
- [ ] Search/filter
- [ ] Preview sounds
- [ ] Add to personal library (copies sound)
- [ ] Show who added (optional)

### 4.4 Pending Shares Page ⬜

**File:** `etpanel/frontend/src/pages/PendingShares.tsx`

Or integrate into MySounds:
- [ ] List incoming share requests
- [ ] Accept/Reject buttons
- [ ] Show who sent and sound preview

### 4.5 Navigation Update ⬜

**File:** `etpanel/frontend/src/components/Layout.tsx`

- [ ] Add "Sounds" section to sidebar
- [ ] Sub-items: My Sounds, Playlists, Public, Shares

### 4.6 Admin Sounds Management ⬜

**File:** `etpanel/frontend/src/pages/AdminSounds.tsx`

Admin-only features:
- [ ] View all sounds across all users
- [ ] Remove sounds from public library
- [ ] Manage public playlists
- [ ] Usage statistics

---

## Phase 5: Testing & Migration

### 5.1 Migration Tasks ⬜

- [ ] Backup existing sounds directory
- [ ] Run migration script to populate database from existing files
- [ ] Verify all existing sounds appear in database
- [ ] Test voice server with new database backend

### 5.2 Testing Checklist ⬜

#### Voice Server
- [ ] Add sound via in-game command
- [ ] Play sound via in-game command
- [ ] Create playlist in-game
- [ ] Add sound to playlist
- [ ] Play sound by playlist position
- [ ] List playlists and categories
- [ ] Change sound visibility
- [ ] Share sound with another player
- [ ] Accept/reject shares

#### ETPanel
- [ ] Upload sound via web
- [ ] Add sound from URL
- [ ] Edit sound alias
- [ ] Delete sound
- [ ] Create/edit/delete playlists
- [ ] Reorder playlist items
- [ ] View public library
- [ ] Add from public to personal
- [ ] Admin: remove from public

---

## Phase 6: Deployment

### 6.1 Voice Server Build ⬜

- [ ] Update `build.sh` with libpq dependency
- [ ] Test build on VPS
- [ ] Update `voice-server.service` if needed

### 6.2 ETPanel Deployment ⬜

- [ ] Run database migrations on production
- [ ] Deploy backend with new routes
- [ ] Deploy frontend with new pages
- [ ] Verify connectivity

### 6.3 Data Migration ⬜

- [ ] Run migration script on production
- [ ] Verify existing sounds accessible
- [ ] Monitor for errors

---

## Technical Notes

### Database Connection in C

The voice server will need libpq (PostgreSQL C library):

```c
#include <libpq-fe.h>

static PGconn *g_dbConn = NULL;

bool DB_Init(const char *connString) {
    g_dbConn = PQconnectdb(connString);
    if (PQstatus(g_dbConn) != CONNECTION_OK) {
        fprintf(stderr, "Database connection failed: %s\n",
                PQerrorMessage(g_dbConn));
        PQfinish(g_dbConn);
        g_dbConn = NULL;
        return false;
    }
    return true;
}
```

### Playlist Ordering Logic

When listing playlist contents:
1. Query database ordered by `order_number`
2. Include alphabetical name in display
3. Format: `#. soundname (order_number)`

When adding to playlist:
1. Get MAX(order_number) for playlist
2. Insert with order_number = MAX + 1

When reordering:
1. Accept new order array from client
2. Update all order_numbers in transaction

### Playlist Playback Behavior

**Important: NO auto-advance!** Players must manually trigger each sound.

**Position Tracking:**
- Track `current_position` per user per playlist
- `/etman playlist <name>` - plays sound at current position, then advances position
- `/etman playlist <name> <#>` - plays specific position, sets current position to that #
- `/etman playlist <name> random` - plays random sound from playlist (does NOT affect current position)
- Position wraps to 1 after reaching end of playlist

**Why no auto-advance:**
- Prevents server spam
- Respects rate limiting
- Player controls pacing

```sql
-- Add to user_sounds or separate table
ALTER TABLE sound_playlists ADD COLUMN current_position INTEGER DEFAULT 1;
```

### Rate Limiting (30 sec per minute)

**Simple server-clock-based limiting:**

```c
// Per-player tracking in voice server
typedef struct {
    uint32_t currentMinute;      // server_time / 60
    uint32_t secondsUsedThisMinute;  // 0-30 max
} PlayerAudioLimit;

// On sound play request:
uint32_t serverMinute = time(NULL) / 60;

if (player->limit.currentMinute != serverMinute) {
    // New minute - reset counter
    player->limit.currentMinute = serverMinute;
    player->limit.secondsUsedThisMinute = 0;
}

uint32_t soundDuration = getSoundDuration(soundId);

if (player->limit.secondsUsedThisMinute + soundDuration > 30) {
    // Deny - would exceed 30 second limit
    sendResponse(client, "Rate limited. Wait for next minute.");
    return;
}

// Allow playback
player->limit.secondsUsedThisMinute += soundDuration;
playSound(soundId);
```

**Key points:**
- Counter resets at each new minute on server clock (not rolling window)
- Check happens BEFORE playback starts
- If sound would exceed 30s, deny entirely (don't partial play)
- Simple integer comparison, no fancy tracking

### Sound File Storage (Updated Architecture)

**File storage is now centralized - no per-user directories:**
- Path: `sounds/<uuid>.mp3` (UUID-based filenames)
- Database `sound_files` table tracks all files
- `user_sounds` junction table links users to files with their custom aliases

**Key benefits:**
- No file duplication when sharing/making public
- Multiple users can reference same physical file
- `reference_count` tracks how many users have the file
- Orphan cleanup only when `reference_count = 0`

### Sound Deletion Logic

```
User deletes sound from their library:
├── Is visibility 'private' AND reference_count = 1?
│   ├── YES: Delete user_sounds, sound_files, AND physical file
│   └── NO:  Delete only user_sounds, decrement reference_count
│            File stays on disk for other users
```

### Adding from Public/Shared Library

When user adds from public library or accepts a share:
1. Find existing `sound_files` entry (NO file copy!)
2. Create new `user_sounds` entry linking user to file
3. User provides their own alias
4. Increment `reference_count` on `sound_files`
5. Done - instant, no disk I/O

### File Cleanup Job (Optional)

Periodic background task:
```sql
-- Find orphaned files (no users reference them)
SELECT id, file_path FROM sound_files WHERE reference_count <= 0;
-- Delete these files from disk and database
```

---

## Session Notes

### Session 1 (2025-12-27)
- Created implementation plan
- Analyzed existing codebase
- Designed initial database schema
- Added Phase 7: In-game account registration with GUID verification
- **UPDATED:** Redesigned schema with junction table architecture:
  - `sound_files` = actual MP3 files (centralized, UUID filenames)
  - `user_sounds` = junction table linking users to files with custom aliases
  - Deletion only removes user reference, not file (unless private + sole owner)
  - Sharing/public adds reference, no file copy needed
  - `reference_count` tracks usage for cleanup

### Session 2 (2025-12-27 - Evening)
- **Phase 1.6 COMPLETE:** Implemented full Drizzle schema in `etpanel/backend/src/db/schema.ts`
  - Added `soundFiles`, `userSounds`, `soundPlaylists`, `soundPlaylistItems`, `soundShares` tables
  - Added `verificationCodes` table for in-game registration
  - Updated `users` table with optional `guid` field and made `email` optional
  - Added proper indexes (unique and non-unique) for all query patterns
  - Added Drizzle relations for joins
  - Added TypeScript type exports
- Migration file generated: `0002_bitter_otto_octavius.sql`
- **Phase 1.7 COMPLETE:** Migration deployed to VPS
  - Synced backend code to VPS via rsync
  - Ran migration SQL directly via psql
  - All 6 new tables created successfully
  - Fixed table ownership to `etpanel` user

### Session 3 (2025-12-27 - Night)
- **Phase 2.1 COMPLETE:** PostgreSQL Integration for Voice Server
  - Created `db_manager.h` with comprehensive API for all database operations:
    - Connection management (init, shutdown, reconnect, status)
    - Sound file operations (add, get, list, delete, rename, visibility)
    - Playlist operations (create, delete, list, add/remove items, reorder, position tracking)
    - Share operations (create, list pending, accept, reject)
    - Registration operations (create code, verify, mark used)
    - Utility functions (escape string, execute raw)
  - Created `db_manager.c` with full libpq implementation (~1100 lines)
    - All queries use parameterized statements for security
    - Proper transaction handling for multi-table operations
    - Reference counting for shared sound files
    - Timestamp parsing for PostgreSQL format
  - Updated `CMakeLists.txt` with libpq and uuid dependencies
  - Integrated DB initialization in `SoundMgr_Init()` with DATABASE_URL env var
  - Falls back to filesystem-only mode when database not available
  - Build tested successfully
- **Phase 2.2 COMPLETE:** Added all new command packet types to `sound_manager.h`
- **Phase 2.3 COMPLETE:** All database query functions implemented
- **Phase 2.4 COMPLETE:** Wired up all packet handlers in `SoundMgr_HandlePacket()`
  - Playlist handlers: CREATE, DELETE, LIST, ADD, REMOVE, PLAY
  - Visibility/public: SET_VISIBILITY, PUBLIC_LIST, PUBLIC_ADD
  - Sharing: SHARE, ACCEPT, REJECT, PENDING
  - Registration: ACCOUNT_REGISTER
  - Added `SoundMgr_PlaySoundByPath()` for DB-mode playback
  - All handlers check dbMode and return appropriate errors
  - Build tested successfully
- **Phase 2.5 COMPLETE:** Client-side (cgame) commands implemented
  - Added packet types to cg_etman.h
  - Implemented all new command handlers in cg_etman.c (~700 lines added)
  - Playlists: create, delete, add, remove, play by position
  - Sharing: share, pending, accept, reject
  - Visibility/public: visibility, public, getpublic
  - Registration: register command for ETPanel
  - Updated help text with all new commands
  - Build tested successfully
- **Phase 2 COMPLETE!** Ready for Phase 3 (ETPanel Backend)
- **Phase 3 COMPLETE:** ETPanel Backend API implemented
  - Created `sounds.ts` routes file (~600 lines)
  - Sound CRUD: list, get, rename, delete, visibility
  - Playlists: create, delete, list, add/remove sounds, reorder
  - Sharing: pending list, accept, reject
  - Public library: list, add to personal library
  - Registration: verify-code to link GUID to web account
  - Fixed JwtPayload type for optional email
  - Build tested successfully

### Session 4 (2025-12-28)
- **Public Playlists COMPLETE:** Added public playlist commands
  - `/etman publicplaylists` - List all public playlists
  - `/etman publicplaylist <name> [#]` - List or play from public playlist
  - `/etman publicplaynext <name>` - Play next from public playlist
  - `/etman publicplayrandom <name>` - Play random from public playlist
  - Server handlers: `VOICE_CMD_PLAYLIST_PUBLIC_LIST` (0x25), `VOICE_CMD_PLAYLIST_SET_VISIBILITY` (0x26), `VOICE_CMD_PLAYLIST_PUBLIC_SHOW` (0x27)
  - Position 254 = "next", Position 255 = "random"
- **Position Tracking for Private Playlists:**
  - `/etman playnext <playlist>` - Play next sound, advances position (wraps)
  - `/etman playrandom <playlist>` - Play random from playlist
  - Uses `current_position` column in `sound_playlists` table
- **Key Bug Fix:** Always use `./scripts/build-all.sh` (no args) to rebuild voice server!
  - `build-all.sh mod` only builds client modules, NOT voice server
- **Next:** Phase 4 (ETPanel Frontend UI)

---

## Phase 7: In-Game Account Registration

### 7.1 Registration Flow ⬜

**Goal:** Players can create ETPanel accounts from within the game, verified by their GUID.

#### Flow:
1. Player types `/etman register` in-game
2. Server generates unique 6-character verification code tied to their GUID
3. Code sent to player via chat message
4. Player visits ETPanel `/register` page
5. Player enters: verification code + desired password
6. ETPanel verifies code matches GUID
7. Account created with GUID as primary identifier, playername as display name

### 7.2 Database Schema Updates ✅

**Done in Phase 1.6 Drizzle schema:**

- [x] Added `guid` column to `users` table (optional, unique)
- [x] Made `email` column optional in `users` table
- [x] Created `verification_codes` table with guid, code, playerName, expiresAt, used fields
- [x] Added unique index on verification code

### 7.3 Voice Server Registration Command ⬜

**New packet type:**
```c
#define VOICE_CMD_ACCOUNT_REGISTER  0x30  // Request registration code
#define VOICE_RESP_REGISTER_CODE    0x31  // Registration code response
```

**Implementation:**
- [ ] Generate random 6-char alphanumeric code (uppercase only for readability)
- [ ] Store in database with GUID, player name, 10-min expiry
- [ ] Return code to player via chat
- [ ] Rate limit: 1 request per minute per GUID

### 7.4 ETPanel Registration Page ⬜

**File:** `etpanel/frontend/src/pages/GameRegister.tsx`

Features:
- [ ] Simple form: Verification Code + Password + Confirm Password
- [ ] Submit validates code against database
- [ ] On success: create user account, log them in
- [ ] Display success message with their username (from in-game name)

### 7.5 ETPanel Backend Routes ⬜

**File:** `etpanel/backend/src/routes/auth.ts` (extend existing)

- [ ] `POST /api/auth/game-register` - Verify code and create account
  - Input: `{ code: string, password: string }`
  - Validates code exists and not expired
  - Creates user with GUID, player name as displayName
  - Returns JWT tokens

- [ ] `POST /api/auth/request-code` (optional admin API)
  - For testing/admin use

### 7.6 User Model Updates ⬜

**Drizzle schema changes:**

```typescript
// Update users table
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  guid: varchar('guid', { length: 32 }).unique(),  // NEW: Game GUID
  email: varchar('email', { length: 255 }),  // Now optional
  passwordHash: varchar('password_hash', { length: 255 }),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  role: varchar('role', { length: 20 }).default('user').notNull(),
  googleId: varchar('google_id', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// New verification codes table
export const verificationCodes = pgTable('verification_codes', {
  id: serial('id').primaryKey(),
  guid: varchar('guid', { length: 32 }).notNull().unique(),
  code: varchar('code', { length: 6 }).notNull(),
  playerName: varchar('player_name', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  used: boolean('used').default(false).notNull(),
});
```

### 7.7 Linking Existing Accounts ⬜

For users who already have ETPanel accounts:

**In-game command:** `/etman link`
1. Generates verification code (same as register)
2. Player goes to ETPanel Settings page
3. Enters code to link GUID to existing account

**Backend route:**
- [ ] `POST /api/auth/link-guid` - Link GUID to authenticated user
  - Requires auth token
  - Input: `{ code: string }`
  - Updates user record with GUID

---

## Updated Questions/Decisions

1. ~~**GUID Verification**~~ ✅ DECIDED: In-game registration with verification code

2. **File Storage Location**: Keep in voice-server directory or move to ETPanel accessible location?
   - Decision: Keep in voice-server `/sounds/` directory, ETPanel accesses via backend API

3. **Public Library Moderation**: Auto-add or require admin approval?
   - Decision: Auto-add, admin can remove later

4. **Share Notifications**: In-game only or also via ETPanel?
   - Decision: Both - in-game immediate, ETPanel shows pending shares

5. **Username Uniqueness**: Usernames (display names) NOT unique since GUID is the identifier

---

## Resources

- [libpq Documentation](https://www.postgresql.org/docs/current/libpq.html)
- [Drizzle ORM Docs](https://orm.drizzle.team/docs/overview)
- [ET:Legacy Lua API](https://etlegacy-lua-docs.readthedocs.io/)
