# Dynamic Per-Player Sound Menus - Implementation Plan

**Status:** 🟢 Phases 1-5 Complete (Testing & Polish Remaining)
**Created:** 2025-12-31
**Last Updated:** 2025-12-31

---

## Overview

Implement a custom HUD-based popup menu system that allows players to access their sounds and playlists in-game through a visual menu (similar to V-say menus), with the menu structure configured via ETPanel web interface.

### Why Not Use Standard Menus?

ET:Legacy menus are static `.menu` files loaded from pk3 at startup. They cannot be dynamically generated per-player. Our solution bypasses this by implementing a custom HUD popup system in the cgame C code.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         PLAYER CLIENT                            │
│  ┌────────────────┐    ┌────────────────┐    ┌────────────────┐ │
│  │   cg_etman.c   │───▶│  HUD Popup     │───▶│  Key Handler   │ │
│  │ Menu System    │    │  Sound Menus   │    │  1-9, ESC, BS  │ │
│  └───────┬────────┘    └────────────────┘    └───────┬────────┘ │
│          │ Request menus                             │ Selection │
│          ▼                                           ▼           │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              Voice_SendRawPacket() / Response               │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │ UDP (port 27961)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        ETMAN SERVER                              │
│  ┌────────────────┐    ┌────────────────┐                       │
│  │ sound_manager  │───▶│  PostgreSQL    │                       │
│  │ menu handlers  │    │  + menu tables │                       │
│  └────────────────┘    └────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                         ETPANEL WEB                              │
│  ┌────────────────┐    ┌────────────────┐                       │
│  │  Menu Editor   │───▶│ Assign sounds  │                       │
│  │  /my-sounds    │    │ or playlists   │                       │
│  └────────────────┘    └────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Progress Checklist

### Phase 1: Database Schema ✅
- [x] Add `user_sound_menus` table
- [x] Add `user_sound_menu_items` table
- [x] Create drizzle migration
- [x] Test migration on dev database

### Phase 2: ETPanel Backend API ✅
- [x] GET `/api/sounds/menus` - List user's menus
- [x] POST `/api/sounds/menus` - Create menu
- [x] PUT `/api/sounds/menus/:id` - Update menu
- [x] DELETE `/api/sounds/menus/:id` - Delete menu
- [x] POST `/api/sounds/menus/:id/items` - Add item to menu
- [x] PUT `/api/sounds/menus/:id/items/:itemId` - Update item
- [x] DELETE `/api/sounds/menus/:id/items/:itemId` - Remove item
- [x] PUT `/api/sounds/menus/:id/reorder` - Reorder items
- [x] GET `/api/sounds/menus/for-game/:guid` - Game client endpoint

### Phase 3: ETMan Server (C) ✅
- [x] Add `VOICE_CMD_MENU_GET` command (0x32)
- [x] Add `VOICE_CMD_MENU_PLAY` command (0x33)
- [x] Add `VOICE_RESP_MENU_DATA` response (0x34)
- [x] Implement menu data fetching from PostgreSQL (`DB_GetUserMenus`)
- [x] Implement menu item sound lookup (`DB_GetMenuItemSound`)
- [x] Pack menu data into binary response packet
- [x] Handle menu item selection (play sound)

### Phase 4: Client-Side C Code ✅
- [x] Add menu state structures to `cg_etman.c`
- [x] Implement `ETMan_ToggleMenu()` - toggle menu visibility
- [x] Implement `ETMan_DrawMenu()` HUD rendering
- [x] Implement `ETMan_MenuKeyEvent()` key handling
- [x] Implement `ETMan_ParseMenuData()` packet parsing
- [x] Implement `ETMan_RequestMenus()` to fetch from server
- [x] Cache menu data client-side (60 second cache)
- [x] Handle submenu navigation (0 or ESC to go back)

### Phase 5: ETPanel Frontend UI ✅
- [x] Create SoundMenuEditor component
- [x] Add menu management to MySounds page (tab-based navigation)
- [x] Drag-and-drop reordering for manual menu items
- [x] Playlist assignment dropdown for playlist-backed menus
- [x] Preview menu structure (in-game HUD preview)
- [x] Mobile-friendly design (responsive layout)

### Phase 6: Testing & Polish
- [ ] Test with multiple players
- [ ] Test menu caching/refresh
- [ ] Test playlist expansion
- [ ] Add keybind for menu toggle
- [ ] Documentation in CLAUDE.md

---

## Detailed Specifications

### Database Schema

