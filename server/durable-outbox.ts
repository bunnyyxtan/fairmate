import { ethers } from "ethers";
import type { TransactionReceipt } from "ethers";
import type { GameState, TxRef } from "../shared/protocol.js";
import {
  FairmateStore,
  actionPly,
  newAction,
  type PendingChainAction,
  type StoredGame,
} from "./fairmate-store.js";
import { createClock, stopClock } from "./game-clock.js";
import {
  anchorPly,
  applyPly,
  chessFor,
  planEnd,
  rollbackToAnchored,
  voidPendingAward,
} from "./referee-state.js";
import type { PreparedChainCall, SignedChainTransaction } from "./chain.js";

export interface AwardRead {
  rewarded: boolean;
  txHash?: string;
  blockNumber?: number;
  amountOg?: string;
}

export interface OutboxChain {
  prepare(call: PreparedChainCall): Promise<SignedChainTransaction>;
  receipt(txHash: string): Promise<TransactionReceipt | null>;
  broadcast(rawTx: string): Promise<TransactionReceipt>;
  award(gameId: string, fromBlock: number): Promise<AwardRead>;
  perWinBountyOg(): Promise<string>;
}

function callFor(action: PendingChainAction): PreparedChainCall {
  const p = action.payload;
  switch (action.kind) {
    case "start":
      return {
        kind: "start",
        args: [
          String(p.gameId),
          String(p.startFenHash),
          String(p.player),
          String(p.model),
          String(p.verificationIdentity),
        ],
      };
    case "ply": {
      const ply = actionPly(action);
      return {
        kind: "ply",
        args: [
          String(p.gameId),
          ply.mover === "model" ? 1 : 0,
          ply.fenBeforeHash,
          ply.fenAfterHash,
          ply.san,
          ply.receiptHash ?? ethers.ZeroHash,
        ],
      };
    }
    case "end":
      return {
        kind: "end",
        args: [String(p.gameId), Number(p.result), String(p.finalFenHash)],
      };
    case "award":
      return { kind: "award", args: [String(p.gameId)] };
    case "refund":
      return { kind: "refund", args: [String(p.to), String(p.amountWei)] };
  }
}

/** Transient pot conditions get this many broadcasts before a refund dies. */
const MAX_REFUND_ATTEMPTS = 3;

/** Owner-signed return of the full stake to the wallet that paid it. */
function refundAction(state: GameState, attempt = 1, notBefore = 0): PendingChainAction {
  if (!state.stake) throw new Error(`refund planned for unstaked game ${state.gameId}`);
  return newAction("refund", {
    gameId: state.gameId,
    to: state.stake.from,
    amountWei: ethers.parseEther(state.stake.amountOg).toString(),
    attempt,
    notBefore,
  });
}

/**
 * Drains per-game FIFO queues of chain anchors. Game state is applied
 * optimistically before an action ever reaches this outbox; confirmation
 * only fills in tx references. A definitive revert fails the game closed.
 */
export class DurableOutbox {
  private readonly refundRetryMs: number;

  constructor(
    private readonly store: FairmateStore,
    private readonly chain: OutboxChain,
    options?: { refundRetryMs?: number },
  ) {
    this.refundRetryMs = options?.refundRetryMs ?? 60_000;
  }

