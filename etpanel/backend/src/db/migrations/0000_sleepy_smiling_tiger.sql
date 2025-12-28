CREATE TABLE "config_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"config_json" jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"killer_guid" varchar(32),
	"victim_guid" varchar(32),
	"killer_name" varchar(100),
	"victim_name" varchar(100),
	"weapon" varchar(50),
	"map" varchar(100),
	"is_team_kill" boolean DEFAULT false NOT NULL,
	"killer_is_bot" boolean DEFAULT false NOT NULL,
	"victim_is_bot" boolean DEFAULT false NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_matchups" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_guid" varchar(32) NOT NULL,
	"opponent_guid" varchar(32) NOT NULL,
	"opponent_name" varchar(100) NOT NULL,
	"opponent_is_bot" boolean DEFAULT false NOT NULL,
	"weapon" varchar(50) NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"deaths" integer DEFAULT 0 NOT NULL,
	"team_kills" integer DEFAULT 0 NOT NULL,
	"team_deaths" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"guid" varchar(32) NOT NULL,
	"name" varchar(100) NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"deaths" integer DEFAULT 0 NOT NULL,
	"bot_kills" integer DEFAULT 0 NOT NULL,
	"bot_deaths" integer DEFAULT 0 NOT NULL,
	"suicides" integer DEFAULT 0 NOT NULL,
	"playtime_seconds" integer DEFAULT 0 NOT NULL,
	"last_seen" timestamp DEFAULT now() NOT NULL,
	"first_seen" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" varchar(100) NOT NULL,
	"description" text,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp NOT NULL,
	"config_json" jsonb,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"approved_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"event_type" varchar(50) NOT NULL,
	"config_json" jsonb NOT NULL,
	"cron_expression" varchar(100),
	"one_time_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"refresh_token" varchar(500) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255),
	"display_name" varchar(100) NOT NULL,
	"role" varchar(20) DEFAULT 'user' NOT NULL,
	"google_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "config_snapshots" ADD CONSTRAINT "config_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_events" ADD CONSTRAINT "scheduled_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_matchup_idx" ON "player_matchups" USING btree ("player_guid","opponent_guid","weapon");--> statement-breakpoint
CREATE UNIQUE INDEX "player_stats_guid_idx" ON "player_stats" USING btree ("guid");