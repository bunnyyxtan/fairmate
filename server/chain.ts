/**
 * Referee chain client. Cross-process nonce serialization is provided by the
 * PostgreSQL wallet advisory lock in fairmate-store.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { NETWORKS, PROJECT_ROOT, type NetworkName } from "../src/config";
import { loadPrivateKey } from "../src/keys";
import type { ChainInfo } from "../shared/protocol";

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
const journalIface = new ethers.Interface(build.MoveJournal.abi);

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

export type PreparedChainCall =
  | { kind: "start"; args: [string, string, string, string, string] }
  | { kind: "ply"; args: [string, number, string, string, string, string] }
  | { kind: "end"; args: [string, number, string] }
  | { kind: "award"; args: [string] };

export interface SignedChainTransaction {
  rawTx: string;
  txHash: string;
  nonce: number;
}

/** Populate and sign, but do not broadcast. Caller must hold the DB wallet lock. */
export async function prepareTransaction(call: PreparedChainCall): Promise<SignedChainTransaction> {
  const target = call.kind === "award" ? deployment.potAddress : deployment.journalAddress;
  const iface = call.kind === "award" ? potIface : journalIface;
  const method =
    call.kind === "start"
      ? "startGame"
      : call.kind === "ply"
        ? "commitMove"
        : call.kind === "end"
          ? "endGame"
          : "award";
  const data = iface.encodeFunctionData(method, call.args);
  const populated = await wallet.populateTransaction({ to: target, data });
  const rawTx = await wallet.signTransaction(populated);
  if (populated.nonce == null) throw new Error("wallet did not populate a transaction nonce");
  return { rawTx, txHash: ethers.keccak256(rawTx), nonce: populated.nonce };
}

export async function transactionReceipt(txHash: string): Promise<ethers.TransactionReceipt | null> {
  return provider.getTransactionReceipt(txHash);
}

export async function broadcastRawTransaction(rawTx: string): Promise<ethers.TransactionReceipt> {
  const txHash = ethers.keccak256(rawTx);
  let receipt: ethers.TransactionReceipt | null;
  try {
    const tx = await provider.broadcastTransaction(rawTx);
    receipt = await tx.wait();
  } catch (error) {
    // "already known" and "nonce too low" are normal recovery outcomes when
    // the exact persisted bytes reached another RPC node before a crash.
    await provider.getTransaction(txHash);
    receipt = await provider.waitForTransaction(
      txHash,
      1,
      Number(process.env.FAIRMATE_TX_WAIT_MS ?? 120_000),
    );
    if (!receipt) throw error;
  }
  if (!receipt) throw new Error(`transaction was not mined before timeout: ${txHash}`);
  return receipt;
}

export interface JournalMove {
  moveNo: number;
  mover: number;
  fenBeforeHash: string;
  fenAfterHash: string;
  san: string;
  receiptHash: string;
}

export interface JournalSnapshot {
  exists: boolean;
  startFenHash: string;
  player: string;
  moveCount: number;
  result: number;
  starts: Array<{
    startFenHash: string;
    player: string;
    model: string;
    verificationIdentity: string;
    txHash: string;
    blockNumber: number;
  }>;
  moves: JournalMove[];
  ended: { result: number; finalFenHash: string; moveCount: number } | null;
  rewarded: boolean;
  award: { txHash: string; blockNumber: number; amount: string } | null;
}

/** Strongly typed chain read used by fail-closed startup reconciliation. */
export async function readJournalGame(gameId: string, fromBlock = 0): Promise<JournalSnapshot> {
  const meta = (await journal.getGame(gameId)) as {
    startFenHash: string;
    player: string;
    moveCount: bigint;
    result: bigint;
    exists: boolean;
  };
  if (!meta.exists) {
    return {
      exists: false,
      startFenHash: ethers.ZeroHash,
      player: ethers.ZeroAddress,
      moveCount: 0,
      result: 0,
      starts: [],
      moves: [],
      ended: null,
      rewarded: false,
      award: null,
    };
  }
  const [startEvents, moveEvents, endEvents, awardEvents, rewarded] = await Promise.all([
    journal.queryFilter(journal.filters.GameStarted(gameId), fromBlock, "latest"),
    journal.queryFilter(journal.filters.MoveCommitted(gameId), fromBlock, "latest"),
    journal.queryFilter(journal.filters.GameEnded(gameId), fromBlock, "latest"),
    pot.queryFilter(pot.filters.WinAwarded(gameId), fromBlock, "latest"),
    pot.rewarded(gameId) as Promise<boolean>,
  ]);
  const moves = moveEvents.map((event) => {
    const args = (event as ethers.EventLog).args;
    return {
      moveNo: Number(args.moveNo),
      mover: Number(args.mover),
      fenBeforeHash: String(args.fenBeforeHash),
      fenAfterHash: String(args.fenAfterHash),
      san: String(args.san),
      receiptHash: String(args.receiptHash),
    };
  });
  const lastEnd = endEvents.at(-1) as ethers.EventLog | undefined;
  const lastAward = awardEvents.at(-1) as ethers.EventLog | undefined;
  const ended = lastEnd
    ? {
        result: Number(lastEnd.args.result),
        finalFenHash: String(lastEnd.args.finalFenHash),
        moveCount: Number(lastEnd.args.moveCount),
      }
    : null;
  return {
    exists: true,
    startFenHash: String(meta.startFenHash),
    player: String(meta.player),
    moveCount: Number(meta.moveCount),
    result: Number(meta.result),
    starts: startEvents.map((event) => {
      const log = event as ethers.EventLog;
      return {
        startFenHash: String(log.args.startFenHash),
        player: String(log.args.player),
        model: String(log.args.model),
        verificationIdentity: String(log.args.verificationIdentity),
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      };
    }),
    moves,
    ended,
    rewarded: Boolean(rewarded),
    award: lastAward
      ? {
          txHash: lastAward.transactionHash,
          blockNumber: lastAward.blockNumber,
          amount: ethers.formatEther(lastAward.args.amount as bigint),
        }
      : null,
  };
}

export async function readAward(
  gameId: string,
  fromBlock = 0,
): Promise<{ rewarded: boolean; txHash?: string; blockNumber?: number; amountOg?: string }> {
  const [rewarded, events] = await Promise.all([
    pot.rewarded(gameId) as Promise<boolean>,
    pot.queryFilter(pot.filters.WinAwarded(gameId), fromBlock, "latest"),
  ]);
  const event = events.at(-1) as ethers.EventLog | undefined;
  return {
    rewarded: Boolean(rewarded),
    txHash: event?.transactionHash,
    blockNumber: event?.blockNumber,
    amountOg: event ? ethers.formatEther(event.args.amount as bigint) : undefined,
  };
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
