# Hierarchical Sound Menu System - Implementation Progress

## Overview
Upgrading the HUD sound menu system to support:
1. **Nested menus** - Menu slots can contain sounds OR playlists (which act as sub-menus)
2. **Pagination** - Press `0` to load next 9 items, unlimited depth
3. **Color coding** - Cyan for playlists/menus, white for sounds
4. **Sound ID quick-load** - Type sound ID number to play directly from personal library

## Date Started: 2025-12-31

---

## Files to Modify

### Database Layer
- [x] `etpanel/backend/src/db/migrations/0005_hierarchical_sound_menus.sql` - Created
- [x] `etpanel/backend/src/db/schema.ts` - Updated with parentId, itemType fields

### Client (cgame) - C Code
- [ ] `src/src/cgame/cg_etman.h` - New constants and data structures
- [ ] `src/src/cgame/cg_etman.c` - Menu navigation, pagination, rendering

### Server (etman-server) - C Code
- [ ] `etman-server/db_manager.h` - New query structures
- [ ] `etman-server/db_manager.c` - Hierarchical menu queries
- [ ] `etman-server/sound_manager.c` - Updated protocol handlers

### Backend API (TypeScript)
- [ ] `etpanel/backend/src/routes/sounds.ts` - Menu slot CRUD endpoints

### Frontend (React)
- [ ] `etpanel/frontend/src/pages/MySounds.tsx` - Menu editor UI
- [ ] `etpanel/frontend/src/components/MenuSlotEditor.tsx` - New component

---

## Implementation Details

### 1. Database Schema Changes

**New `user_sound_menus` structure:**
```sql
id, user_guid, menu_name, menu_position, parent_id, playlist_id
-- parent_id enables nesting (NULL = root level)
-- playlist_id auto-populates menu with playlist contents
```

**New `user_sound_menu_items` structure:**
```sql
id, menu_id, item_position, item_type, sound_id, nested_menu_id, display_name
-- item_type: 'sound' or 'menu'
-- sound_id: for playing sounds
-- nested_menu_id: for drilling into sub-menus
```

### 2. Client Protocol Changes

**New binary menu format (VOICE_RESP_MENU_DATA 0x34):**
```
[totalItems:2]           // Total items in this context
[pageOffset:2]           // Current offset (0, 9, 18, ...)
[itemCount:1]            // Items in this packet (1-9)
for each item:
  [position:1]           // 1-9
  [itemType:1]           // 0=sound, 1=menu/playlist
  [nameLen:1]
  [name:N]
  [aliasOrMenuId:varies] // For sounds: alias; For menus: menu_id
```

**New client state:**
```c
typedef struct {
    int menuId;          // Current menu being viewed (0 = root)
    int pageOffset;      // Current page offset (0, 9, 18, ...)
    int totalItems;      // Total items in current menu
    int menuStack[10];   // Stack of parent menu IDs for back navigation
    int stackDepth;      // Current depth in menu tree
} etmanMenuNav_t;
```

### 3. Key Bindings

| Key | Action |
|-----|--------|
| 1-9 | Select item at position |
| 0 | Load next 9 items (pagination) |
| ESC/Backspace | Go back one level |

### 4. Sound ID Quick-Load

**Console command:** `/etman playid <number>`
**HUD toggle:** `/etman idmode` - Opens input field for sound ID

Sound IDs are dynamically assigned based on `created_at` order:
- First added sound = ID 1
- Second added sound = ID 2
- etc.

---

## Progress Log

### 2025-12-31

**Completed:**
1. Created SQL migration `0005_hierarchical_sound_menus.sql`
2. Updated `schema.ts` with new table structures and relations
3. Added `get_sound_by_id()` PostgreSQL function (uses database IDs, shareable)
4. Updated `cg_etman.h` with:
   - New navigation structures (`etmanNavStack_t`)
   - Item type constants (`ETMAN_ITEM_SOUND`, `ETMAN_ITEM_MENU`)
   - New protocol definitions (`VOICE_CMD_MENU_NAVIGATE`, `VOICE_CMD_SOUND_BY_ID`)
5. Updated `cg_etman.c` with:
   - Hierarchical navigation state in module struct
   - `ETMan_NavigateToMenu()`, `ETMan_NavigateBack()`, `ETMan_NextPage()`
   - `ETMan_PlaySoundById()` for quick-play by ID
   - `/etman playid <id>` console command
   - Updated key handlers (0=next page, ESC=back)
   - Updated `ETMan_DrawMenu()` with color coding (cyan for menus, white for sounds)
   - Pagination display (1/3, 2/3, etc.)
6. Updated `sound_manager.h` with new protocol constants
7. Updated `db_manager.h` with:
   - New `DBMenuItem` structure with itemType and nestedMenuId
   - New `DBMenuPageResult` structure
   - `DB_GetMenuPage()` and `DB_GetSoundById()` function declarations

**Completed (continued):**
8. Implemented `DB_GetMenuPage()` in db_manager.c
   - Handles root level (menuId=0) and nested menus
   - Returns paginated items with itemType (sound/menu)
   - Supports playlist-backed menus
9. Implemented `DB_GetSoundById()` in db_manager.c
   - Checks user's library first (user_sounds.id)
   - Falls back to public sounds (sound_files.id)
   - Returns file path and name
10. Added `VOICE_CMD_MENU_NAVIGATE` handler in sound_manager.c
    - Parses menuId and pageOffset from client
    - Calls DB_GetMenuPage() and builds binary response
    - New format includes itemType for each item
11. Added `VOICE_CMD_SOUND_BY_ID` handler in sound_manager.c
    - Plays sound by database ID
    - Works for personal AND public sounds
12. Updated `isSoundCommand()` in main.c to allow 0x35-0x36 commands
    - Changed range from `<= VOICE_CMD_MENU_PLAY` to `<= VOICE_CMD_SOUND_BY_ID`

**Completed (backend):**
13. Updated validation schemas for menus and items
    - `createMenuSchema` now includes `parentId`
    - `addMenuItemSchema` now includes `itemType`, `nestedMenuId`
14. Updated `GET /api/sounds/menus` to support `?parentId=` query
15. Updated `POST /api/sounds/menus` to support `parentId` for nesting
16. Updated `GET /api/sounds/menus/:id` to return `itemType` and `nestedMenuId`
17. Updated `POST /api/sounds/menus/:id/items` to support sounds AND nested menus

**Next Steps:**
1. Build ETPanel frontend menu editor UI (optional - can use API directly)
2. Test complete flow end-to-end
3. Build and deploy

---

## Testing Checklist

- [ ] Root menu displays correctly (max 9 items)
- [ ] Pressing 0 loads next page of items
- [ ] Nested menu navigation works (drill in)
- [ ] Back navigation returns to parent
- [ ] Sounds display in white
- [ ] Playlists/menus display in cyan
- [ ] Playing sounds works from any depth
- [ ] Sound ID quick-load works
- [ ] ETPanel menu editor saves correctly
- [ ] Changes sync to game client
