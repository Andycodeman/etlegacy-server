-- Add Dynamic Per-Player Sound Menus tables
-- Migration: 0005_add_sound_menus
-- Date: 2025-12-31

-- User's custom sound menus (root level categories)
CREATE TABLE IF NOT EXISTS "user_sound_menus" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_guid" varchar(32) NOT NULL,
	"menu_name" varchar(32) NOT NULL,
	"menu_position" integer DEFAULT 0 NOT NULL,
	"playlist_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

-- Individual sound items in a menu (only used if playlist_id is NULL)
CREATE TABLE IF NOT EXISTS "user_sound_menu_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"menu_id" integer NOT NULL,
	"sound_id" integer NOT NULL,
	"item_position" integer NOT NULL,
	"display_name" varchar(32),
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Foreign keys
ALTER TABLE "user_sound_menu_items" ADD CONSTRAINT "user_sound_menu_items_menu_id_user_sound_menus_id_fk"
    FOREIGN KEY ("menu_id") REFERENCES "public"."user_sound_menus"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "user_sound_menu_items" ADD CONSTRAINT "user_sound_menu_items_sound_id_user_sounds_id_fk"
    FOREIGN KEY ("sound_id") REFERENCES "public"."user_sounds"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "user_sound_menus" ADD CONSTRAINT "user_sound_menus_playlist_id_sound_playlists_id_fk"
    FOREIGN KEY ("playlist_id") REFERENCES "public"."sound_playlists"("id") ON DELETE set null ON UPDATE no action;

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "user_sound_menu_items_menu_position_idx" ON "user_sound_menu_items" USING btree ("menu_id","item_position");
CREATE INDEX IF NOT EXISTS "user_sound_menu_items_menu_idx" ON "user_sound_menu_items" USING btree ("menu_id");
CREATE UNIQUE INDEX IF NOT EXISTS "user_sound_menus_guid_position_idx" ON "user_sound_menus" USING btree ("user_guid","menu_position");
CREATE INDEX IF NOT EXISTS "user_sound_menus_guid_idx" ON "user_sound_menus" USING btree ("user_guid");