  private async applyConfirmed(
    gameId: string,
    action: PendingChainAction,
    tx: TxRef,
    awardAmount?: string,
  ): Promise<void> {
    await this.store.withGameLock(gameId, async (client) => {
      const row = await this.store.get(gameId, client);
      const head = row?.pendingActions[0];
      if (!row || !head || head.id !== action.id) return;
      const state = row.state;
      const queue = row.pendingActions.slice(1);
      if (action.kind === "start") {
        state.startTx = tx;
        if (
          state.result === "ongoing" &&
          state.status === "awaiting_player" &&
          state.clock.active === null &&
          state.plies.length === 0
        ) {
          // Legacy apply-on-confirm start from before the optimistic
          // pipeline: the clock was created stopped and started here.
          state.clock = createClock(Date.now(), state.clock.initialMs);
        }
      } else if (action.kind === "ply") {
        const ply = actionPly(action);
        if (state.plies.length + 1 === ply.ply) {
          // Legacy apply-on-confirm ply recorded before the optimistic
          // pipeline: apply it now, then anchor it.
          const followUp = applyPly(state, ply, Date.now());
          if (followUp) queue.push(followUp);
        }
        anchorPly(state, ply.ply, tx);
      } else if (action.kind === "end") {
        state.endTx = tx;
        if (state.awardTx && awardAmount !== undefined) state.awardTx.amountOg = awardAmount;
        if (
          state.result === "player_win" &&
          state.playerAddress &&
          state.awardTx &&
          state.awardTx.status === "pending" &&
          !queue.some((queued) => queued.kind === "award")
        ) {
          queue.push(newAction("award", { gameId }));
        }
        if (
          (state.result === "draw" || state.result === "aborted") &&
          state.stake &&
          state.refundTx?.status === "pending" &&
          !queue.some((queued) => queued.kind === "refund")
        ) {
          queue.push(refundAction(state));
        }
      } else if (action.kind === "award") {
        state.awardTx = { ...state.awardTx, ...tx };
        if (awardAmount !== undefined && state.awardTx) state.awardTx.amountOg = awardAmount;
      } else {
        state.refundTx = {
          ...state.refundTx,
          ...tx,
          amountOg: ethers.formatEther(BigInt(String(action.payload.amountWei ?? "0"))),
        };
      }
      state.updatedAt = Date.now();
      await this.store.save(gameId, state, queue, client);
    });
  }

  private async applyReverted(
    row: StoredGame,
    action: PendingChainAction,
    error: string,
  ): Promise<void> {
    await this.store.withGameLock(row.gameId, async (client) => {
      const fresh = await this.store.get(row.gameId, client);
      const head = fresh?.pendingActions[0];
      if (!fresh || !head || head.id !== action.id) return;
      const state = fresh.state;
      const failed: TxRef = { status: "failed", txHash: action.txHash, error };
      // Everything queued behind a definitive revert is built on a broken
      // journal sequence; the revert path decides the sole surviving action.
      let queue: PendingChainAction[] = [];
      if (action.kind === "award") {
        state.awardTx = { ...state.awardTx, ...failed };
        queue = fresh.pendingActions.slice(1);
      } else if (action.kind === "refund") {
        const attempt = Number(action.payload.attempt ?? 1);
        if (attempt < MAX_REFUND_ATTEMPTS) {
          // A reverted defund can be a transient pot condition (for example a
          // momentary balance shortfall between awards and stake inflows), so
          // the obligation is retried after a backoff instead of dying on the
          // first revert. The retry is a fresh action with a fresh nonce.
          queue = [
            ...fresh.pendingActions.slice(1),
            refundAction(state, attempt + 1, Date.now() + this.refundRetryMs),
          ];
        } else {
          // Out of attempts: surfaced honestly; it does not cascade into the
          // journal record, and the operator can still return the stake with
          // a manual owner defund.
          state.refundTx = { ...state.refundTx, ...failed };
          queue = fresh.pendingActions.slice(1);
        }
      } else if (action.kind === "start") {
        state.startTx = failed;
        state.status = "fault";
        state.result = "aborted";
        state.faultReason = error;
        state.endReason = "game start transaction definitively reverted";
        stopClock(state.clock, Date.now());
        voidPendingAward(state, "award cancelled: game start transaction reverted");
        if (state.stake) {
          // The journal never opened, but the stake is real money: return it.
          state.refundTx = { status: "pending" };
          queue = [refundAction(state)];
        }
      } else if (action.kind === "ply") {
        rollbackToAnchored(state);
        state.faultReason = error;
        queue = [
          planEnd(
            state,
            chessFor(state),
            "aborted",
            "move anchor reverted — game aborted at last anchored position",
          ),
        ];
      } else if (Number(action.payload.result) !== 4) {
        state.faultReason = error;
        queue = [
          planEnd(
            state,
            chessFor(state),
            "aborted",
            "result transaction reverted — submitting fail-closed abort",
          ),
        ];
      } else {
        state.endTx = failed;
        state.status = "fault";
        state.result = "aborted";
        state.faultReason = error;
        state.endReason = "aborted endGame transaction definitively reverted";
        stopClock(state.clock, Date.now());
        voidPendingAward(state, "award cancelled: aborted endGame transaction reverted");
        if (state.stake) {
          // Even a broken journal close returns the stake; defund is
          // independent of journal state.
          state.refundTx = { status: "pending" };
          queue = [refundAction(state)];
        }
      }
      state.updatedAt = Date.now();
      await this.store.save(row.gameId, state, queue, client);
    });
  }

