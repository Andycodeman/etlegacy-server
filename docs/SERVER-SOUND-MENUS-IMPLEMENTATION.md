# Server Sound Menus Implementation Plan

## Overview

Add server-wide default sound menus that all players see, separate from personal custom menus. Server menus appear as VSAY option 8, personal menus as option 9.

## Progress Tracker

- [x] **Phase 1: Database Changes** (Completed 2025-01-01)
  - [x] Add `is_server_default` column to `user_sound_menus` table
  - [x] Add partial index for server menus

- [x] **Phase 2: ETMan Server Changes** (Completed 2025-01-01)
  - [x] Update `DB_GetMenuPage` to accept `isServerMenu` parameter
  - [x] Update `sound_manager.c` to parse menu type byte from packet
  - [x] Define `ETMAN_MENU_PERSONAL` (0) and `ETMAN_MENU_SERVER` (1) constants

- [x] **Phase 3: Client-Side Changes (VSAY Menu)** (Completed 2025-01-01)
  - [x] Update `wm_quickmessage.menu` - V = Server Sounds, E = ETMan Sounds
  - [x] Update `wm_quickmessageAlt.menu` - 8 = Server Sounds, 9 = ETMan Sounds
  - [x] Add `soundmenu_server` console command to `cg_etman.c`
  - [x] Register command in `cg_consolecmds.c`
  - [x] Add `etmanMenuType_t` enum and `currentMenuType` state

- [x] **Phase 4: ETPanel Backend** (Completed 2025-01-01)
  - [x] Add `isServerDefault` to Drizzle schema
  - [x] Add `/sounds/server-menus` GET endpoint (list)
  - [x] Add `/sounds/server-menus` POST endpoint (create, admin only)
  - [x] Add `/sounds/server-menus/:id` GET/PUT/DELETE endpoints
  - [x] Add `/sounds/server-menus/:id/items` POST/DELETE endpoints

- [x] **Phase 5: ETPanel Frontend** (Completed 2025-01-01)
  - [x] Add API client functions for server menus
  - [x] Create "Server Sound Menus" admin page at `/sounds/server-menus`
  - [x] Update SoundMenuEditor component with `mode` prop for personal vs server
  - [x] Add admin-only nav link in sidebar

- [ ] **Phase 6: Testing & Polish**
  - [ ] Test as admin creating server menus via UI
  - [ ] Test in-game server menu navigation (option V/8)
  - [ ] Test in-game personal menu navigation (option E/9)
  - [ ] Test as unregistered player seeing server menus

---

## Technical Details

### Database Schema Change

```sql
ALTER TABLE user_sound_menus ADD COLUMN is_server_default BOOLEAN NOT NULL DEFAULT false;

-- Optional: Index for faster queries
CREATE INDEX idx_user_sound_menus_server_default ON user_sound_menus(is_server_default) WHERE is_server_default = true;
```

### In-Game VSAY Menu Structure

| Option | Label | Action |
|--------|-------|--------|
| 8 | S. Server Sounds | Opens server default menus (`is_server_default = true`) |
| 9 | E. ETMan Sounds | Opens player's personal menus (`is_server_default = false`) |

### Query Logic

**Option 8 - Server Sounds (all players see the same):**
```sql
SELECT * FROM user_sound_menus
WHERE is_server_default = true AND parent_id IS NULL
ORDER BY menu_position;
```

**Option 9 - Personal Sounds (per-player):**
```sql
SELECT * FROM user_sound_menus
WHERE user_guid = $1 AND is_server_default = false AND parent_id IS NULL
ORDER BY menu_position;
```

**Nested menu queries:** Same as current, just need to respect the `is_server_default` flag when navigating into submenus.

### ETPanel Structure

**Tabs:**
1. **"Sound Menus"** - Player's personal menus (existing functionality)
   - Shows menus where `is_server_default = false` for logged-in user

2. **"Server Sound Menus"** - Admin only
   - Shows menus where `is_server_default = true`
   - Visible only to users with admin privileges
   - Same CRUD UI as personal menus
   - `owner_guid` = admin who created it (for tracking/accountability)

