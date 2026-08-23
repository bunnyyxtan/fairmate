import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(import.meta.dirname, "../.env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}