```sql
-- User's custom sound menus (root level categories)
CREATE TABLE user_sound_menus (
    id SERIAL PRIMARY KEY,
    user_guid VARCHAR(32) NOT NULL,
    menu_name VARCHAR(32) NOT NULL,           -- Display name: "Taunts", "Music", etc.
    menu_position INT NOT NULL DEFAULT 0,     -- 1-9 position in root menu
    playlist_id INT REFERENCES sound_playlists(id) ON DELETE SET NULL,
                                              -- If set, expand this playlist's sounds
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(user_guid, menu_position)
);

-- Individual sound items in a menu (only used if playlist_id is NULL)
CREATE TABLE user_sound_menu_items (
    id SERIAL PRIMARY KEY,
    menu_id INT NOT NULL REFERENCES user_sound_menus(id) ON DELETE CASCADE,
    sound_id INT NOT NULL REFERENCES user_sounds(id) ON DELETE CASCADE,
    item_position INT NOT NULL,               -- 1-9 position in submenu
    display_name VARCHAR(32),                 -- Override name (NULL = use sound name)
    created_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(menu_id, item_position)
);

-- Indexes
CREATE INDEX idx_user_sound_menus_guid ON user_sound_menus(user_guid);
CREATE INDEX idx_user_sound_menu_items_menu ON user_sound_menu_items(menu_id);
```

### Menu Types

A menu can be either:
1. **Manual Menu** - `playlist_id` is NULL, items come from `user_sound_menu_items`
2. **Playlist Menu** - `playlist_id` is set, items are first 9 sounds from that playlist

This allows players to:
- Create custom menus with hand-picked sounds
- Or simply assign an existing playlist and it auto-populates

### Packet Protocol

#### Request Menu Data (Client → Server)
```
Byte 0:     VOICE_CMD_MENU_GET (0x40)
Bytes 1-4:  clientId (network byte order)
Bytes 5-36: guid (32 bytes)
Byte 37:    menuId (0 = root menu, 1-9 = submenu at that position)
```

#### Menu Data Response (Server → Client)
```
Byte 0:     VOICE_RESP_MENU_DATA (0x41)
Byte 1:     menuId (which menu this is)
Byte 2:     itemCount (1-9)
Then for each item:
  Byte:     position (1-9)
  Byte:     flags (bit 0 = is_submenu, bit 1 = is_playlist)
  Byte:     nameLen
  Bytes:    name (nameLen bytes, max 32)
  Byte:     commandLen
  Bytes:    command (for sounds: sound name, for submenus: menu position)
```

### Client-Side Structures

```c
// In cg_etman.h

#define ETMAN_MENU_MAX_ITEMS    9
#define ETMAN_MENU_MAX_LEVELS   2  // Root + one submenu level

typedef struct {
    int position;              // 1-9
    char name[33];             // Display name
    char command[33];          // Sound name or submenu ID
    qboolean isSubmenu;        // If true, command is submenu position
    qboolean isPlaylist;       // Menu backed by playlist
} etmanMenuItem_t;

typedef struct {
    qboolean active;           // Menu currently showing
    int currentLevel;          // 0 = root, 1 = submenu
    int currentSubmenu;        // Which submenu we're in (1-9)

    char rootTitle[33];        // "Sound Menu"
    etmanMenuItem_t rootItems[ETMAN_MENU_MAX_ITEMS];
    int rootItemCount;

    char submenuTitle[33];     // Current submenu title
    etmanMenuItem_t submenuItems[ETMAN_MENU_MAX_ITEMS];
    int submenuItemCount;

    int lastFetchTime;         // cg.time when last fetched
    qboolean needsRefresh;     // Force refresh on next open
} etmanMenu_t;

// In cg_etman.c
static etmanMenu_t etmanMenu;
```

### Key Bindings

Default suggested bind:
```
/bind n "etman_menu"
```

While menu is open:
- `1-9` - Select item
- `ESC` - Close menu
- `BACKSPACE` - Go back to root menu (when in submenu)

### HUD Visual Design

```
┌─────────────────────────────────┐
│ ♪ Sound Menu                    │  ← Title bar (dark background)
├─────────────────────────────────┤
│ 1. Taunts                    →  │  ← Arrow indicates submenu
│ 2. Laughs                    →  │
│ 3. Music [Playlist]          →  │  ← [Playlist] tag shows it's auto
│ 4. Memes                     →  │
│ 5. Movie Quotes              →  │
│                                 │
│                                 │
│                                 │
│                                 │
├─────────────────────────────────┤
│ Press 1-9 to select, ESC close  │  ← Help text
└─────────────────────────────────┘

Position: Right side of screen, vertically centered
Size: ~250x300 pixels (scaled to resolution)
Colors: Semi-transparent black bg, white text, yellow highlight
```

### ETPanel UI Mockup

On the "My Sounds" page, add a "Sound Menus" tab:

