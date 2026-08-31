import { Chess } from "chess.js";
import { ethers } from "ethers";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalHash } from "../shared/canonical.js";
import { computeReceiptHash } from "../shared/receipt.js";
import { FAIRMATE_ROUTER_PROVIDER } from "../shared/router-policy.js";
import type { GameState, PlyRecord, ReceiptBundle } from "../shared/protocol.js";
import { CHESS_SYSTEM_PROMPT, buildMoveUserPrompt, parseMove } from "../src/chess-agent.js";
import { completion, getComputeState } from "./compute-service.js";
import {
  broadcastRawTransaction,
  chainInfo,
  prepareTransaction,
  readAward,
  readJournalGame,
  readPot,
  transactionReceipt,
  verifyStakeDeposit,
} from "./chain.js";
import {
  FairmateStore,
  newAction,
  type Queryable,
  type StoredGame,
} from "./fairmate-store.js";
import { createClock, stopClock, tickClock } from "./game-clock.js";
import {
  applyPly,
  chessFor,
  flagFallOutcome,
  planEnd,
  voidPendingAward,
  voidPendingRefund,
} from "./referee-state.js";
import { DurableOutbox } from "./durable-outbox.js";
import { background } from "./background.js";
import { verifyJournalState } from "./journal-verifier.js";

const MAX_ACTIVE_GAMES = Number(process.env.FAIRMATE_MAX_ACTIVE_GAMES ?? 3);
const MAX_GAMES_PER_IP_PER_DAY = Number(process.env.FAIRMATE_MAX_GAMES_PER_IP_PER_DAY ?? 5);
const MAX_GAMES_GLOBAL_PER_DAY = Number(process.env.FAIRMATE_MAX_GAMES_GLOBAL_PER_DAY ?? 12);
const MODEL_MOVE_ATTEMPTS = 2;
const MODEL_TEMPERATURE = 0.2;
const IDLE_ABORT_MS = Number(process.env.FAIRMATE_IDLE_ABORT_MS ?? 10 * 60 * 1000);
const GAME_CLOCK_MS = Number(process.env.FAIRMATE_CLOCK_MS ?? 5 * 60 * 1000);
/** 0G a player stakes into the ChallengePot to start a prize game. */
export const ENTRY_FEE_OG = process.env.FAIRMATE_ENTRY_FEE_OG ?? "0.1";
const ENTRY_FEE_WEI = ethers.parseEther(ENTRY_FEE_OG);
const INFERENCE_LEASE_MS = 5 * 60 * 1000;
const START_FEN = new Chess().fen();
const store = new FairmateStore();
const outbox = new DurableOutbox(store, {
  prepare: prepareTransaction,
  receipt: transactionReceipt,
  broadcast: broadcastRawTransaction,
  award: readAward,
  perWinBountyOg: async () => (await readPot()).perWinBountyOg,
});
let reconciled = false;

export interface CreatedGame {
  game: GameState;
  accessToken: string;
}

export class RefereeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Raised only when the journal and local state definitively disagree. */
class ReconcileMismatch extends Error {}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function checkToken(row: StoredGame, token: string | undefined): void {
  if (!token) throw new RefereeError(403, "game access token required");
  const expected = Buffer.from(row.capabilityHash, "hex");
  const actual = Buffer.from(tokenHash(token), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new RefereeError(403, "invalid game access token");
  }
}

