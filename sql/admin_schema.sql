-- ETMan Admin Commands System - Database Schema
-- Run this on the VPS PostgreSQL database (etpanel)
--
-- Usage: psql -U etpanel -d etpanel -f admin_schema.sql

-- Admin levels (hierarchical permission tiers)
CREATE TABLE IF NOT EXISTS admin_levels (
    id SERIAL PRIMARY KEY,
    level INTEGER NOT NULL UNIQUE,  -- 0=Guest, 1=Regular, 2=VIP, 3=Admin, 4=Senior, 5=Owner
    name VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Insert default levels (ignore if already exist)
INSERT INTO admin_levels (level, name) VALUES
    (0, 'Guest'),
    (1, 'Regular'),
    (2, 'VIP'),
    (3, 'Admin'),
    (4, 'Senior Admin'),
    (5, 'Owner')
ON CONFLICT (level) DO NOTHING;

-- Commands registry (all available !commands)
CREATE TABLE IF NOT EXISTS admin_commands (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,  -- 'rotate', 'kick', 'map', etc.
    description TEXT,
    usage VARCHAR(255),  -- '!kick <player> [reason]'
    default_level INTEGER NOT NULL DEFAULT 5,  -- minimum level required by default
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Insert default commands
INSERT INTO admin_commands (name, description, usage, default_level) VALUES
    -- Level 0 (Guest) commands
    ('help', 'Show help for commands', '!help [command]', 0),
    ('time', 'Show server time', '!time', 0),
    ('maplist', 'Show map rotation', '!maplist', 0),
    ('admintest', 'Show your admin level', '!admintest', 0),

    -- Level 1 (Regular) commands
    ('nextmap', 'Show next map in rotation', '!nextmap', 1),
    ('stats', 'Show player statistics', '!stats [player]', 1),

    -- Level 2 (VIP) commands
    ('players', 'List players with slot IDs', '!players', 2),
    ('spec999', 'Force spectator', '!spec999', 2),

    -- Level 3 (Admin) commands
    ('kick', 'Kick a player', '!kick <player> [reason]', 3),
    ('mute', 'Mute player chat', '!mute <player> [duration]', 3),
    ('unmute', 'Unmute player', '!unmute <player>', 3),
    ('warn', 'Warn a player', '!warn <player> <reason>', 3),
    ('put', 'Force player to team', '!put <player> <team>', 3),
    ('rotate', 'Advance to next map', '!rotate', 3),
    ('map', 'Change to specific map', '!map <mapname>', 3),
    ('restart', 'Restart current map', '!restart', 3),
    ('finger', 'Show player info', '!finger <player>', 3),
    ('aliases', 'Show player name history', '!aliases <player>', 3),
    ('listadmins', 'List online admins', '!listadmins', 3),

    -- Level 4 (Senior Admin) commands
    ('ban', 'Ban a player', '!ban <player> <duration> [reason]', 4),
    ('unban', 'Unban a player by GUID', '!unban <guid>', 4),
    ('slap', 'Slap player (damage)', '!slap <player> [damage]', 4),
    ('gib', 'Gib player (kill)', '!gib <player>', 4),
    ('setlevel', 'Set player admin level', '!setlevel <player> <level>', 4),
    ('shuffle', 'Shuffle teams', '!shuffle', 4),

    -- Level 5 (Owner) commands
    ('rcon', 'Execute rcon command', '!rcon <command>', 5),
    ('cvar', 'Set server cvar', '!cvar <name> <value>', 5)
ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    usage = EXCLUDED.usage,
    default_level = EXCLUDED.default_level;

-- Level permissions (which levels can use which commands)
-- Auto-populate based on default_level
CREATE TABLE IF NOT EXISTS admin_level_permissions (
    level_id INTEGER REFERENCES admin_levels(id) ON DELETE CASCADE,
    command_id INTEGER REFERENCES admin_commands(id) ON DELETE CASCADE,
    PRIMARY KEY (level_id, command_id)
);

-- Auto-grant permissions based on default_level
-- Each level gets access to commands at or below their level
INSERT INTO admin_level_permissions (level_id, command_id)
SELECT l.id, c.id
FROM admin_levels l
CROSS JOIN admin_commands c
WHERE l.level >= c.default_level
ON CONFLICT DO NOTHING;

-- Players (identified by GUID)
CREATE TABLE IF NOT EXISTS admin_players (
    id SERIAL PRIMARY KEY,
    guid VARCHAR(32) NOT NULL UNIQUE,  -- ET cl_guid (32 hex chars)
    level_id INTEGER REFERENCES admin_levels(id) DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW(),
    times_seen INTEGER DEFAULT 1
);

-- Create index for fast GUID lookup
CREATE INDEX IF NOT EXISTS idx_admin_players_guid ON admin_players(guid);

-- Player aliases (name history with fuzzy search support)
CREATE TABLE IF NOT EXISTS admin_aliases (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES admin_players(id) ON DELETE CASCADE,
    alias VARCHAR(64) NOT NULL,  -- raw name with color codes
    clean_alias VARCHAR(64) NOT NULL,  -- stripped, lowercase for search
    last_used TIMESTAMP DEFAULT NOW(),
    times_used INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_aliases_clean ON admin_aliases(clean_alias);
CREATE INDEX IF NOT EXISTS idx_aliases_player ON admin_aliases(player_id);

-- Per-player permission overrides
CREATE TABLE IF NOT EXISTS admin_player_permissions (
    player_id INTEGER REFERENCES admin_players(id) ON DELETE CASCADE,
    command_id INTEGER REFERENCES admin_commands(id) ON DELETE CASCADE,
    granted BOOLEAN NOT NULL,  -- TRUE = grant, FALSE = revoke
    granted_by INTEGER REFERENCES admin_players(id),
    granted_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (player_id, command_id)
);

-- Command execution log (audit trail)
CREATE TABLE IF NOT EXISTS admin_command_log (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES admin_players(id),
    command VARCHAR(50) NOT NULL,
    args TEXT,
    target_player_id INTEGER REFERENCES admin_players(id),
    success BOOLEAN,
    executed_at TIMESTAMP DEFAULT NOW(),
    source VARCHAR(20) DEFAULT 'game'  -- 'game', 'etpanel', 'rcon'
);
CREATE INDEX IF NOT EXISTS idx_command_log_player ON admin_command_log(player_id);
CREATE INDEX IF NOT EXISTS idx_command_log_time ON admin_command_log(executed_at);

-- Bans
CREATE TABLE IF NOT EXISTS admin_bans (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES admin_players(id) ON DELETE CASCADE,
    banned_by INTEGER REFERENCES admin_players(id),
    reason TEXT,
    issued_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,  -- NULL = permanent
    active BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_bans_player ON admin_bans(player_id);
CREATE INDEX IF NOT EXISTS idx_bans_active ON admin_bans(active) WHERE active = TRUE;

-- Mutes
CREATE TABLE IF NOT EXISTS admin_mutes (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES admin_players(id) ON DELETE CASCADE,
    muted_by INTEGER REFERENCES admin_players(id),
    reason TEXT,
    issued_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    active BOOLEAN DEFAULT TRUE,
    voice_mute BOOLEAN DEFAULT FALSE  -- Also mute voice chat?
);
CREATE INDEX IF NOT EXISTS idx_mutes_active ON admin_mutes(active) WHERE active = TRUE;

-- Warnings
CREATE TABLE IF NOT EXISTS admin_warnings (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES admin_players(id) ON DELETE CASCADE,
    warned_by INTEGER REFERENCES admin_players(id),
    reason TEXT NOT NULL,
    issued_at TIMESTAMP DEFAULT NOW()
);

-- View: Check if a player is banned
CREATE OR REPLACE VIEW admin_active_bans AS
SELECT
    b.*,
    p.guid,
    (SELECT alias FROM admin_aliases WHERE player_id = p.id ORDER BY last_used DESC LIMIT 1) AS last_name
FROM admin_bans b
JOIN admin_players p ON b.player_id = p.id
WHERE b.active = TRUE
  AND (b.expires_at IS NULL OR b.expires_at > NOW());

-- View: Check if a player is muted
CREATE OR REPLACE VIEW admin_active_mutes AS
SELECT
    m.*,
    p.guid,
    (SELECT alias FROM admin_aliases WHERE player_id = p.id ORDER BY last_used DESC LIMIT 1) AS last_name
FROM admin_mutes m
JOIN admin_players p ON m.player_id = p.id
WHERE m.active = TRUE
  AND (m.expires_at IS NULL OR m.expires_at > NOW());

-- Function: Strip ET color codes from name
CREATE OR REPLACE FUNCTION strip_colors(name TEXT) RETURNS TEXT AS $$
BEGIN
    -- ET uses ^0-^9 and ^a-^z for colors
    RETURN regexp_replace(name, '\^[0-9a-zA-Z]', '', 'g');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function: Get or create player by GUID
CREATE OR REPLACE FUNCTION get_or_create_player(p_guid VARCHAR(32))
RETURNS INTEGER AS $$
DECLARE
    player_id INTEGER;
    guest_level_id INTEGER;
BEGIN
    -- Get guest level ID
    SELECT id INTO guest_level_id FROM admin_levels WHERE level = 0;

    -- Try to find existing player
    SELECT id INTO player_id FROM admin_players WHERE guid = p_guid;

    IF player_id IS NULL THEN
        -- Create new player at Guest level
        INSERT INTO admin_players (guid, level_id)
        VALUES (p_guid, guest_level_id)
        RETURNING id INTO player_id;
    ELSE
        -- Update last seen
        UPDATE admin_players
        SET last_seen = NOW(), times_seen = times_seen + 1
        WHERE id = player_id;
    END IF;

    RETURN player_id;
END;
$$ LANGUAGE plpgsql;

-- Function: Update player alias
CREATE OR REPLACE FUNCTION update_player_alias(p_player_id INTEGER, p_alias VARCHAR(64))
RETURNS VOID AS $$
DECLARE
    clean VARCHAR(64);
BEGIN
    clean := lower(strip_colors(p_alias));

    -- Try to update existing alias
    UPDATE admin_aliases
    SET last_used = NOW(), times_used = times_used + 1
    WHERE player_id = p_player_id AND alias = p_alias;

    IF NOT FOUND THEN
        -- Insert new alias
        INSERT INTO admin_aliases (player_id, alias, clean_alias)
        VALUES (p_player_id, p_alias, clean);
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Function: Check if player has permission for command
CREATE OR REPLACE FUNCTION check_permission(p_guid VARCHAR(32), p_command VARCHAR(50))
RETURNS BOOLEAN AS $$
DECLARE
    player_record RECORD;
    player_level INTEGER;
    command_id INTEGER;
    has_override BOOLEAN;
    override_granted BOOLEAN;
BEGIN
    -- Get player info
    SELECT p.id, l.level INTO player_record
    FROM admin_players p
    JOIN admin_levels l ON p.level_id = l.id
    WHERE p.guid = p_guid;

    IF NOT FOUND THEN
        -- Unknown player = guest (level 0)
        player_level := 0;
    ELSE
        player_level := player_record.level;
    END IF;

    -- Get command ID
    SELECT id INTO command_id FROM admin_commands WHERE name = p_command AND enabled = TRUE;
    IF NOT FOUND THEN
        RETURN FALSE;  -- Unknown or disabled command
    END IF;

    -- Check for per-player override
    SELECT granted INTO override_granted
    FROM admin_player_permissions
    WHERE player_id = player_record.id AND command_id = command_id;

    IF FOUND THEN
        RETURN override_granted;
    END IF;

    -- Check level permission
    RETURN EXISTS (
        SELECT 1 FROM admin_level_permissions lp
        JOIN admin_levels l ON lp.level_id = l.id
        WHERE lp.command_id = command_id AND l.level <= player_level
    );
END;
$$ LANGUAGE plpgsql;

-- Grant access to etpanel user
GRANT ALL ON ALL TABLES IN SCHEMA public TO etpanel;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO etpanel;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO etpanel;
