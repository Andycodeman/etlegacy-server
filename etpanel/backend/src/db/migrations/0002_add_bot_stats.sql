-- Add bot kill/death tracking columns to player_stats
ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS bot_kills INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS bot_deaths INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS suicides INTEGER DEFAULT 0 NOT NULL;
