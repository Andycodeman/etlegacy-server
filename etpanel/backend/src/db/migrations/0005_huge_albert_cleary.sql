CREATE TABLE "user_sound_menu_root_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_guid" varchar(32) NOT NULL,
	"item_position" integer NOT NULL,
	"item_type" varchar(10) NOT NULL,
	"sound_id" integer,
	"menu_id" integer,
	"playlist_id" integer,
	"display_name" varchar(32),
	"is_server_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "user_sound_menus_guid_position_idx";--> statement-breakpoint
ALTER TABLE "user_sound_menu_items" ALTER COLUMN "sound_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sound_menu_items" ADD COLUMN "item_type" varchar(10) DEFAULT 'sound' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sound_menu_items" ADD COLUMN "nested_menu_id" integer;--> statement-breakpoint
ALTER TABLE "user_sound_menu_items" ADD COLUMN "playlist_id" integer;--> statement-breakpoint
ALTER TABLE "user_sound_menus" ADD COLUMN "parent_id" integer;--> statement-breakpoint
ALTER TABLE "user_sound_menus" ADD COLUMN "is_server_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sound_menu_root_items" ADD CONSTRAINT "user_sound_menu_root_items_sound_id_user_sounds_id_fk" FOREIGN KEY ("sound_id") REFERENCES "public"."user_sounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sound_menu_root_items" ADD CONSTRAINT "user_sound_menu_root_items_menu_id_user_sound_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."user_sound_menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sound_menu_root_items" ADD CONSTRAINT "user_sound_menu_root_items_playlist_id_sound_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."sound_playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_sound_menu_root_items_guid_position_idx" ON "user_sound_menu_root_items" USING btree ("user_guid","item_position","is_server_default");--> statement-breakpoint
CREATE INDEX "user_sound_menu_root_items_guid_idx" ON "user_sound_menu_root_items" USING btree ("user_guid");--> statement-breakpoint
CREATE INDEX "user_sound_menu_root_items_server_idx" ON "user_sound_menu_root_items" USING btree ("is_server_default");--> statement-breakpoint
ALTER TABLE "user_sound_menu_items" ADD CONSTRAINT "user_sound_menu_items_playlist_id_sound_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."sound_playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_sound_menus_guid_parent_position_idx" ON "user_sound_menus" USING btree ("user_guid","menu_position");--> statement-breakpoint
CREATE INDEX "user_sound_menus_parent_idx" ON "user_sound_menus" USING btree ("parent_id");