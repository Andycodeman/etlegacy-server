-- Migration: Hierarchical Sound Menus with Nested Playlists and Pagination
-- Date: 2025-12-31
-- Description: Extends sound menu system to support:
--   1. Menu slots that can contain sounds OR playlists (nested menus)
--   2. Unlimited nesting depth via self-referential parent_id
--   3. Pagination support (9 items per page, 0 = show more)
--   4. Sound IDs based on createdAt order for quick-load feature

-- Drop existing menu tables to recreate with new structure
DROP TABLE IF EXISTS user_sound_menu_items CASCADE;
DROP TABLE IF EXISTS user_sound_menus CASCADE;

-- Recreate user_sound_menus with parent_id for nesting
CREATE TABLE user_sound_menus (
    id SERIAL PRIMARY KEY,
    user_guid VARCHAR(32) NOT NULL,
    menu_name VARCHAR(32) NOT NULL,
    menu_position INTEGER NOT NULL DEFAULT 0,  -- 1-9 position in parent menu
    parent_id INTEGER REFERENCES user_sound_menus(id) ON DELETE CASCADE,  -- NULL = root level
    playlist_id INTEGER REFERENCES sound_playlists(id) ON DELETE SET NULL,  -- If set, auto-populate from playlist
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Indexes for user_sound_menus
CREATE UNIQUE INDEX user_sound_menus_guid_parent_position_idx
    ON user_sound_menus(user_guid, COALESCE(parent_id, 0), menu_position);
CREATE INDEX user_sound_menus_guid_idx ON user_sound_menus(user_guid);
CREATE INDEX user_sound_menus_parent_idx ON user_sound_menus(parent_id);

-- Menu items: each slot can be a sound OR a nested menu/playlist reference
CREATE TABLE user_sound_menu_items (
    id SERIAL PRIMARY KEY,
    menu_id INTEGER NOT NULL REFERENCES user_sound_menus(id) ON DELETE CASCADE,
    item_position INTEGER NOT NULL,  -- 1-9 position in menu
    item_type VARCHAR(10) NOT NULL DEFAULT 'sound',  -- 'sound' or 'menu'
    sound_id INTEGER REFERENCES user_sounds(id) ON DELETE CASCADE,  -- For type='sound'
    nested_menu_id INTEGER REFERENCES user_sound_menus(id) ON DELETE CASCADE,  -- For type='menu'
    display_name VARCHAR(32),  -- Override name (NULL = use source name)
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,

    -- Ensure exactly one of sound_id or nested_menu_id is set based on type
    CONSTRAINT valid_item_type CHECK (
        (item_type = 'sound' AND sound_id IS NOT NULL AND nested_menu_id IS NULL) OR
        (item_type = 'menu' AND nested_menu_id IS NOT NULL AND sound_id IS NULL)
    )
);

-- Indexes for user_sound_menu_items
CREATE UNIQUE INDEX user_sound_menu_items_menu_position_idx
    ON user_sound_menu_items(menu_id, item_position);
CREATE INDEX user_sound_menu_items_menu_idx ON user_sound_menu_items(menu_id);

-- Note: Sound IDs are the actual database IDs (user_sounds.id for personal, sound_files.id for public)
-- This allows sharing IDs between players for public sounds

-- Create a function to get sound by user_sounds.id (for personal library)
CREATE OR REPLACE FUNCTION get_user_sound_by_id(p_guid VARCHAR, p_sound_id INTEGER)
RETURNS TABLE(alias VARCHAR, sound_file_id INTEGER, file_path VARCHAR) AS $$
BEGIN
    RETURN QUERY
    SELECT us.alias, us.sound_file_id, sf.file_path
    FROM user_sounds us
    JOIN sound_files sf ON sf.id = us.sound_file_id
    WHERE us.guid = p_guid AND us.id = p_sound_id;
END;
$$ LANGUAGE plpgsql;

-- Create a function to get public sound by sound_files.id
CREATE OR REPLACE FUNCTION get_public_sound_by_id(p_file_id INTEGER)
RETURNS TABLE(original_name VARCHAR, file_path VARCHAR) AS $$
BEGIN
    RETURN QUERY
    SELECT sf.original_name, sf.file_path
    FROM sound_files sf
    WHERE sf.id = p_file_id AND sf.is_public = true;
END;
$$ LANGUAGE plpgsql;

-- Create a function to play sound by ID (checks personal first, then public)
CREATE OR REPLACE FUNCTION get_sound_by_id(p_guid VARCHAR, p_sound_id INTEGER)
RETURNS TABLE(name VARCHAR, file_path VARCHAR, source VARCHAR) AS $$
BEGIN
    -- First try personal library
    RETURN QUERY
    SELECT us.alias::VARCHAR as name, sf.file_path::VARCHAR as file_path, 'personal'::VARCHAR as source
    FROM user_sounds us
    JOIN sound_files sf ON sf.id = us.sound_file_id
    WHERE us.guid = p_guid AND us.id = p_sound_id
    LIMIT 1;

    IF FOUND THEN
        RETURN;
    END IF;

    -- Then try public library
    RETURN QUERY
    SELECT sf.original_name::VARCHAR as name, sf.file_path::VARCHAR as file_path, 'public'::VARCHAR as source
    FROM sound_files sf
    WHERE sf.id = p_sound_id AND sf.is_public = true
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Comments for documentation
COMMENT ON TABLE user_sound_menus IS 'Hierarchical sound menus supporting unlimited nesting. Root menus have parent_id=NULL.';
COMMENT ON COLUMN user_sound_menus.parent_id IS 'Parent menu ID for nesting. NULL means this is a root-level menu.';
COMMENT ON COLUMN user_sound_menus.playlist_id IS 'If set, menu auto-populates with sounds from this playlist.';
COMMENT ON TABLE user_sound_menu_items IS 'Items in a menu - can be sounds or nested menus/playlists.';
COMMENT ON COLUMN user_sound_menu_items.item_type IS 'sound = plays a sound, menu = navigates into a nested menu.';
COMMENT ON FUNCTION get_user_sound_by_id IS 'Returns sound details for a user by user_sounds.id.';
COMMENT ON FUNCTION get_public_sound_by_id IS 'Returns public sound details by sound_files.id.';
COMMENT ON FUNCTION get_sound_by_id IS 'Returns sound by ID, checking personal library first, then public.';
