import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root (one level above src/). */
export const PROJECT_ROOT = resolve(__dirname, "..");

/** Gitignored evidence output directory — never committed. */
export const EVIDENCE_DIR = resolve(PROJECT_ROOT, "evidence");

export type NetworkName = "testnet" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  displayName: string;
  chainId: number;
  evmRpc: string;
  explorer: string;
  storageIndexer: string;
  /** 0G Compute LedgerManager contract address (from SDK CONTRACT_ADDRESSES). */
  ledgerManager: string;
  hasFaucet: boolean;
}

/** 0G network facts — chain ids, RPCs and the Compute ledger contract from the official SDK. */
export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    displayName: "0G Galileo Testnet",
    chainId: 16602,
    evmRpc: "https://evmrpc-testnet.0g.ai",
    explorer: "https://chainscan-galileo.0g.ai",
    storageIndexer: "https://indexer-storage-testnet-turbo.0g.ai",
    // From @0gfoundation/0g-compute-ts-sdk CONTRACT_ADDRESSES.testnet.ledger
    ledgerManager: "0xE70830508dAc0A97e6c087c75f402f9Be669E406",
    hasFaucet: true,
  },
  mainnet: {
    name: "mainnet",
    displayName: "0G Mainnet (Aristotle)",
    chainId: 16661,
    evmRpc: "https://evmrpc.0g.ai",
    explorer: "https://chainscan.0g.ai",
    storageIndexer: "https://indexer-storage-turbo.0g.ai",
    // From @0gfoundation/0g-compute-ts-sdk CONTRACT_ADDRESSES.mainnet.ledger
    ledgerManager: "0x2dE54c845Cd948B72D2e32e39586fe89607074E3",
    hasFaucet: false,
  },
};

/**
 * Resolve the target network from an explicit CLI arg or the OG_TARGET_NETWORK
 * env var. There is NO default: a mainnet run must be chosen explicitly, and we
 * never silently pick a chain. `--network=mainnet` / `--network=testnet`.
 */
export function resolveNetwork(argv: string[], env: NodeJS.ProcessEnv): NetworkConfig {
  const fromArg = findFlag(argv, "network");
  const raw = fromArg ?? env.OG_TARGET_NETWORK;
  if (!raw) {
    throw new Error(
      "No network selected. Pass --network=testnet|mainnet or set OG_TARGET_NETWORK. " +
        "Mainnet must be chosen explicitly and requires a funded wallet (no faucet).",
    );
  }
  if (raw !== "testnet" && raw !== "mainnet") {
    throw new Error(`Invalid network '${raw}'. Expected 'testnet' or 'mainnet'.`);
  }
  return NETWORKS[raw];
}

/** Read a required secret from env, failing loudly. Never logs the value. */
export function requireSecret(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required secret ${name}. Set it in the environment; it is never printed.`);
  }
  return v.trim();
}

/** Parse a `--flag=value` style CLI argument. Returns undefined if absent. */
export function findFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === `--${name}`) return "true";
  }
  return undefined;
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`) || findFlag(argv, name) === "true";
}
