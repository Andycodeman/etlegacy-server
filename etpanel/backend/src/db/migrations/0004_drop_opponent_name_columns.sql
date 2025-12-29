-- Drop redundant opponent name columns from player_matchups
-- Names are now fetched via JOIN with player_stats using opponent_guid
ALTER TABLE player_matchups DROP COLUMN IF EXISTS opponent_name;
ALTER TABLE player_matchups DROP COLUMN IF EXISTS opponent_display_name;
