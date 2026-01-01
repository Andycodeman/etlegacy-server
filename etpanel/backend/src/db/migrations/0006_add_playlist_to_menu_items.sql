-- Migration: Add playlist_id to menu items
-- Date: 2025-12-31
-- Description: Allows menu items to link to playlists directly, enabling mixed menus
--              with sounds, nested menus, AND playlists as items.

ALTER TABLE user_sound_menu_items
ADD COLUMN IF NOT EXISTS playlist_id INTEGER REFERENCES sound_playlists(id) ON DELETE CASCADE;

-- Update the check constraint to allow playlist items
-- First drop the old constraint if it exists
ALTER TABLE user_sound_menu_items DROP CONSTRAINT IF EXISTS valid_item_type;

-- Note: With the new schema, we allow:
--   - itemType='sound' with sound_id set
--   - itemType='menu' with nested_menu_id set
--   - itemType='playlist' with playlist_id set
-- The validation is done at the application level

-- Add index for playlist lookups
CREATE INDEX IF NOT EXISTS user_sound_menu_items_playlist_idx ON user_sound_menu_items(playlist_id);

COMMENT ON COLUMN user_sound_menu_items.playlist_id IS 'For itemType=playlist, references a playlist to show as a sub-menu';
