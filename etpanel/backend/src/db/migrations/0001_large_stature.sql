CREATE TABLE "map_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"map_name" varchar(100) NOT NULL,
	"config_json" jsonb NOT NULL,
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_configs" ADD CONSTRAINT "map_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_configs" ADD CONSTRAINT "map_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "map_configs_map_name_idx" ON "map_configs" USING btree ("map_name");