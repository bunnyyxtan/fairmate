/**
 * The referee — game lifecycle, move validation, attested model moves, and
 * the on-chain journal/pot writes. In-memory store (games are short-lived;
 * permanence lives on-chain + in downloadable evidence bundles).
 *
 * Honesty invariants:
 *  - the model NEVER gets a fabricated fallback move; if it cannot produce a
 *    legal move within bounded retries the game is ABORTED as a fault.
 *  - every model ply carries the full receipt bundle; the client re-verifies
 *    it in the browser (shared/receipt.ts) rather than trusting this server.
 */
import { Chess } from "chess.js";
import { ethers } from "ethers";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalHash } from "../shared/canonical";
import { computeReceiptHash } from "../shared/receipt";
import type {
  GameResult,
  GameState,
  PlyRecord,
  ReceiptBundle,
  TxRef,
} from "../shared/protocol";
import { CHESS_SYSTEM_PROMPT, buildMoveUserPrompt, parseMove } from "../src/chess-agent";
import { completion, getComputeState } from "./compute-service";
import {
  RESULT_ENUM,
  awardPrecheck,
  chainInfo,
  enqueueTx,
  journal,
  pot,
  readPot,
} from "./chain";
import { createClock, startTurn, stopClock, tickClock } from "./game-clock";

const MAX_ACTIVE_GAMES = Number(process.env.FAIRMATE_MAX_ACTIVE_GAMES ?? 3);
const MAX_GAMES_PER_IP_PER_DAY = Number(process.env.FAIRMATE_MAX_GAMES_PER_IP_PER_DAY ?? 5);
const MAX_GAMES_GLOBAL_PER_DAY = Number(process.env.FAIRMATE_MAX_GAMES_GLOBAL_PER_DAY ?? 12);
const MAX_STORED_GAMES = 200;
const MODEL_MOVE_ATTEMPTS = 2;
const MODEL_TEMPERATURE = 0.2;
const IDLE_ABORT_MS = Number(process.env.FAIRMATE_IDLE_ABORT_MS ?? 10 * 60 * 1000);
const GAME_CLOCK_MS = Number(process.env.FAIRMATE_CLOCK_MS ?? 5 * 60 * 1000);

interface Game {
  state: GameState;
  chess: Chess;
  ip: string;
  accessTokenHash: Buffer;
  /** true while a model move is being computed (re-entrancy guard) */
  thinking: boolean;
  /** serializes player move and resignation mutations */
  mutating: boolean;
  /** true only while a model ply is awaiting its chain confirmation */
  committing: boolean;
}

export interface CreatedGame {
  game: GameState;
  accessToken: string;
}

const games = new Map<string, Game>();
const ipDaily = new Map<string, { day: string; count: number }>();
let globalDaily = { day: today(), count: 0 };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function activeCount(): number {
  let c = 0;
  for (const g of games.values()) {
    if (g.state.status === "awaiting_player" || g.state.status === "model_thinking") c += 1;
  }
  return c;
}

function activeForIp(ip: string): number {
  let c = 0;
  for (const g of games.values()) {
    if (g.ip === ip && (g.state.status === "awaiting_player" || g.state.status === "model_thinking")) c += 1;
  }
  return c;
}

function prune(): void {
  if (games.size <= MAX_STORED_GAMES) return;
  const ended = [...games.entries()]
    .filter(([, g]) => g.state.status === "ended" || g.state.status === "fault")
    .sort((a, b) => a[1].state.updatedAt - b[1].state.updatedAt);
  while (games.size > MAX_STORED_GAMES && ended.length > 0) {
    const [id] = ended.shift()!;
    games.delete(id);
  }
}

export class RefereeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function hashAccessToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function ownedGame(gameId: string, accessToken: string | undefined): Game {
  const g = games.get(gameId);
  if (!g) throw new RefereeError(404, "no such game");
  if (!accessToken) throw new RefereeError(403, "game access token required");
  const presented = hashAccessToken(accessToken);
  if (
    presented.length !== g.accessTokenHash.length ||
    !timingSafeEqual(presented, g.accessTokenHash)
  ) {
    throw new RefereeError(403, "invalid game access token");
  }
  return g;
}

function releaseAdmission(ip: string): void {
  const daily = ipDaily.get(ip);
  if (daily?.day === today()) {
    daily.count = Math.max(0, daily.count - 1);
    if (daily.count === 0) ipDaily.delete(ip);
  }
  if (globalDaily.day === today()) {
    globalDaily.count = Math.max(0, globalDaily.count - 1);
  }
}

