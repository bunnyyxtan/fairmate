import "../src/load-env.js";
import pg from "pg";
import { databaseUrlFromEnv } from "../server/runtime-policy.js";

const { Pool } = pg;
const databaseUrl = databaseUrlFromEnv(process.env);

if (!databaseUrl) {
  throw new Error("FAIRMATE_RECOVERY_DATABASE_URL or DATABASE_URL is required");
}

// Serverless instances each hold a small pool; a resident server holds one
// larger pool. Every guarantee that matters (outbox order, wallet nonces,
// inference leases) is enforced by Postgres locks, not pool topology.
export const pool = new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DATABASE_POOL_SIZE ?? (process.env.VERCEL ? 4 : 10)),
  idleTimeoutMillis: 30_000,
});