function clone(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function ensureReady(): void {
  if (!reconciled) throw new RefereeError(503, "referee recovery is not complete");
}

async function owned(gameId: string, accessToken: string | undefined): Promise<StoredGame> {
  ensureReady();
  const row = await store.get(gameId);
  if (!row) throw new RefereeError(404, "no such game");
  checkToken(row, accessToken);
  return row;
}

const drainPendingActions = (): Promise<void> => outbox.drain();

async function expireLocked(
  row: StoredGame,
  now = Date.now(),
  client?: Queryable,
): Promise<boolean> {
  const state = row.state;
  if (state.status !== "awaiting_player" && state.status !== "model_thinking") return false;
  const expired = tickClock(state.clock, now);
  if (!expired) return false;
  const chess = chessFor(state);
  const outcome = flagFallOutcome(expired, state.sans.length);
  const action = planEnd(state, chess, outcome.result, outcome.reason);
  await store.save(row.gameId, state, [...row.pendingActions, action], client);
  return true;
}

/**
 * Expires flag-fallen games synchronously so a stale board never blocks
 * admission. Serverless instances have no resident sweep timer; without this
 * a create request could 429 off counts inflated by games whose clocks ran
 * out while nobody was watching.
 */
async function expireOverdueGames(): Promise<void> {
  const now = Date.now();
  let anchored = false;
  for (const candidate of await store.listRecoverable()) {
    const status = candidate.state.status;
    if (status !== "awaiting_player" && status !== "model_thinking") continue;
    const probeClock = JSON.parse(JSON.stringify(candidate.state.clock)) as GameState["clock"];
    if (!tickClock(probeClock, now)) continue;
    await store.withGameLock(candidate.gameId, async (client) => {
      const row = await store.get(candidate.gameId, client);
      if (row && (await expireLocked(row, now, client))) anchored = true;
    });
  }
  if (anchored) background("admission expiry anchor", drainPendingActions());
}

export async function createGame(
  ip: string,
  playerAddress?: string,
  stakeTxHash?: string,
): Promise<CreatedGame> {
  ensureReady();
  const compute = getComputeState();
  if (!compute.ready || !compute.selection) {
    throw new RefereeError(
      503,
      compute.bootError ?? "TEE attestation still in progress, try again shortly",
    );
  }
  if (playerAddress) {
    if (!ethers.isAddress(playerAddress)) {
      throw new RefereeError(400, `not a valid payout address: ${playerAddress}`);
    }
  } else {
    playerAddress = undefined;
  }
  let stake: GameState["stake"];
  if (playerAddress) {
    if (!stakeTxHash) {
      throw new RefereeError(
        402,
        `prize games require a ${ENTRY_FEE_OG} 0G entry stake sent to the ChallengePot, include its transaction hash`,
      );
    }
    if (!ethers.isHexString(stakeTxHash, 32)) {
      throw new RefereeError(400, "stakeTxHash must be a 0x-prefixed 32-byte transaction hash");
    }
    const check = await verifyStakeDeposit(stakeTxHash, playerAddress, ENTRY_FEE_WEI);
    if (!check.ok) throw new RefereeError(check.retryable ? 409 : 400, check.reason);
    stake = {
      txHash: stakeTxHash.toLowerCase(),
      from: ethers.getAddress(playerAddress),
      amountOg: check.amountOg,
      blockNumber: check.blockNumber,
      verifiedAt: Date.now(),
    };
  } else if (stakeTxHash) {
    throw new RefereeError(
      400,
      "a stake needs a payout address on the same game, practice games are free",
    );
  }
  const accessToken = randomBytes(32).toString("base64url");
  const gameId = ethers.hexlify(ethers.randomBytes(32));
  const admissionKey = store.admissionKey(ip);
  const day = today();
  const now = Date.now();
  // The player's clock runs from the moment the board is playable; chain
  // anchoring happens off the critical path and charges time to nobody.
  const clock = createClock(now, GAME_CLOCK_MS);
  const state: GameState = {
    gameId,
    playerAddress: playerAddress ?? null,
    ...(stake ? { stake } : {}),
    playerColor: "w",
    fen: START_FEN,
    sans: [],
    status: "awaiting_player",
    result: "ongoing",
    clock,
    plies: [],
    chain: chainInfo(),
    startTx: { status: "pending" },
    model: compute.selection.model,
    provider: compute.selection.provider,
    effectiveSigner: compute.selection.effectiveSigner,
    verificationScheme: compute.selection.verificationScheme,
    computeCostNeuron: "0",
    createdAt: now,
    updatedAt: now,
  };
  const action = newAction("start", {
    gameId,
    startFenHash: canonicalHash(START_FEN),
    player: playerAddress ?? ethers.ZeroAddress,
    model: state.model,
    verificationIdentity: state.effectiveSigner,
  });
  await expireOverdueGames();
  await store.withAdmissionLock(async (client) => {
    const counts = await store.admissionCounts(day, admissionKey, client);
    if (counts.active >= MAX_ACTIVE_GAMES) {
      throw new RefereeError(429, "all boards are busy, try again in a minute");
    }
    if (counts.activeForKey >= 1) {
      throw new RefereeError(429, "you already have an active game, finish or resign it first");
    }
    if (counts.dailyForKey >= MAX_GAMES_PER_IP_PER_DAY) {
      throw new RefereeError(
        429,
        "daily game limit reached for your connection, try again tomorrow",
      );
    }
    if (counts.dailyGlobal >= MAX_GAMES_GLOBAL_PER_DAY) {
      throw new RefereeError(
        429,
        "today's match allocation is complete, try again tomorrow",
      );
    }
    if (stake) {
      const first = await store.registerStake(stake.txHash, gameId, client);
      if (!first) {
        throw new RefereeError(
          409,
          "this stake transaction has already been used for another game, send a fresh stake",
        );
      }
    }
    await store.insert(
      {
        gameId,
        state,
        capabilityHash: tokenHash(accessToken),
        admissionKey,
        admissionDay: day,
        status: state.status,
        pendingActions: [action],
      },
      client,
    );
  });
  background(`start anchor ${gameId}`, drainPendingActions());
  return { game: clone(state), accessToken };
}

export async function getGame(
  gameId: string,
  accessToken: string | undefined,
): Promise<GameState> {
  await owned(gameId, accessToken);
  let expired = false;
  await store.withGameLock(gameId, async (client) => {
    const row = await store.get(gameId, client);
    if (!row) throw new RefereeError(404, "no such game");
    checkToken(row, accessToken);
    expired = await expireLocked(row, Date.now(), client);
  });
  if (expired) background(`flag-fall anchor ${gameId}`, drainPendingActions());
  const row = (await store.get(gameId))!;
  return clone(row.state);
}

function makePly(
  state: GameState,
  mover: "player" | "model",
  san: string,
  fenBefore: string,
  fenAfter: string,
  receipt: ReceiptBundle | undefined,
  why?: string,
): PlyRecord {
  return {
    ply: state.plies.length + 1,
    mover,
    san,
    fenBefore,
    fenAfter,
    fenBeforeHash: canonicalHash(fenBefore),
    fenAfterHash: canonicalHash(fenAfter),
    receipt,
    receiptHash: receipt?.receiptHash ?? null,
    computeCostNeuron:
      receipt?.scheme === "router-teetls" ? receipt.trace.billing.totalCostNeuron : undefined,
    why,
    chain: { status: "pending" },
    at: Date.now(),
  };
}

export async function playerMove(
  gameId: string,
  san: string,
  accessToken: string | undefined,
): Promise<GameState> {
  await owned(gameId, accessToken);
  let timedOut = false;
  const saved = await store.withGameLock(gameId, async (client) => {
    const row = await store.get(gameId, client);
    if (!row) throw new RefereeError(404, "no such game");
    checkToken(row, accessToken);
    if (await expireLocked(row, Date.now(), client)) {
      timedOut = true;
      return row;
    }
    if (row.state.status !== "awaiting_player") {
      throw new RefereeError(409, `not your turn (status: ${row.state.status})`);
    }
    const probe = chessFor(row.state);
    const before = probe.fen();
    let move: { san: string };
    try {
      move = probe.move(san);
    } catch {
      throw new RefereeError(400, `illegal move: ${san}`);
    }
    // Applied immediately: board, SAN line and clocks advance now; the
    // journal anchor trails in the queue and never blocks the player.
    const ply = makePly(row.state, "player", move.san, before, probe.fen(), undefined);
    const followUp = applyPly(row.state, ply, Date.now());
    const queue = [...row.pendingActions, newAction("ply", { gameId, ply })];
    if (followUp) queue.push(followUp);
    return store.save(gameId, row.state, queue, client);
  });
  background(`move anchor ${gameId}`, drainPendingActions());
  if (timedOut) {
    throw new RefereeError(409, `game ended: ${saved.state.endReason ?? "clock expired"}`);
  }
  if (saved.state.status === "model_thinking") {
    background(`model resume ${gameId}`, resumeModel(gameId));
  }
  return clone(saved.state);
}

function directBundle(
  state: GameState,
  value: Awaited<ReturnType<typeof completion>>,
): ReceiptBundle {
  if (value.transport === "router") return value.value.receipt;
  return {
    scheme: "direct-teeml",
    chatID: value.value.chatID,
    model: state.model,
    provider: state.provider,
    sigText: value.value.signature.text,
    signature: value.value.signature.signature,
    effectiveSigner: value.value.effectiveSigner,
    rawBody: value.value.rawBody,
    rawBodySha256: value.value.rawBodySha256,
    requestBodyJson: value.value.requestBodyJson,
    receipt: value.value.receipt,
    receiptHash: computeReceiptHash({
      sigText: value.value.signature.text,
      signature: value.value.signature.signature,
      rawBodySha256: value.value.rawBodySha256,
    }),
    latencyMs: value.value.latencyMs,
  };
}

async function resumeModel(gameId: string): Promise<void> {
  if (!getComputeState().ready) return;
  if (!(await store.claimInference(gameId, INFERENCE_LEASE_MS))) return;
  const heartbeat = setInterval(
    () => background(`inference lease renewal ${gameId}`, store.renewInference(gameId, INFERENCE_LEASE_MS)),
    Math.floor(INFERENCE_LEASE_MS / 3),
  );
  heartbeat.unref();
  try {
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= MODEL_MOVE_ATTEMPTS; attempt++) {
      const beforeRow = await store.get(gameId);
      if (!beforeRow || beforeRow.state.status !== "model_thinking") return;
      // Pin-rotation guard: a game carries the provider identity it was
      // created under (GameStarted anchors that identity on-chain). If the
      // active pin has rotated since, resuming would mint receipts under the
      // new provider inside a game journaled to the old one — mixed-identity
      // evidence. Fail closed instead: abort the game, stake refundable.
      if (beforeRow.state.provider.toLowerCase() !== FAIRMATE_ROUTER_PROVIDER.toLowerCase()) {
        await faultGame(
          gameId,
          `provider re-pinned since this game started (game bound to ${beforeRow.state.provider}, active pin ${FAIRMATE_ROUTER_PROVIDER})`,
        );
        return;
      }
      const chess = chessFor(beforeRow.state);
      const legalSans = chess.moves();
      const prompt = buildMoveUserPrompt({
        fen: chess.fen(),
        turn: chess.turn() as "w" | "b",
        fullmoveNumber: chess.moveNumber(),
        legalSans,
        recentHistory: beforeRow.state.sans.slice(-8),
        feedback,
      });
      const answer = await completion(
        [
          { role: "system", content: CHESS_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        MODEL_TEMPERATURE,
      );
      let timedOut = false;
      await store.withGameLock(gameId, async (client) => {
        const row = await store.get(gameId, client);
        if (
          row &&
          row.state.status === "model_thinking" &&
          row.inferenceOwner === store.instanceId
        ) {
          timedOut = await expireLocked(row, Date.now(), client);
        }
      });
      if (timedOut) {
        background(`flag-fall anchor ${gameId}`, drainPendingActions());
        return;
      }
      const parsed = parseMove(answer.value.content, legalSans);
      if (!parsed) {
        feedback = `Previous reply was not one legal move: ${answer.value.content.slice(0, 80)}`;
        continue;
      }
      await store.withGameLock(gameId, async (client) => {
        const row = await store.get(gameId, client);
        if (
          !row ||
          row.state.status !== "model_thinking" ||
          row.inferenceOwner !== store.instanceId
        ) return;
        const current = chessFor(row.state);
        const fenBefore = current.fen();
        const played = current.move(parsed.san);
        if (!played) throw new Error("model move became illegal before commit");
        // The reply is TEE-verified in the completion path before this point;
        // it hits the board now and its journal anchor trails in the queue.
        const bundle = directBundle(row.state, answer);
        const ply = makePly(row.state, "model", played.san, fenBefore, current.fen(), bundle, parsed.why || undefined);
        const followUp = applyPly(row.state, ply, Date.now());
        const queue = [...row.pendingActions, newAction("ply", { gameId, ply })];
        if (followUp) queue.push(followUp);
        await store.save(gameId, row.state, queue, client);
      });
      background(`model move anchor ${gameId}`, drainPendingActions());
      return;
    }
    await faultGame(gameId, "model could not produce a legal move within bounded retries");
  } catch (error) {
    await faultGame(gameId, error instanceof Error ? error.message : String(error));
  } finally {
    clearInterval(heartbeat);
    await store.releaseInference(gameId);
  }
}

async function faultGame(gameId: string, reason: string): Promise<void> {
  await store.withGameLock(gameId, async (client) => {
    const row = await store.get(gameId, client);
    if (!row || row.state.status !== "model_thinking") return;
    row.state.faultReason = reason;
    const chess = chessFor(row.state);
    const action = planEnd(
      row.state,
      chess,
      "aborted",
      "model fault — game aborted, no fabricated move",
    );
    await store.save(gameId, row.state, [...row.pendingActions, action], client);
  });
  background(`fault anchor ${gameId}`, drainPendingActions());
}

export async function resign(
  gameId: string,
  accessToken: string | undefined,
): Promise<GameState> {
  await owned(gameId, accessToken);
  let timedOut = false;
  const saved = await store.withGameLock(gameId, async (client) => {
    const row = await store.get(gameId, client);
    if (!row) throw new RefereeError(404, "no such game");
    checkToken(row, accessToken);
    if (await expireLocked(row, Date.now(), client)) {
      timedOut = true;
      return row;
    }
    if (row.state.status === "ended" || row.state.status === "fault") {
      throw new RefereeError(409, "game already over");
    }
    const chess = chessFor(row.state);
    // Resigning before the first move is an abort, not a loss: no inference
    // was consumed, so a staked player gets the entry refunded (same rule as
    // a zero-move flag fall).
    const action =
      row.state.sans.length === 0
        ? planEnd(row.state, chess, "aborted", "no moves played, game aborted by the player")
        : planEnd(row.state, chess, "model_win", "resignation");
    return store.save(gameId, row.state, [...row.pendingActions, action], client);
  });
  background(`resign anchor ${gameId}`, drainPendingActions());
  if (timedOut) {
    throw new RefereeError(409, `game ended: ${saved.state.endReason ?? "clock expired"}`);
  }
  return clone(saved.state);
}

export async function sweepIdleGames(): Promise<void> {
  if (!reconciled) return;
  const now = Date.now();
  const candidates = await store.listRecoverable();
  // Retry any stuck anchors once per sweep; the wallet lock serializes drains.
  if (candidates.some((row) => row.pendingActions.length > 0)) {
    background("sweep outbox drain", drainPendingActions());
  }
  for (const candidate of candidates) {
    await store.withGameLock(candidate.gameId, async (client) => {
      const row = await store.get(candidate.gameId, client);
      if (!row) return;
      if (await expireLocked(row, now, client)) return;
      if (
        (row.state.status === "awaiting_player" || row.state.status === "model_thinking") &&
        now - row.state.updatedAt > IDLE_ABORT_MS
      ) {
        const chess = chessFor(row.state);
        const action = planEnd(row.state, chess, "aborted", "abandoned, idle timeout");
        await store.save(row.gameId, row.state, [...row.pendingActions, action], client);
      }
    });
    const row = await store.get(candidate.gameId);
    if (row?.pendingActions.length) background("outbox drain", drainPendingActions());
    if (row?.state.status === "model_thinking") {
      background(`model resume ${row.gameId}`, resumeModel(row.gameId));
    }
  }
}

async function reconcile(row: StoredGame): Promise<void> {
  const chain = await readJournalGame(row.gameId, row.state.startTx.blockNumber ?? 0);
  try {
    verifyJournalState(row.state, chain, START_FEN);
    chessFor(row.state);
  } catch (error) {
    throw new ReconcileMismatch(error instanceof Error ? error.message : String(error));
  }
}

async function reconcileStable(gameId: string, allowDrain: boolean): Promise<StoredGame> {
  for (;;) {
    let verified: StoredGame | null = null;
    let pendingCount = 0;
    await store.withGameLock(gameId, async (client) => {
      const row = await store.get(gameId, client);
      if (!row) throw new RefereeError(404, "no such game");
      if (row.pendingActions.length > 0) {
        pendingCount = row.pendingActions.length;
        return;
      }
      await reconcile(row);
      await store.markReconciled(gameId, client);
      verified = row;
    });
    if (verified) return verified;
    if (pendingCount === 0) throw new Error(`unable to reconcile ${gameId}`);
    if (!allowDrain) {
      throw new RefereeError(
        409,
        `evidence is available once chain sync completes, ${pendingCount} anchor${pendingCount === 1 ? "" : "s"} pending`,
      );
    }
    // Never acquire the wallet lock while holding a game lock.
    await drainPendingActions();
  }
}

/**
 * Reconciles only active games and rows that were pending when recovery began.
 * A definitive journal/state mismatch freezes that one game fail-closed and
 * never blocks the rest of the service; infrastructure errors still abort boot.
 */
export async function recoverReferee(): Promise<void> {
  reconciled = false;
  const beforeDrain = await store.listRecoverable();
  await drainPendingActions();
  const scopedIds = new Set(beforeDrain.map((row) => row.gameId));
  for (const row of await store.listRecoverable()) scopedIds.add(row.gameId);
  for (const gameId of scopedIds) {
    const row = await store.get(gameId);
    if (!row || row.state.startTx.status === "failed") continue;
    try {
      await reconcileStable(gameId, true);
    } catch (error) {
      if (!(error instanceof ReconcileMismatch)) throw error;
      const reason = error.message;
      console.error(
        `[referee] RECOVERY MISMATCH for ${gameId}: ${reason} — freezing game fail-closed`,
      );
      await store.withGameLock(gameId, async (client) => {
        const fresh = await store.get(gameId, client);
        if (!fresh) return;
        const state = fresh.state;
        if (state.status !== "ended") {
          state.status = "fault";
          state.result = "aborted";
        }
        state.faultReason = `recovery reconciliation failed: ${reason}`;
        state.endReason = state.endReason ?? "frozen at recovery, journal and local state disagree";
        stopClock(state.clock, Date.now());
        // The queue is being cleared, so any unpaid award or refund can never
        // pay out; mark them failed instead of leaving forever-pending money.
        voidPendingAward(state, "award cancelled: recovery freeze, journal and local state disagree");
        voidPendingRefund(state, "refund cancelled: recovery freeze, journal and local state disagree, stake recoverable by the pot owner");
        state.updatedAt = Date.now();
        await store.save(gameId, state, [], client);
      });
    }
  }
  reconciled = true;
}

/** Called only after initCompute has completed successfully. */
export async function startRecoveredModels(): Promise<void> {
  if (!getComputeState().ready) return;
  for (const row of await store.listRecoverable()) {
    if (row.state.status === "model_thinking") {
      background(`recovered model ${row.gameId}`, resumeModel(row.gameId));
    }
  }
}

export async function gameEvidence(
  gameId: string,
  accessToken: string | undefined,
): Promise<Record<string, unknown>> {
  const row = await owned(gameId, accessToken);
  if (row.pendingActions.length > 0) {
    // Requesting evidence should accelerate sync, not just refuse: nudge the
    // outbox in the background so a retry a few seconds later succeeds.
    background(`evidence sync ${gameId}`, drainPendingActions());
    throw new RefereeError(
      409,
      `evidence is available once chain sync completes, ${row.pendingActions.length} anchor${row.pendingActions.length === 1 ? "" : "s"} pending, retry shortly`,
    );
  }
  const fresh = await reconcileStable(gameId, false);
  checkToken(fresh, accessToken);
  const state = fresh.state;
  const compute = getComputeState();
  return {
    kind: "fairmate-game-evidence",
    generatedAt: new Date().toISOString(),
    network: state.chain.network,
    chainId: state.chain.chainId,
    explorer: state.chain.explorer,
    journalAddress: state.chain.journalAddress,
    potAddress: state.chain.potAddress,
    gameId: state.gameId,
    playerAddress: state.playerAddress,
    model: state.model,
    provider: state.provider,
    effectiveSigner: state.effectiveSigner,
    verificationScheme: state.verificationScheme,
    computeCostNeuron: state.computeCostNeuron,
    result: state.result,
    clock: state.clock,
    endReason: state.endReason ?? null,
    faultReason: state.faultReason ?? null,
    startFen: START_FEN,
    finalFen: state.fen,
    sans: state.sans,
    startTx: state.startTx,
    endTx: state.endTx ?? null,
    awardTx: state.awardTx ?? null,
    stake: state.stake ?? null,
    refundTx: state.refundTx ?? null,
    attestationNotes: compute.attestation?.notes ?? [],
    attestationTrustBoundary: compute.attestation?.trustBoundary ?? null,
    plies: state.plies,
    verify:
      "Run pnpm run verify -- --file=<this file> and compare every receipt and MoveCommitted event.",
  };
}