```
┌─────────────────────────────────────────────────────────────────┐
│ Sound Menus                                        [+ New Menu] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Position 1: Taunts                              [Edit] [Delete] │
│   └─ Type: Manual (5 sounds)                                    │
│                                                                 │
│ Position 2: Laughs                              [Edit] [Delete] │
│   └─ Type: Playlist "My Laughs" (12 sounds, showing first 9)    │
│                                                                 │
│ Position 3: (empty)                             [+ Add Menu]    │
│ Position 4: (empty)                             [+ Add Menu]    │
│ ...                                                             │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ Preview:                                                        │
│ ┌────────────────────┐                                          │
│ │ 1. Taunts       →  │                                          │
│ │ 2. Laughs       →  │                                          │
│ │                    │                                          │
│ └────────────────────┘                                          │
└─────────────────────────────────────────────────────────────────┘
```

Edit Menu Dialog:
```
┌─────────────────────────────────────────────────────────────────┐
│ Edit Menu: Taunts                                          [X]  │
├─────────────────────────────────────────────────────────────────┤
│ Menu Name: [Taunts____________]                                 │
│                                                                 │
│ Menu Type:                                                      │
│   ○ Manual - Pick individual sounds                             │
│   ● Playlist - Use sounds from playlist                         │
│                                                                 │
│ Select Playlist: [My Taunts Playlist    ▼]                      │
│                                                                 │
│ Preview (first 9 sounds):                                       │
│   1. Get Good                                                   │
│   2. Nice Shot                                                  │
│   3. Skill Issue                                                │
│   4. EZ                                                         │
│   5. Rekt                                                       │
│                                                                 │
│                              [Cancel]  [Save]                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## File Locations

| Component | File Path |
|-----------|-----------|
| DB Schema | `etpanel/backend/src/db/schema.ts` (lines 585-645) |
| Backend Routes | `etpanel/backend/src/routes/sounds.ts` (lines 2095-2750) |
| ETMan Server | `etman-server/sound_manager.c` |
| Client Menu | `src/src/cgame/cg_etman.c` |
| Client Header | `src/src/cgame/cg_etman.h` |
| Frontend Component | `etpanel/frontend/src/components/SoundMenuEditor.tsx` |
| Frontend Page | `etpanel/frontend/src/pages/MySounds.tsx` (tab at ?tab=menus) |
| API Client | `etpanel/frontend/src/api/client.ts` (menu endpoints + types) |

---

## Testing Plan

1. **Unit Test Menu Fetch**
   - Create test menu in DB
   - Verify packet format from etman-server

2. **Integration Test Client**
   - Build client with menu code
   - Test menu opens/closes
   - Test key navigation
   - Test sound plays on selection

3. **E2E Test**
   - Configure menu in ETPanel
   - Connect to server
   - Open menu in-game
   - Verify sounds match configuration

---

## Notes & Decisions

- **Cache Duration**: Client caches menu for 5 minutes, can force refresh
- **Max Items**: 9 per menu level (keys 1-9)
- **Max Levels**: 2 (root + one submenu depth)
- **Playlist Expansion**: First 9 sounds from playlist, ordered by playlist item position
- **Default Menu**: New players get empty menu, must configure in ETPanel
- **Fallback**: If menu fetch fails, show "Menu unavailable" message

---

## Session Continuation Prompt

Copy this prompt to continue in a new Claude session:

```
I'm continuing work on the Dynamic Per-Player Sound Menus feature for our ET:Legacy server project.

Please read the implementation plan at:
/home/andy/projects/et/etlegacy/docs/DYNAMIC_SOUND_MENUS.md

Also review the CLAUDE.md files for project context:
- /home/andy/projects/et/CLAUDE.md
- /home/andy/projects/et/etlegacy/CLAUDE.md

Query the memory system for context:
cd ~/projects/et/etlegacy && export FORCE_TRANSFORMERS=1 && npx claude-flow memory query "dynamic menu sound" --namespace decisions

The feature allows players to configure custom sound menus via ETPanel web interface, which are then displayed as HUD popups in-game when they press a key. Menus can contain individual sounds or be backed by a playlist (first 9 sounds auto-populate).

Check the progress checklist in the markdown file and continue from where we left off. The next unchecked items are what we need to work on.

Key files to reference:
- cg_etman.c - existing ETMan client code
- sound_manager.c - existing ETMan server code
- etpanel/backend/src/routes/sounds.ts - existing sound routes
- etpanel/backend/src/db/schema.ts - existing drizzle schema
```

---

## Changelog

| Date | Change |
|------|--------|
| 2025-12-31 | Initial document created with full implementation plan |
| 2025-12-31 | Completed Phases 1-4: DB schema, backend API, ETMan server, client-side C code |
| 2025-12-31 | Completed Phase 5: Frontend UI - SoundMenuEditor component, tabs on MySounds page, drag-drop reordering, playlist selection, HUD preview |