  /** Globally drains prepared nonces first, then unsigned queue heads. */
  async drain(): Promise<void> {
    await this.store.withWalletLock(async () => {
      for (;;) {
        const pending = await this.store.listPending();
        let backfilled = false;
        for (const candidate of pending) {
          const action = candidate.pendingActions[0];
          if (action?.rawTx && action.nonce === undefined) {
            action.nonce = ethers.Transaction.from(action.rawTx).nonce;
            await this.store.setPendingSigned(candidate.gameId, action);
            backfilled = true;
          }
        }
        if (backfilled) continue;
        const row = pending.find((candidate) => {
          const head = candidate.pendingActions[0];
          if (!head) return true;
          // A deferred, still-unsigned refund retry waits out its backoff.
          // Once signed it owns a wallet nonce and must proceed regardless,
          // or every later nonce would stall behind the gap.
          return !(
            head.kind === "refund" &&
            !head.rawTx &&
            Number(head.payload.notBefore ?? 0) > Date.now()
          );
        });
        const action = row?.pendingActions[0];
        if (!row || !action) return;
        const fromBlock = row.state.startTx.blockNumber ?? 0;
        try {
          if (action.kind === "award") {
            const existing = await this.chain.award(row.gameId, fromBlock);
            if (existing.rewarded) {
              await this.applyConfirmed(
                row.gameId,
                action,
                {
                  status: "confirmed",
                  txHash: existing.txHash,
                  blockNumber: existing.blockNumber,
                },
                existing.amountOg,
              );
              continue;
            }
          }
          if (!action.rawTx || !action.txHash) {
            const signed = await this.chain.prepare(callFor(action));
            action.rawTx = signed.rawTx;
            action.txHash = signed.txHash;
            action.nonce = signed.nonce;
            await this.store.setPendingSigned(row.gameId, action);
          }
          let receipt = await this.chain.receipt(action.txHash);
          if (!receipt) receipt = await this.chain.broadcast(action.rawTx);
          if (receipt.status !== 1) {
            await this.applyReverted(
              row,
              action,
              `transaction definitively reverted: ${action.txHash}`,
            );
            continue;
          }
          const amount =
            action.kind === "end" && row.state.result === "player_win" && row.state.playerAddress
              ? await this.chain.perWinBountyOg()
              : undefined;
          await this.applyConfirmed(
            row.gameId,
            action,
            { status: "confirmed", txHash: action.txHash, blockNumber: receipt.blockNumber },
            amount,
          );
        } catch (error) {
          if (action.kind === "award") {
            const existing = await this.chain.award(row.gameId, fromBlock);
            if (existing.rewarded) {
              await this.applyConfirmed(
                row.gameId,
                action,
                {
                  status: "confirmed",
                  txHash: existing.txHash,
                  blockNumber: existing.blockNumber,
                },
                existing.amountOg,
              );
              continue;
            }
            if ((error as { code?: string }).code === "CALL_EXCEPTION") {
              await this.applyReverted(
                row,
                action,
                `award preparation definitively reverted: ${error instanceof Error ? error.message : String(error)}`,
              );
              continue;
            }
          }
          action.error = error instanceof Error ? error.message : String(error);
          await this.store.setPendingSigned(row.gameId, action);
          throw error;
        }
      }
    });
  }
}