export async function createGame(ip: string, playerAddress?: string): Promise<CreatedGame> {
  const compute = getComputeState();
  if (!compute.ready || !compute.selection) {
    throw new RefereeError(503, compute.bootError ?? "TEE attestation still in progress — try again shortly");
  }
  if (playerAddress !== undefined && playerAddress !== null && playerAddress !== "") {
    if (!ethers.isAddress(playerAddress)) {
      throw new RefereeError(400, `not a valid payout address: ${playerAddress}`);
    }
  } else {
    playerAddress = undefined;
  }
  if (activeCount() >= MAX_ACTIVE_GAMES) {
    throw new RefereeError(429, "all boards are busy — try again in a minute");
  }
  if (activeForIp(ip) >= 1) {
    throw new RefereeError(429, "you already have an active game — finish or resign it first");
  }
  const daily = ipDaily.get(ip);
  if (daily && daily.day === today() && daily.count >= MAX_GAMES_PER_IP_PER_DAY) {
    throw new RefereeError(429, "daily game limit reached for your connection — try again tomorrow");
  }
  if (globalDaily.day !== today()) globalDaily = { day: today(), count: 0 };
  if (globalDaily.count >= MAX_GAMES_GLOBAL_PER_DAY) {
    throw new RefereeError(429, "today's builder-funded match allocation is complete — try again tomorrow");
  }
  ipDaily.set(ip, { day: today(), count: daily && daily.day === today() ? daily.count + 1 : 1 });
  globalDaily.count += 1;

  const chess = new Chess();
  const gameId = ethers.hexlify(ethers.randomBytes(32));
  const startFen = chess.fen();
  const startTx: TxRef = { status: "pending" };
  const now = Date.now();
  const pausedClock = createClock(now, GAME_CLOCK_MS);
  stopClock(pausedClock, now);
  const state: GameState = {
    gameId,
    playerAddress: playerAddress ?? null,
    playerColor: "w",
    fen: startFen,
    sans: [],
    status: "awaiting_player",
    result: "ongoing",
    clock: pausedClock,
    plies: [],
    chain: chainInfo(),
    startTx,
    model: compute.selection.model,
    provider: compute.selection.provider,
    effectiveSigner: compute.selection.effectiveSigner,
    verificationScheme: compute.selection.verificationScheme,
    computeCostNeuron: "0",
    createdAt: now,
    updatedAt: now,
  };
  const accessToken = randomBytes(32).toString("base64url");
  const game: Game = {
    state,
    chess,
    ip,
    accessTokenHash: hashAccessToken(accessToken),
    thinking: false,
    mutating: false,
    committing: false,
  };
  games.set(gameId, game);
  prune();

  const startRef = await enqueueTx(`startGame ${gameId.slice(0, 10)}`, startTx, () =>
    journal.startGame(
      gameId,
      canonicalHash(startFen),
      playerAddress ?? ethers.ZeroAddress,
      compute.selection!.model,
      compute.selection!.effectiveSigner,
    ),
  );
  if (startRef.status !== "confirmed") {
    games.delete(gameId);
    releaseAdmission(ip);
    throw new RefereeError(
      502,
      `game start was not confirmed on 0G Chain: ${startRef.error ?? "unknown transaction failure"}`,
    );
  }
  const startedAt = Date.now();
  state.clock = createClock(startedAt, GAME_CLOCK_MS);
  state.createdAt = startedAt;
  state.updatedAt = startedAt;
  return { game: snapshot(game), accessToken };
}

export function getGame(gameId: string, accessToken: string | undefined): GameState {
  const g = ownedGame(gameId, accessToken);
  expireClock(g);
  return snapshot(g);
}

export async function playerMove(
  gameId: string,
  san: string,
  accessToken: string | undefined,
): Promise<GameState> {
  const g = ownedGame(gameId, accessToken);
  if (g.mutating || g.committing) {
    throw new RefereeError(409, "another game action is already being committed");
  }
  g.mutating = true;
  try {
    if (expireClock(g)) {
      throw new RefereeError(409, `game ended: ${g.state.endReason}`);
    }
    if (g.state.status !== "awaiting_player") {
      throw new RefereeError(409, `not your turn (status: ${g.state.status})`);
    }
    const fenBefore = g.chess.fen();
    let played: { san: string };
    try {
      played = g.chess.move(san);
    } catch {
      throw new RefereeError(400, `illegal move: ${san}`);
    }
    // Charge only decision time. Chain confirmation latency is not chess-clock time.
    stopClock(g.state.clock, Date.now());
    g.state.updatedAt = Date.now();
    await recordPly(g, "player", played.san, fenBefore, g.chess.fen(), null, undefined, undefined);
    if (g.state.status !== "awaiting_player") return snapshot(g);
    if (g.chess.isGameOver()) {
      finalizeFromBoard(g);
    } else {
      g.state.status = "model_thinking";
      g.state.updatedAt = Date.now();
      startTurn(g.state.clock, "model", Date.now());
      void modelMove(g);
    }
    return snapshot(g);
  } finally {
    g.mutating = false;
  }
}

