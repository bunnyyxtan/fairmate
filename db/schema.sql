CREATE SCHEMA IF NOT EXISTS "fairmate";

CREATE TABLE IF NOT EXISTS "fairmate"."fairmate_games" (
  "game_id" text PRIMARY KEY NOT NULL,
  "state" jsonb NOT NULL,
  "capability_hash" text NOT NULL,
  "admission_key" text NOT NULL,
  "admission_day" date NOT NULL,
  "status" text NOT NULL,
  "version" bigint DEFAULT 1 NOT NULL,
  "pending_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "inference_owner" text,
  "inference_lease_until" timestamp with time zone,
  "reconciled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "fairmate_games_status_idx"
  ON "fairmate"."fairmate_games" USING btree ("status");

CREATE INDEX IF NOT EXISTS "fairmate_games_admission_idx"
  ON "fairmate"."fairmate_games" USING btree ("admission_day", "admission_key");

CREATE UNIQUE INDEX IF NOT EXISTS "fairmate_games_capability_hash_idx"
  ON "fairmate"."fairmate_games" USING btree ("capability_hash");