### Menu Ownership & Permissions

- Server menus have an `owner_guid` (the admin who created them)
- Any admin can edit/delete any server menu (not just the creator)
- `owner_guid` is for audit trail / accountability
- Regular players cannot see the Server Sound Menus tab

### Protocol Changes

Need to differentiate between server menu request vs personal menu request from client:

**Option A: Separate command types**
- `VOICE_CMD_MENU_NAVIGATE` (existing) = personal menus
- `VOICE_CMD_SERVER_MENU_NAVIGATE` (new) = server menus

**Option B: Flag in existing command**
- Add a byte to `VOICE_CMD_MENU_NAVIGATE` payload: `0 = personal, 1 = server`

**Recommendation:** Option B is simpler, less code duplication.

### Client Changes (cg_etman.c)

```c
// Add menu type enum
typedef enum {
    ETMAN_MENU_PERSONAL = 0,
    ETMAN_MENU_SERVER = 1
} etmanMenuType_t;

// Track which type is currently open
etmanMenuType_t currentMenuType;

// Modify ETMan_RequestMenuPage to include menu type
static void ETMan_RequestMenuPage(int menuId, int pageOffset, etmanMenuType_t menuType);
```

### Server Changes (db_manager.c)

```c
// Modify DB_GetMenuPage signature
bool DB_GetMenuPage(const char *guid, int menuId, int pageOffset, bool isServerMenu, DBMenuPageResult *outResult);

// Root level query changes based on isServerMenu flag
if (isServerMenu) {
    // Query: WHERE is_server_default = true AND parent_id IS NULL
} else {
    // Query: WHERE user_guid = $1 AND is_server_default = false AND parent_id IS NULL
}
```

---

## Files to Modify

### Database
- Run migration on VPS PostgreSQL

### ETMan Server (`etman-server/`)
- `db_manager.h` - Update function signatures
- `db_manager.c` - Update queries, add `is_server_default` filtering
- `sound_manager.c` - Handle new menu type in packet parsing

### Client (`src/src/cgame/`)
- `cg_etman.c` - Add menu type tracking, update request functions

### UI Menus (`src/etmain/ui/`)
- `wm_quickmessage.menu` - Change option 8 to Server Sounds, option 9 to My Sounds
- `wm_quickmessageAlt.menu` - Same changes

### ETPanel Backend (`etpanel/backend/`)
- `src/routes/menus.ts` (or similar) - Add server menu endpoints/filtering
- Add admin permission middleware for server menu routes

### ETPanel Frontend (`etpanel/frontend/`)
- Add "Server Sound Menus" tab component
- Add admin-only visibility logic
- Reuse existing menu management components

---

## Testing Checklist

### Admin Testing
- [ ] Can create server menu via ETPanel
- [ ] Can add submenus to server menu
- [ ] Can add playlists to server menu
- [ ] Can add sounds to server menu
- [ ] Can edit/delete server menus
- [ ] Server menus show in-game via option 8

### Player Testing (Registered)
- [ ] Option 8 shows server menus
- [ ] Option 9 shows personal menus
- [ ] Can navigate server menu hierarchy
- [ ] Can play sounds from server menus
- [ ] Personal menus unaffected by server menus

### Player Testing (Unregistered)
- [ ] Option 8 shows server menus (no GUID needed)
- [ ] Option 9 shows empty or appropriate message
- [ ] Can play sounds from server menus

---

## Notes & Decisions

1. **Server menus owned by admin GUID** - Keeps accountability, any admin can edit
2. **Single DB column change** - Minimal migration, reuses existing infrastructure
3. **Separate VSAY options** - Clean UX, no mixing of server/personal
4. **Option 8 = Server (always has content), Option 9 = Personal** - Better UX since server sounds always available
5. **ETPanel separate tabs** - Clear separation for admins, players only see personal tab

---

## Session Handoff Notes

*Add notes here when passing between sessions:*

- **2026-01-01:** Initial design document created. No implementation started yet. Ready to begin Phase 1.
