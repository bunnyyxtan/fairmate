import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("standalone migration contains the complete FairMate schema", () => {
  const sql = readFileSync(path.join(projectRoot, "db/schema.sql"), "utf8");
  const packageJson = JSON.parse(
    readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(packageJson.scripts?.["db:migrate"], "tsx scripts/migrate.ts");
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS "fairmate"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "fairmate"\."fairmate_games"/);
  assert.match(sql, /"game_id" text PRIMARY KEY NOT NULL/);
  assert.match(sql, /"pending_actions" jsonb DEFAULT '\[\]'::jsonb NOT NULL/);
  assert.match(sql, /"inference_lease_until" timestamp with time zone/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "fairmate_games_capability_hash_idx"/);
});