export function resign(gameId: string, accessToken: string | undefined): GameState {
  const g = ownedGame(gameId, accessToken);
  if (g.mutating || g.committing) {
    throw new RefereeError(409, "another game action is already being committed");
  }
  expireClock(g);
  if (g.state.status === "ended" || g.state.status === "fault") {
    throw new RefereeError(409, "game already over");
  }
  endGame(g, "model_win", "resignation");
  return snapshot(g);
}

/**
 * Abort games abandoned mid-play (closed tab, lost session). Without this,
 * orphaned games would hold the per-IP and global active slots forever.
 * Never fires while an attested inference is in flight.
 */
export function sweepIdleGames(): void {
  const now = Date.now();
  for (const g of games.values()) {
    const active = g.state.status === "awaiting_player" || g.state.status === "model_thinking";
    if (!active) continue;
    if (expireClock(g, now)) continue;
    if (g.thinking || g.mutating || g.committing) continue;
    if (now - g.state.updatedAt > IDLE_ABORT_MS) {
      console.warn(
        `[referee] game ${g.state.gameId.slice(0, 10)} idle ${Math.round((now - g.state.updatedAt) / 60000)} min — aborting`,
      );
      endGame(g, "aborted", "abandoned — idle timeout");
    }
  }
}

// ---- internals ---------------------------------------------------------------

async function recordPly(
  g: Game,
  mover: "player" | "model",
  san: string,
  fenBefore: string,
  fenAfter: string,
  receiptHash: string | null,
  receipt: ReceiptBundle | undefined,
  why: string | undefined,
): Promise<PlyRecord> {
  const chain: PlyRecord["chain"] = { status: "pending" };
  const ply: PlyRecord = {
    ply: g.state.plies.length + 1,
    mover,
    san,
    fenBefore,
    fenAfter,
    fenBeforeHash: canonicalHash(fenBefore),
    fenAfterHash: canonicalHash(fenAfter),
    receipt,
    receiptHash,
    computeCostNeuron:
      receipt?.scheme === "router-teetls"
        ? receipt.trace.billing.totalCostNeuron
        : undefined,
    why,
    chain,
    at: Date.now(),
  };
  const ref = await enqueueTx(`commitMove ${g.state.gameId.slice(0, 10)} #${ply.ply}`, chain, () =>
    journal.commitMove(
      g.state.gameId,
      mover === "model" ? 1 : 0,
      ply.fenBeforeHash,
      ply.fenAfterHash,
      san,
      receiptHash ?? ethers.ZeroHash,
    ),
  );
  if (ref.status !== "confirmed") {
    g.chess.undo();
    const reason = `move ${ply.ply} was not committed on 0G Chain: ${ref.error ?? "unknown transaction failure"}`;
    fault(g, reason);
    throw new RefereeError(502, `${reason}; game aborted before any payout`);
  }
  ply.chain.moveNo = ply.ply;
  g.state.plies.push(ply);
  if (ply.computeCostNeuron) {
    g.state.computeCostNeuron = (
      BigInt(g.state.computeCostNeuron) + BigInt(ply.computeCostNeuron)
    ).toString();
  }
  g.state.sans.push(san);
  g.state.fen = fenAfter;
  g.state.updatedAt = Date.now();

  return ply;
}

