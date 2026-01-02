# Playlist Snapshot Feature Plan

## Overview

When a playlist is linked to a menu slot, capture a snapshot of its contents. This allows:
1. Custom display names for individual sounds in the playlist
2. Graceful degradation if the playlist is deleted or made private
3. Continued functionality (where possible) if underlying sounds are removed

## Current Architecture

- `user_sound_menu_items` stores menu items with `playlistId` for playlist links
- Playlists expand dynamically via `sound_playlist_items` → `user_sounds` → `sound_files`
- No protection if playlist owner deletes/privatizes their playlist
- No way to customize display names for playlist sounds

## Proposed Changes

### Database Schema

Add one column to `user_sound_menu_items`:

```sql
ALTER TABLE user_sound_menu_items
ADD COLUMN playlist_snapshot JSONB DEFAULT NULL;
```

### Snapshot Structure

```json
{
  "capturedAt": "2026-01-02T12:00:00Z",
  "originalPlaylistId": 42,
  "originalPlaylistName": "Epic Songs",
  "items": [
    {
      "position": 1,
      "soundFileId": 123,
      "originalAlias": "epic_battle_v2",
      "displayName": "Battle Theme",
      "filePath": "abc123.mp3"
    },
    {
      "position": 2,
      "soundFileId": 456,
      "originalAlias": "victory_fanfare",
      "displayName": null,
      "filePath": "def456.mp3"
    }
  ]
}
```

**Fields:**
- `capturedAt`: When snapshot was taken
- `originalPlaylistId`: The linked playlist ID (for live refresh option)
- `originalPlaylistName`: Display name at capture time
- `items[]`:
  - `position`: Order in playlist (1-indexed)
  - `soundFileId`: Direct reference to `sound_files.id`
  - `originalAlias`: Sound name at capture time
  - `displayName`: User's custom override (null = use originalAlias)
  - `filePath`: The actual filename for playback

## Implementation Tasks

### Phase 1: Backend Schema & API ✅ COMPLETE (Jan 2, 2026)

- [x] Add `playlist_snapshot` column to schema.ts
- [x] Generate and run migration
- [x] Update POST `/root-items` and `/server-root-items` to capture snapshot when `itemType='playlist'`
- [x] Update POST `/menus/:id/items` to capture snapshot for playlist items
- [x] Add PUT endpoint to update `displayName` overrides in snapshot (`PUT /root-items/:id/snapshot`)
- [x] Add endpoint to refresh snapshot from live playlist (`POST /root-items/:id/snapshot/refresh`)
- [x] Add `playlistSnapshot` to GET `/root-items` and `/server-root-items` responses
- [x] Deploy to VPS

### Phase 2: ETMan Server (In-Game) ✅ COMPLETE (Jan 2, 2026)

- [x] Update `DB_GetMenuPage` playlist expansion to check for snapshot
- [x] If playlist accessible: use live data (but apply displayName overrides from snapshot)
- [x] If playlist inaccessible: fall back to snapshot data
- [x] Use PostgreSQL JSONB operators to extract snapshot items in SQL
- [x] Build and deploy to VPS

**Implementation Notes:**
- Snapshot query uses `jsonb_array_elements()` to expand items in PostgreSQL
- DisplayName override matching is done by comparing `originalAlias` with live alias
- Fallback mode uses snapshot data when live playlist returns 0 rows
- Debug logging added for troubleshooting

### Phase 3: ETPanel Frontend ✅ COMPLETE (Jan 2, 2026)

- [x] When editing a playlist slot, show list of sounds with editable names
- [x] Display original name with edit icon
- [x] Save updates to `playlist_snapshot.items[].displayName`
- [x] Add "Refresh from playlist" button to re-capture snapshot
- [x] Show snapshot timestamp
- [x] Deploy to VPS

**UI Features:**
- "Edit Sound Names" button appears when viewing a playlist item in view mode
- Edit mode shows all sounds in the snapshot with editable display name fields
- "Refresh from Live Playlist" button updates the snapshot (preserves custom names)
- "Save Custom Names" saves all displayName overrides
- Snapshot timestamp displayed

## Behavior Summary

| Scenario | Behavior |
|----------|----------|
| Playlist accessible, all sounds exist | Use live playlist, apply displayName overrides |
| Playlist deleted/private, snapshot exists | Use snapshot data for playback |
| Individual sound deleted | Show "unavailable" for that item, others work |
| No snapshot (legacy data) | Expand playlist live (current behavior) |

## Files to Modify

### Backend
- `etpanel/backend/src/db/schema.ts` - Add column
- `etpanel/backend/src/routes/sounds.ts` - Capture snapshot, update endpoints

### ETMan Server
- `etman-server/db_manager.c` - Update `DB_GetMenuPage` playlist handling

### Frontend
- `etpanel/frontend/src/components/SoundMenuEditor.tsx` - Edit UI for playlist sounds
- `etpanel/frontend/src/api/client.ts` - New API methods

## Migration Notes

- Existing playlist links will have `playlist_snapshot = NULL`
- These continue to work with current live-expansion behavior
- Users can manually refresh to create snapshot
- Consider batch job to snapshot all existing playlist links

## Future Considerations

- Option to "freeze" a playlist (never use live, always snapshot)
- Notification when linked playlist changes
- Bulk rename tools for playlist sounds
