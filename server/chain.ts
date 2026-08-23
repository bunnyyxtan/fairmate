/**
 * Referee chain client — owns the wallet, the journal + pot contracts, and a
 * STRICTLY SERIALIZED transaction queue (one referee wallet => nonces must be
 * sequential; parallel sends would collide).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { NETWORKS, PROJECT_ROOT, type NetworkName } from "../src/config";
import { loadPrivateKey } from "../src/keys";
import type { ChainInfo, TxRef } from "../shared/protocol";

const production = process.env.NODE_ENV === "production";
const rawNet = process.env.OG_CHAIN_NETWORK ??
  process.env.OG_TARGET_NETWORK ??
  (production ? undefined : "testnet");
if (rawNet !== "testnet" && rawNet !== "mainnet") {
  throw new Error("Set OG_CHAIN_NETWORK=testnet|mainnet explicitly");
}
if (production && rawNet !== "mainnet") {
  throw new Error("Production FairMate requires OG_CHAIN_NETWORK=mainnet");
}
const netName = rawNet as NetworkName;
const net = NETWORKS[netName];

interface BuildEntry {
  abi: ethers.InterfaceAbi;
  bytecode: string;
}
const build = JSON.parse(
  readFileSync(resolve(PROJECT_ROOT, "build/FairMate.json"), "utf8"),
) as { MoveJournal: BuildEntry; ChallengePot: BuildEntry };

interface Deployment {
  journalAddress: string;
  potAddress: string;
}
function loadDeployment(): Deployment {
  const envJournal = process.env.OG_JOURNAL_ADDRESS;
  const envPot = process.env.OG_POT_ADDRESS;
  if (envJournal && envPot) return { journalAddress: envJournal, potAddress: envPot };
  const primary = resolve(PROJECT_ROOT, `evidence/deployment.${net.name}.json`);
  const file = net.name === "testnet" && !exists(primary)
    ? resolve(PROJECT_ROOT, "evidence/deployment.json")
    : primary;
  const j = JSON.parse(readFileSync(file, "utf8")) as Deployment & { chainId: number };
  if (j.chainId !== net.chainId) {
    throw new Error(
      `deployment.json is for chainId ${j.chainId} but server targets ${net.chainId} — redeploy or set OG_JOURNAL_ADDRESS/OG_POT_ADDRESS`,
    );
  }
  return j;
}

function exists(path: string): boolean {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

const deployment = loadDeployment();
export const provider = new ethers.JsonRpcProvider(net.evmRpc, net.chainId);
export const wallet = new ethers.Wallet(loadPrivateKey(), provider);
export const journal = new ethers.Contract(deployment.journalAddress, build.MoveJournal.abi, wallet);
export const pot = new ethers.Contract(deployment.potAddress, build.ChallengePot.abi, wallet);
const potIface = new ethers.Interface(build.ChallengePot.abi);

export const RESULT_ENUM = { Ongoing: 0, PlayerWin: 1, ModelWin: 2, Draw: 3, Aborted: 4 } as const;

export function chainInfo(): ChainInfo {
  return {
    network: net.displayName,
    chainId: net.chainId,
    explorer: net.explorer,
    journalAddress: deployment.journalAddress,
    potAddress: deployment.potAddress,
  };
}

export function refereeAddress(): string {
  return wallet.address;
}

// ---- serialized tx queue ----------------------------------------------------

let txChain: Promise<unknown> = Promise.resolve();

/**
 * Enqueue an on-chain action. `ref` is mutated in place as the tx progresses
 * (pending -> confirmed/failed) so callers can expose live status. Returns a
 * promise that resolves AFTER confirmation (or failure) for sequencing.
 */
export function enqueueTx(
  label: string,
  ref: TxRef,
  send: () => Promise<ethers.TransactionResponse>,
): Promise<TxRef> {
  const task = async (): Promise<TxRef> => {
    try {
      const tx = await send();
      ref.txHash = tx.hash;
      const rcpt = await tx.wait();
      if (rcpt?.status !== 1) throw new Error(`tx reverted: ${tx.hash}`);
      ref.status = "confirmed";
      ref.blockNumber = rcpt.blockNumber;
      console.log(`[chain] ${label} confirmed ${tx.hash}`);
    } catch (err) {
      ref.status = "failed";
      ref.error = shortChainError(err);
      console.error(`[chain] ${label} FAILED: ${ref.error}`);
    }
    return ref;
  };
  const p = txChain.then(task, task);
  txChain = p.catch(() => undefined);
  return p as Promise<TxRef>;
}

export function decodePotError(err: unknown): string {
  const e = err as { data?: string; info?: { error?: { data?: string } }; revert?: { name?: string } };
  if (e.revert?.name) return e.revert.name;
  const data = e.data ?? e.info?.error?.data;
  if (typeof data === "string") {
    try {
      const parsed = potIface.parseError(data);
      if (parsed) return parsed.name;
    } catch {
      /* not a pot error */
    }
  }
  return shortChainError(err);
}

function shortChainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
}

// ---- pot reads ----------------------------------------------------------------

export interface PotReads {
  potBalanceOg: string;
  perWinBountyOg: string;
  dailyCapOg: string;
  paidInWindowOg: string;
  windowStart: number;
}

let potCache: { at: number; value: PotReads } | null = null;

export async function readPot(): Promise<PotReads> {
  if (potCache && Date.now() - potCache.at < 15_000) return potCache.value;
  const [balanceHex, perWin, cap, paid, windowStart] = await Promise.all([
    provider.send("eth_getBalance", [deployment.potAddress, "latest"]) as Promise<string>,
    pot.perWinBounty() as Promise<bigint>,
    pot.dailyCap() as Promise<bigint>,
    pot.paidInWindow() as Promise<bigint>,
    pot.windowStart() as Promise<bigint>,
  ]);
  const value: PotReads = {
    potBalanceOg: ethers.formatEther(BigInt(balanceHex)),
    perWinBountyOg: ethers.formatEther(perWin),
    dailyCapOg: ethers.formatEther(cap),
    paidInWindowOg: ethers.formatEther(paid),
    windowStart: Number(windowStart),
  };
  potCache = { at: Date.now(), value };
  return value;
}

/** Static pre-check for award(); returns null if it would succeed, else the revert name. */
export async function awardPrecheck(gameId: string): Promise<string | null> {
  try {
    await pot.award.staticCall(gameId);
    return null;
  } catch (err) {
    return decodePotError(err);
  }
}
