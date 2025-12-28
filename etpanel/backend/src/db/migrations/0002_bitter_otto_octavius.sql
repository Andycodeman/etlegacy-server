CREATE TABLE "sound_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" varchar(64) NOT NULL,
	"original_name" varchar(64) NOT NULL,
	"file_path" varchar(512) NOT NULL,
	"file_size" integer NOT NULL,
	"duration_seconds" integer,
	"added_by_guid" varchar(32) NOT NULL,
	"reference_count" integer DEFAULT 1 NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sound_files_file_path_unique" UNIQUE("file_path")
);
--> statement-breakpoint
CREATE TABLE "sound_playlist_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"playlist_id" integer NOT NULL,
	"user_sound_id" integer NOT NULL,
	"order_number" integer NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sound_playlists" (
	"id" serial PRIMARY KEY NOT NULL,
	"guid" varchar(32) NOT NULL,
	"name" varchar(32) NOT NULL,
	"description" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"current_position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sound_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"sound_file_id" integer NOT NULL,
	"from_guid" varchar(32) NOT NULL,
	"to_guid" varchar(32) NOT NULL,
	"suggested_alias" varchar(32),
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "user_sounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"guid" varchar(32) NOT NULL,
	"sound_file_id" integer NOT NULL,
	"alias" varchar(32) NOT NULL,
	"visibility" varchar(10) DEFAULT 'private' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"guid" varchar(32) NOT NULL,
	"code" varchar(6) NOT NULL,
	"player_name" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	CONSTRAINT "verification_codes_guid_unique" UNIQUE("guid")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "guid" varchar(32);--> statement-breakpoint
ALTER TABLE "sound_playlist_items" ADD CONSTRAINT "sound_playlist_items_playlist_id_sound_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."sound_playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_playlist_items" ADD CONSTRAINT "sound_playlist_items_user_sound_id_user_sounds_id_fk" FOREIGN KEY ("user_sound_id") REFERENCES "public"."user_sounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_shares" ADD CONSTRAINT "sound_shares_sound_file_id_sound_files_id_fk" FOREIGN KEY ("sound_file_id") REFERENCES "public"."sound_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sounds" ADD CONSTRAINT "user_sounds_sound_file_id_sound_files_id_fk" FOREIGN KEY ("sound_file_id") REFERENCES "public"."sound_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sound_files_public_idx" ON "sound_files" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "sound_files_added_by_idx" ON "sound_files" USING btree ("added_by_guid");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_sound_idx" ON "sound_playlist_items" USING btree ("playlist_id","user_sound_id");--> statement-breakpoint
CREATE INDEX "sound_playlist_items_playlist_idx" ON "sound_playlist_items" USING btree ("playlist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlists_guid_name_idx" ON "sound_playlists" USING btree ("guid","name");--> statement-breakpoint
CREATE INDEX "sound_playlists_guid_idx" ON "sound_playlists" USING btree ("guid");--> statement-breakpoint
CREATE INDEX "sound_playlists_public_idx" ON "sound_playlists" USING btree ("is_public");--> statement-breakpoint
CREATE UNIQUE INDEX "share_unique_idx" ON "sound_shares" USING btree ("sound_file_id","from_guid","to_guid");--> statement-breakpoint
CREATE INDEX "sound_shares_to_guid_idx" ON "sound_shares" USING btree ("to_guid");--> statement-breakpoint
CREATE INDEX "sound_shares_pending_idx" ON "sound_shares" USING btree ("to_guid","status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sounds_guid_alias_idx" ON "user_sounds" USING btree ("guid","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sounds_guid_file_idx" ON "user_sounds" USING btree ("guid","sound_file_id");--> statement-breakpoint
CREATE INDEX "user_sounds_guid_idx" ON "user_sounds" USING btree ("guid");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_codes_code_idx" ON "verification_codes" USING btree ("code");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_guid_unique" UNIQUE("guid");