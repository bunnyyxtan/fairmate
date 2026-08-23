import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import type { GameState } from "../shared/protocol.js";
import { createClock } from "./game-clock.js";
import { flagFallOutcome, planEnd } from "./referee-state.js";

test("zero-move player flag fall aborts instead of losing the stake", () => {
  const outcome = flagFallOutcome("player", 0);
  assert.equal(outcome.result, "aborted");
  assert.match(outcome.reason, /before the first move/);
});

test("player flag fall after any move is a real loss", () => {
  assert.deepEqual(flagFallOutcome("player", 1), {
    result: "model_win",
    reason: "player flag fell, 5+0 timeout",
  });
  assert.equal(flagFallOutcome("player", 17).result, "model_win");
});

test("model flag fall pays the player regardless of move count", () => {
  assert.equal(flagFallOutcome("model", 2).result, "player_win");
});

function stubState(overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: "0x" + "ab".repeat(32),
    playerAddress: "0x00000000000000000000000000000000000000bB",
    playerColor: "w",
    fen: new Chess().fen(),
    sans: [],
    status: "awaiting_player",
    result: "ongoing",
    clock: createClock(Date.now()),
    plies: [],
    chain: {
      network: "test",
      chainId: 0,
      explorer: "https://example.invalid",
      journalAddress: "0x0000000000000000000000000000000000000001",
      potAddress: "0x0000000000000000000000000000000000000002",
    },
    startTx: { status: "confirmed" },
    model: "test-model",
    provider: "0x0000000000000000000000000000000000000003",
    effectiveSigner: "0x0000000000000000000000000000000000000004",
    verificationScheme: "router-teetls",
    computeCostNeuron: "0",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as GameState;
}

test("planEnd on an aborted staked game queues the refund", () => {
  const state = stubState({
    stake: {
      txHash: "0x" + "cd".repeat(32),
      amountOg: "0.1",
      from: "0x00000000000000000000000000000000000000bB",
      blockNumber: 1,
      verifiedAt: Date.now(),
    },
  });
  const action = planEnd(state, new Chess(), "aborted", "no moves played, game aborted by the player");
  assert.equal(state.status, "fault");
  assert.equal(state.result, "aborted");
  assert.equal(state.refundTx?.status, "pending");
  assert.equal(state.awardTx, undefined);
  assert.equal(action.kind, "end");
});

test("planEnd on a lost staked game never queues a refund", () => {
  const state = stubState({
    sans: ["e4"],
    stake: {
      txHash: "0x" + "ef".repeat(32),
      amountOg: "0.1",
      from: "0x00000000000000000000000000000000000000bB",
      blockNumber: 1,
      verifiedAt: Date.now(),
    },
  });
  planEnd(state, new Chess(), "model_win", "player flag fell, 5+0 timeout");
  assert.equal(state.result, "model_win");
  assert.equal(state.refundTx, undefined);
});
