import { Chess } from "chess.js";
import { canonicalHash } from "../shared/canonical.js";
import type { GameResult, GameState, Mover, PlyRecord, TxRef } from "../shared/protocol.js";
import { newAction, type PendingChainAction } from "./fairmate-store.js";
import { startTurn, stopClock } from "./game-clock.js";

export function chessFor(state: GameState): Chess {
  const chess = new Chess();
  for (const san of state.sans) {
    if (!chess.move(san)) throw new Error(`persisted SAN line is invalid at ${san}`);
  }
  if (chess.fen() !== state.fen) throw new Error("persisted FEN does not match persisted SAN line");
  return chess;
}

export function resultEnum(result: GameResult): number {
  return result === "player_win"
    ? 1
    : result === "model_win"
      ? 2
      : result === "draw"
        ? 3
        : 4;
}

/**
 * Decides how a clock expiry settles a game. Chess rule: whoever runs out of
 * time loses — with one fairness carve-out taken from the lichess precedent
 * for zero-move games. A player who never made a single move consumed no
 * paid inference and revealed nothing, so their game aborts (stake refunded)
 * instead of silently counting as a loss. After the first move the clock is
 * binding for both sides.
 */
export function flagFallOutcome(
  expired: Mover,
  moveCount: number,
): { result: GameResult; reason: string } {
  if (expired === "player" && moveCount === 0) {
    return { result: "aborted", reason: "clock ran out before the first move, game aborted" };
  }
  return expired === "player"
    ? { result: "model_win", reason: "player flag fell, 5+0 timeout" }
    : { result: "player_win", reason: "Qwen flag fell, 5+0 timeout" };
}

/**
 * Cancels a not-yet-confirmed award when a fail-closed path voids a player
 * win, so no game is left forever advertising a pending payout. A confirmed
 * award is never touched — the transfer already happened.
 */
export function voidPendingAward(state: GameState, reason: string): void {
  if (state.awardTx && state.awardTx.status !== "confirmed") {
    state.awardTx = { status: "failed", error: reason };
  }
}

/** Mirrors voidPendingAward for stake refunds on fail-closed freezes. */
export function voidPendingRefund(state: GameState, reason: string): void {
  if (state.refundTx && state.refundTx.status !== "confirmed") {
    state.refundTx = { status: "failed", error: reason };
  }
}

export function planEnd(
  state: GameState,
  chess: Chess,
  result: GameResult,
  reason: string,
): PendingChainAction {
  stopClock(state.clock, Date.now());
  state.status = result === "aborted" ? "fault" : "ended";
  state.result = result;
  state.endReason = reason;
  state.updatedAt = Date.now();
  state.endTx = { status: "pending" };
  if (result === "player_win" && state.playerAddress) state.awardTx = { status: "pending" };
  else voidPendingAward(state, `award cancelled: ${reason}`);
  // A staked game that ends without a winner returns the stake. Losses
  // (model_win) intentionally leave the stake in the pot.
  if ((result === "draw" || result === "aborted") && state.stake) {
    if (state.refundTx?.status !== "confirmed") state.refundTx = { status: "pending" };
  }
  return newAction("end", {
    gameId: state.gameId,
    result: resultEnum(result),
    finalFenHash: canonicalHash(chess.fen()),
  });
}

export function boardResult(chess: Chess): { result: GameResult; reason: string } {
  if (chess.isCheckmate()) {
    return chess.turn() === "b"
      ? { result: "player_win", reason: "checkmate" }
      : { result: "model_win", reason: "checkmate" };
  }
  if (chess.isStalemate()) return { result: "draw", reason: "stalemate" };
  if (chess.isInsufficientMaterial()) return { result: "draw", reason: "insufficient material" };
  if (chess.isThreefoldRepetition()) return { result: "draw", reason: "threefold repetition" };
  return { result: "draw", reason: chess.isDraw() ? "fifty-move rule" : "draw" };
}

/**
 * Applies a ply to the authoritative state the moment it is decided —
 * board, SAN line, clocks and turn phase advance immediately. The chain
 * anchor for the ply trails in the outbox queue; the caller persists the
 * returned follow-up action (terminal end) in the same game transaction.
 */
export function applyPly(
  state: GameState,
  ply: PlyRecord,
  now: number,
): PendingChainAction | null {
  const chess = chessFor(state);
  if (chess.fen() !== ply.fenBefore) throw new Error(`ply ${ply.ply} starts from the wrong FEN`);
  const played = chess.move(ply.san);
  if (!played || chess.fen() !== ply.fenAfter) {
    throw new Error(`ply ${ply.ply} SAN/FEN transition is invalid`);
  }
  if (ply.ply !== state.plies.length + 1) throw new Error(`unexpected ply number ${ply.ply}`);
  ply.chain = { status: "pending", moveNo: ply.ply };
  state.plies.push(ply);
  state.sans.push(ply.san);
  state.fen = ply.fenAfter;
  if (ply.computeCostNeuron) {
    state.computeCostNeuron = (
      BigInt(state.computeCostNeuron) + BigInt(ply.computeCostNeuron)
    ).toString();
  }
  state.updatedAt = now;
  if (chess.isGameOver()) {
    const terminal = boardResult(chess);
    return planEnd(state, chess, terminal.result, terminal.reason);
  }
  if (ply.mover === "player") {
    state.status = "model_thinking";
    startTurn(state.clock, "model", now);
  } else {
    state.status = "awaiting_player";
    startTurn(state.clock, "player", now);
  }
  return null;
}

/** Fills in the confirmed anchor reference for an already-applied ply. */
export function anchorPly(state: GameState, plyNo: number, tx: TxRef): void {
  const ply = state.plies[plyNo - 1];
  if (!ply || ply.ply !== plyNo) throw new Error(`no local ply ${plyNo} to anchor`);
  ply.chain = { ...tx, moveNo: plyNo };
}

/**
 * Fail-closed rollback after a definitive anchor revert: drop every ply that
 * never landed on-chain so local state matches the journal again. Router
 * spend already incurred is intentionally kept in computeCostNeuron.
 */
export function rollbackToAnchored(state: GameState): void {
  while (
    state.plies.length > 0 &&
    state.plies[state.plies.length - 1].chain.status !== "confirmed"
  ) {
    state.plies.pop();
    state.sans.pop();
  }
  const chess = new Chess();
  for (const san of state.sans) {
    if (!chess.move(san)) throw new Error(`anchored SAN line is invalid at ${san}`);
  }
  state.fen = chess.fen();
}