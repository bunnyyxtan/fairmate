import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const envFile = resolve(import.meta.dirname, "../.env");

// Values already present in the environment always win; the .env file only
// fills gaps. (process.loadEnvFile overrides existing variables, which once
// sent a production migration to the development database.)
if (existsSync(envFile)) {
  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined && typeof value === "string") {
      process.env[key] = value;
    }
  }
}
