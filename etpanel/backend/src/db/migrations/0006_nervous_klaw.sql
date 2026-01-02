ALTER TABLE "user_sound_menu_root_items" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "user_sound_menu_root_items" CASCADE;--> statement-breakpoint
ALTER TABLE "user_sound_menu_items" ALTER COLUMN "menu_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sound_menu_items" ADD COLUMN "user_guid" varchar(32);--> statement-breakpoint
ALTER TABLE "user_sound_menu_items" ADD COLUMN "is_server_default" boolean DEFAULT false;--> statement-breakpoint
CREATE INDEX "user_sound_menu_items_root_idx" ON "user_sound_menu_items" USING btree ("user_guid","item_position");