CREATE TABLE "unfinished_sounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_guid" varchar(32) NOT NULL,
	"temp_id" varchar(36) NOT NULL,
	"alias" varchar(32) NOT NULL,
	"original_name" varchar(255) NOT NULL,
	"file_size" integer NOT NULL,
	"duration_seconds" integer,
	"file_extension" varchar(10) DEFAULT '.mp3' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unfinished_sounds_temp_id_unique" UNIQUE("temp_id")
);
--> statement-breakpoint
CREATE INDEX "unfinished_sounds_guid_idx" ON "unfinished_sounds" USING btree ("user_guid");--> statement-breakpoint
CREATE UNIQUE INDEX "unfinished_sounds_guid_alias_idx" ON "unfinished_sounds" USING btree ("user_guid","alias");