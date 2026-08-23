import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "../db/pool.js";

const sql = await readFile(resolve(import.meta.dirname, "../db/schema.sql"), "utf8");

try {
  await pool.query(sql);
  console.log("FairMate database schema is ready");
} finally {
  await pool.end();
}