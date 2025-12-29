-- Add displayName column to player_stats for preserving ET color codes
ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);

-- Also add to player_matchups for opponent names
ALTER TABLE player_matchups ADD COLUMN IF NOT EXISTS opponent_display_name VARCHAR(100);

-- Also add to kill_log for display purposes
ALTER TABLE kill_log ADD COLUMN IF NOT EXISTS killer_display_name VARCHAR(100);
ALTER TABLE kill_log ADD COLUMN IF NOT EXISTS victim_display_name VARCHAR(100);
