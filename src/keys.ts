import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, "..");

/**
 * Load the signer private key. Order:
 *  1. OG_WALLET_PRIVATE_KEY env (production: user-owned wallet)
 *  2. .wallet/dev-testnet.key (gitignored burner generated for this proof)
 * The key value is NEVER logged.
 */
export function loadPrivateKey(): string {
  const fromEnv = process.env.OG_WALLET_PRIVATE_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Production requires OG_WALLET_PRIVATE_KEY in the environment; file-backed burner keys are disabled.",
    );
  }
  try {
    const k = readFileSync(resolve(PROJECT_ROOT, ".wallet", "dev-testnet.key"), "utf8").trim();
    if (k) return k;
  } catch {
    /* fall through */
  }
  throw new Error(
    "No signer key: set OG_WALLET_PRIVATE_KEY or provide .wallet/dev-testnet.key (burner).",
  );
}
