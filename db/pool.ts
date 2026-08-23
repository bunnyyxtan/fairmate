import "../src/load-env.js";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

// Serverless instances each hold a small pool; a resident server holds one
// larger pool. Every guarantee that matters (outbox order, wallet nonces,
// inference leases) is enforced by Postgres locks, not pool topology.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_SIZE ?? (process.env.VERCEL ? 4 : 10)),
  idleTimeoutMillis: 30_000,
});