async function modelMove(g: Game): Promise<void> {
  if (g.thinking) return;
  g.thinking = true;
  try {
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= MODEL_MOVE_ATTEMPTS; attempt++) {
      if (g.state.status !== "model_thinking" || expireClock(g)) return;
      const legalSans = g.chess.moves();
      const prompt = buildMoveUserPrompt({
        fen: g.chess.fen(),
        turn: g.chess.turn() as "w" | "b",
        fullmoveNumber: g.chess.moveNumber(),
        legalSans,
        recentHistory: g.state.sans.slice(-8),
        feedback,
      });
      const completionResult = await completion(
        [
          { role: "system", content: CHESS_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        MODEL_TEMPERATURE,
      );
      if (g.state.status !== "model_thinking" || expireClock(g)) return;
      const content = completionResult.value.content;
      const parsed = parseMove(content, legalSans);
      if (!parsed) {
        feedback = `Your previous reply was not a single legal move from the list. Reply with ONLY the JSON object. Previous reply began: ${content.slice(0, 80)}`;
        console.warn(`[referee] model reply unparseable (attempt ${attempt}/${MODEL_MOVE_ATTEMPTS})`);
        continue;
      }
      const fenBefore = g.chess.fen();
      const played = g.chess.move(parsed.san); // legal by construction (parseMove checks the list)
      // The model has answered. Do not charge its clock for the following chain confirmation.
      stopClock(g.state.clock, Date.now());
      const bundle: ReceiptBundle =
        completionResult.transport === "router"
          ? completionResult.value.receipt
          : {
              scheme: "direct-teeml",
              chatID: completionResult.value.chatID,
              model: g.state.model,
              provider: g.state.provider,
              sigText: completionResult.value.signature.text,
              signature: completionResult.value.signature.signature,
              effectiveSigner: completionResult.value.effectiveSigner,
              rawBody: completionResult.value.rawBody,
              rawBodySha256: completionResult.value.rawBodySha256,
              requestBodyJson: completionResult.value.requestBodyJson,
              receipt: {
                requestHash: completionResult.value.receipt.requestHash,
                responseHash: completionResult.value.receipt.responseHash,
                providerType: completionResult.value.receipt.providerType,
                providerIdentity: completionResult.value.receipt.providerIdentity,
                tlsCertFingerprint: completionResult.value.receipt.tlsCertFingerprint,
              },
              receiptHash: computeReceiptHash({
                sigText: completionResult.value.signature.text,
                signature: completionResult.value.signature.signature,
                rawBodySha256: completionResult.value.rawBodySha256,
              }),
              latencyMs: completionResult.value.latencyMs,
            };
      g.committing = true;
      try {
        await recordPly(g, "model", played.san, fenBefore, g.chess.fen(), bundle.receiptHash, bundle, parsed.why || undefined);
      } finally {
        g.committing = false;
      }
      // A resignation may have landed before the commit phase began. Never
      // resurrect a terminal game after returning from an asynchronous write.
      if (g.state.status !== "model_thinking") return;
      if (g.chess.isGameOver()) {
        finalizeFromBoard(g);
      } else {
        g.state.status = "awaiting_player";
        g.state.updatedAt = Date.now();
        startTurn(g.state.clock, "player", Date.now());
      }
      return;
    }
    if (g.state.status === "model_thinking") {
      fault(g, "model could not produce a legal move within bounded retries");
    }
  } catch (err) {
    if (g.state.status === "model_thinking") {
      fault(g, err instanceof Error ? err.message : String(err));
    }
  } finally {
    g.thinking = false;
  }
}

function finalizeFromBoard(g: Game): void {
  const c = g.chess;
  if (c.isCheckmate()) {
    // side to move is checkmated; the mover of the LAST ply won
    const winner = c.turn() === "b" ? "w" : "b";
    if (winner === "w") {
      endGame(g, "player_win", "checkmate");
    } else {
      endGame(g, "model_win", "checkmate");
    }
    return;
  }
  let reason = "draw";
  if (c.isStalemate()) reason = "stalemate";
  else if (c.isInsufficientMaterial()) reason = "insufficient material";
  else if (c.isThreefoldRepetition()) reason = "threefold repetition";
  else if (c.isDraw()) reason = "fifty-move rule";
  endGame(g, "draw", reason);
}

function endGame(g: Game, result: GameResult, reason: string): void {
  stopClock(g.state.clock, Date.now());
  const journalComplete =
    g.state.startTx.status === "confirmed" &&
    g.state.plies.every((ply) => ply.chain.status === "confirmed");
  if (!journalComplete) {
    g.state.status = "fault";
    g.state.result = "aborted";
    g.state.endReason = "journal incomplete — result and payout were not submitted";
    g.state.faultReason = "at least one required 0G Chain commitment is not confirmed";
    g.state.updatedAt = Date.now();
    return;
  }
  g.state.status = "ended";
  g.state.result = result;
  g.state.endReason = reason;
  g.state.updatedAt = Date.now();

  const resultEnum =
    result === "player_win"
      ? RESULT_ENUM.PlayerWin
      : result === "model_win"
        ? RESULT_ENUM.ModelWin
        : result === "draw"
          ? RESULT_ENUM.Draw
          : RESULT_ENUM.Aborted;

  const endTx: TxRef = { status: "pending" };
  g.state.endTx = endTx;
  const finalFenHash = canonicalHash(g.chess.fen());
  const endPromise = enqueueTx(`endGame ${g.state.gameId.slice(0, 10)} (${result})`, endTx, () =>
    journal.endGame(g.state.gameId, resultEnum, finalFenHash),
  );
  void endPromise.then(() => {
    g.state.updatedAt = Date.now();
  });

  if (result === "player_win" && g.state.playerAddress) {
    const awardTx: TxRef & { amountOg?: string } = { status: "pending" };
    g.state.awardTx = awardTx;
    void endPromise.then(async (endRef) => {
      if (endRef.status !== "confirmed") {
        awardTx.status = "failed";
        awardTx.error = "endGame tx failed — award not attempted";
        return;
      }
      const blocker = await awardPrecheck(g.state.gameId);
      if (blocker) {
        awardTx.status = "failed";
        awardTx.error = `award blocked: ${blocker}`;
        g.state.updatedAt = Date.now();
        return;
      }
      const reads = await readPot();
      awardTx.amountOg = reads.perWinBountyOg;
      await enqueueTx(`award ${g.state.gameId.slice(0, 10)}`, awardTx, () => pot.award(g.state.gameId));
      g.state.updatedAt = Date.now();
    });
  }
}

function fault(g: Game, reason: string): void {
  console.error(`[referee] game ${g.state.gameId.slice(0, 10)} FAULT: ${reason}`);
  g.state.faultReason = reason;
  stopClock(g.state.clock, Date.now());
  g.state.status = "fault";
  g.state.result = "aborted";
  g.state.endReason = "model fault — game aborted, no fabricated move";
  g.state.updatedAt = Date.now();
  const endTx: TxRef = { status: "pending" };
  g.state.endTx = endTx;
  void enqueueTx(`endGame ${g.state.gameId.slice(0, 10)} (aborted)`, endTx, () =>
    journal.endGame(g.state.gameId, RESULT_ENUM.Aborted, canonicalHash(g.chess.fen())),
  );
}

function snapshot(g: Game): GameState {
  expireClock(g);
  // plies/txrefs are mutated in place; clone for a consistent wire snapshot
  return JSON.parse(JSON.stringify(g.state)) as GameState;
}

function expireClock(g: Game, now = Date.now()): boolean {
  if (g.state.status !== "awaiting_player" && g.state.status !== "model_thinking") return false;
  const expired = tickClock(g.state.clock, now);
  if (!expired) return false;
  if (expired === "player") {
    endGame(g, "model_win", "player flag fell — 5+0 timeout");
  } else {
    endGame(g, "player_win", "Qwen flag fell — 5+0 timeout");
  }
  return true;
}

/** Downloadable, self-contained evidence bundle for one game. */
export function gameEvidence(
  gameId: string,
  accessToken: string | undefined,
): Record<string, unknown> {
  const g = ownedGame(gameId, accessToken);
  const compute = getComputeState();
  return {
    kind: "fairmate-game-evidence",
    generatedAt: new Date().toISOString(),
    network: g.state.chain.network,
    chainId: g.state.chain.chainId,
    explorer: g.state.chain.explorer,
    journalAddress: g.state.chain.journalAddress,
    potAddress: g.state.chain.potAddress,
    gameId: g.state.gameId,
    playerAddress: g.state.playerAddress,
    model: g.state.model,
    provider: g.state.provider,
    effectiveSigner: g.state.effectiveSigner,
    verificationScheme: g.state.verificationScheme,
    computeCostNeuron: g.state.computeCostNeuron,
    result: g.state.result,
    clock: g.state.clock,
    endReason: g.state.endReason ?? null,
    faultReason: g.state.faultReason ?? null,
    startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    finalFen: g.state.fen,
    sans: g.state.sans,
    startTx: g.state.startTx,
    endTx: g.state.endTx ?? null,
    awardTx: g.state.awardTx ?? null,
    attestationNotes: compute.attestation?.notes ?? [],
    attestationTrustBoundary: compute.attestation?.trustBoundary ?? null,
    plies: g.state.plies,
    verify:
      g.state.verificationScheme === "router-teetls"
        ? "Run pnpm run verify -- --file=<this file>. Recompute exact request/response hashes, Router trace/provider/billing fields and the full evidence commitment, then compare each confirmed MoveCommitted event. 0G Router remains the explicit TeeTLS verification trust boundary."
        : "Run pnpm run verify -- --file=<this file>. Recompute response hashes, recover each direct TeeML signature against the attested signer and compare each confirmed MoveCommitted event.",
  };
}
