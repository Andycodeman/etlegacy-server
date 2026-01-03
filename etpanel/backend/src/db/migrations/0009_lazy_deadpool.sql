CREATE TABLE "player_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"guid" varchar(32) NOT NULL,
	"quick_cmd_prefix" varchar(4) DEFAULT '*' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "player_settings_guid_unique" UNIQUE("guid")
);
--> statement-breakpoint
CREATE TABLE "quick_command_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"guid" varchar(32) NOT NULL,
	"alias" varchar(16) NOT NULL,
	"user_sound_id" integer,
	"sound_file_id" integer,
	"is_public" boolean DEFAULT false NOT NULL,
	"chat_text" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quick_command_aliases" ADD CONSTRAINT "quick_command_aliases_user_sound_id_user_sounds_id_fk" FOREIGN KEY ("user_sound_id") REFERENCES "public"."user_sounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_command_aliases" ADD CONSTRAINT "quick_command_aliases_sound_file_id_sound_files_id_fk" FOREIGN KEY ("sound_file_id") REFERENCES "public"."sound_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_player_settings_guid" ON "player_settings" USING btree ("guid");--> statement-breakpoint
CREATE UNIQUE INDEX "quick_cmd_guid_alias_idx" ON "quick_command_aliases" USING btree ("guid","alias");--> statement-breakpoint
CREATE INDEX "quick_cmd_guid_idx" ON "quick_command_aliases" USING btree ("guid");