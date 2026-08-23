import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { pool } from "../db/pool.js";
import { Chess } from "chess.js";
import type { TransactionReceipt } from "ethers";
import type { GameState, PlyRecord } from "../shared/protocol.js";
import { canonicalHash } from "../shared/canonical.js";
import { DurableOutbox, type AwardRead, type OutboxChain } from "./durable-outbox.js";
import { FairmateStore, newAction, type PendingChainAction } from "./fairmate-store.js";
import { createClock, stopClock } from "./game-clock.js";
import { applyPly, planEnd } from "./referee-state.js";
import type { PreparedChainCall, SignedChainTransaction } from "./chain.js";
import { verifyJournalState } from "./journal-verifier.js";

const ids: string[] = [];
const receipt = (status = 1, blockNumber = 10): TransactionReceipt =>
  ({ status, blockNumber }) as TransactionReceipt;

function id(): string {
  const value = `outbox-test-${randomUUID()}`;
  ids.push(value);
  return value;
}

function state(gameId: string): GameState {
  const chess = new Chess();
  return {
    gameId,
    playerAddress: null,
    playerColor: "w",
    fen: chess.fen(),
    sans: [],
    status: "awaiting_player",
    result: "ongoing",
    clock: createClock(Date.now()),
    plies: [],
    chain: {
      network: "fake",
      chainId: 1,
      explorer: "",
      journalAddress: "0x0000000000000000000000000000000000000002",
      potAddress: "0x0000000000000000000000000000000000000003",
    },
    startTx: { status: "confirmed", txHash: "0xstart", blockNumber: 1 },
    model: "model",
    provider: "provider",
    effectiveSigner: "0x0000000000000000000000000000000000000001",
    verificationScheme: "direct-teeml",
    computeCostNeuron: "0",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function insert(
  store: FairmateStore,
  value: GameState,
  pendingActions: PendingChainAction[],
): Promise<void> {
  await store.withAdmissionLock((client) =>
    store.insert(
      {
        gameId: value.gameId,
        state: value,
        capabilityHash: `token-${value.gameId}`,
        admissionKey: `key-${value.gameId}`,
        admissionDay: "2099-02-01",
        status: value.status,
        pendingActions,
      },
      client,
    ).then(() => undefined),
  );
}

/** A 1.e4 PlyRecord that has NOT been applied to the state. */
function playerPly(): PlyRecord {
  const chess = new Chess();
  const before = chess.fen();
  const move = chess.move("e4");
  assert.ok(move);
  return {
    ply: 1,
    mover: "player",
    san: move.san,
    fenBefore: before,
    fenAfter: chess.fen(),
    fenBeforeHash: canonicalHash(before),
    fenAfterHash: canonicalHash(chess.fen()),
    receiptHash: null,
    chain: { status: "pending" },
    at: Date.now(),
  };
}

/** Applies 1.e4 optimistically and returns the trailing anchor action. */
function queuedPly(value: GameState): PendingChainAction {
  const ply = playerPly();
  const followUp = applyPly(value, ply, Date.now());
  assert.equal(followUp, null);
  return newAction("ply", { gameId: value.gameId, ply });
}

class FakeChain implements OutboxChain {
  prepares: PreparedChainCall[] = [];
  broadcasts: string[] = [];
  receipts = new Map<string, TransactionReceipt>();
  rawToHash = new Map<string, string>();
  nextNonce = 1;
  receiptErrorOnce = false;
  confirmThenThrow = false;
  revertKinds = new Set<PreparedChainCall["kind"]>();
  awards = new Map<string, AwardRead>();

  async prepare(call: PreparedChainCall): Promise<SignedChainTransaction> {
    this.prepares.push(call);
    const nonce = this.nextNonce++;
    const rawTx = `raw-${nonce}-${call.kind}`;
    const txHash = `hash-${nonce}-${call.kind}`;
    this.rawToHash.set(rawTx, txHash);
    return { rawTx, txHash, nonce };
  }
  async receipt(txHash: string): Promise<TransactionReceipt | null> {
    if (this.receiptErrorOnce) {
      this.receiptErrorOnce = false;
      throw new Error("transport lost after signing");
    }
    return this.receipts.get(txHash) ?? null;
  }
  async broadcast(rawTx: string): Promise<TransactionReceipt> {
    this.broadcasts.push(rawTx);
    const txHash = this.rawToHash.get(rawTx) ?? `known-${rawTx}`;
    const kind = rawTx.split("-").at(-1) as PreparedChainCall["kind"];
    const mined = receipt(this.revertKinds.has(kind) ? 0 : 1, 10 + this.broadcasts.length);
    this.receipts.set(txHash, mined);
    if (this.confirmThenThrow) {
      this.confirmThenThrow = false;
      throw new Error("transport lost after confirmation");
    }
    return mined;
  }
  async award(gameId: string): Promise<AwardRead> {
    return this.awards.get(gameId) ?? { rewarded: false };
  }
  async perWinBountyOg(): Promise<string> {
    return "1";
  }
}

after(async () => {
  if (ids.length) {
    await pool.query(`delete from "fairmate"."fairmate_games" where game_id=any($1::text[])`, [ids]);
  }
  await pool.end();
});

test("restart rebroadcasts persisted signed bytes without preparing a second nonce", async () => {
  const storeA = new FairmateStore();
  const storeB = new FairmateStore();
  const fake = new FakeChain();
  const gameId = id();
  const value = state(gameId);
  await insert(storeA, value, [queuedPly(value)]);
  fake.receiptErrorOnce = true;
  await assert.rejects(new DurableOutbox(storeA, fake).drain(), /transport lost/);
  const signed = (await storeA.get(gameId))?.pendingActions[0];
  assert.ok(signed?.rawTx);
  await new DurableOutbox(storeB, fake).drain();
  assert.equal(fake.prepares.length, 1);
  assert.deepEqual(fake.broadcasts, [signed.rawTx]);
  const row = await storeB.get(gameId);
  assert.deepEqual(row?.state.sans, ["e4"]);
  assert.equal(row?.state.plies[0]?.chain.status, "confirmed");
  assert.deepEqual(row?.pendingActions, []);
});

test("restart observes confirmation after transport loss and anchors exactly once", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  const gameId = id();
  const value = state(gameId);
  await insert(store, value, [queuedPly(value)]);
  fake.confirmThenThrow = true;
  await assert.rejects(new DurableOutbox(store, fake).drain(), /transport lost/);
  await new DurableOutbox(new FairmateStore(), fake).drain();
  assert.equal(fake.prepares.length, 1);
  assert.equal(fake.broadcasts.length, 1);
  const row = await store.get(gameId);
  assert.deepEqual(row?.state.sans, ["e4"]);
  assert.equal(row?.state.plies.length, 1);
  assert.equal(row?.state.plies[0]?.chain.status, "confirmed");
});

test("two replicas drain one planned ply once under the real wallet lock", async () => {
  const a = new FairmateStore();
  const b = new FairmateStore();
  const fake = new FakeChain();
  const gameId = id();
  const value = state(gameId);
  await insert(a, value, [queuedPly(value)]);
  await Promise.all([
    new DurableOutbox(a, fake).drain(),
    new DurableOutbox(b, fake).drain(),
  ]);
  assert.equal(fake.prepares.length, 1);
  assert.equal(fake.broadcasts.length, 1);
  assert.deepEqual((await a.get(gameId))?.state.sans, ["e4"]);
});

test("actual drain honors a prepared nonce before an older unsigned row", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  const older = id();
  const newer = id();
  await insert(store, state(older), [newAction("start", { gameId: older })]);
  const prepared = newAction("start", { gameId: newer });
  prepared.rawTx = "raw-4-start";
  prepared.txHash = "hash-4-start";
  prepared.nonce = 4;
  fake.rawToHash.set(prepared.rawTx, prepared.txHash);
  await insert(store, state(newer), [prepared]);
  await new DurableOutbox(store, fake).drain();
  assert.equal(fake.broadcasts[0], "raw-4-start");
});

test("one game's queue drains strictly in FIFO order", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  const gameId = id();
  const value = state(gameId);
  value.startTx = { status: "pending" };
  const startAction = newAction("start", { gameId });
  const plyAction = queuedPly(value);
  await insert(store, value, [startAction, plyAction]);
  await new DurableOutbox(store, fake).drain();
  assert.deepEqual(fake.prepares.map((call) => call.kind), ["start", "ply"]);
  const row = await store.get(gameId);
  assert.equal(row?.state.startTx.status, "confirmed");
  assert.equal(row?.state.plies[0]?.chain.status, "confirmed");
  assert.deepEqual(row?.pendingActions, []);
});

test("end confirmation queues the award and the same drain pays it", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  const gameId = id();
  const value = state(gameId);
  value.playerAddress = "0x00000000000000000000000000000000000000Aa";
  const endAction = planEnd(value, new Chess(), "player_win", "checkmate");
  await insert(store, value, [endAction]);
  await new DurableOutbox(store, fake).drain();
  const row = await store.get(gameId);
  assert.equal(row?.state.endTx?.status, "confirmed");
  assert.equal(row?.state.awardTx?.status, "confirmed");
  assert.equal(row?.state.awardTx?.amountOg, "1");
  assert.deepEqual(row?.pendingActions, []);
  assert.deepEqual(fake.prepares.map((call) => call.kind), ["end", "award"]);
});

test("reverted ply rolls back to the anchored position and fails closed", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  fake.revertKinds.add("ply");
  const failedId = id();
  const failed = state(failedId);
  const startFen = failed.fen;
  await insert(store, failed, [queuedPly(failed)]);
  await new DurableOutbox(store, fake).drain();
  const failedRow = await store.get(failedId);
  assert.equal(failedRow?.state.status, "fault");
  assert.equal(failedRow?.state.result, "aborted");
  assert.deepEqual(failedRow?.state.sans, []);
  assert.equal(failedRow?.state.fen, startFen);
  assert.equal(failedRow?.state.endTx?.status, "confirmed");
  assert.deepEqual(failedRow?.pendingActions, []);

  const paidId = id();
  const paid = state(paidId);
  paid.status = "ended";
  paid.result = "player_win";
  paid.awardTx = { status: "pending" };
  await insert(store, paid, [newAction("award", { gameId: paidId })]);
  fake.awards.set(paidId, {
    rewarded: true,
    txHash: "paid-hash",
    blockNumber: 90,
    amountOg: "1",
  });
  const revertedAwardId = id();
  const revertedAward = state(revertedAwardId);
  revertedAward.status = "ended";
  revertedAward.result = "player_win";
  revertedAward.awardTx = { status: "pending" };
  await insert(store, revertedAward, [newAction("award", { gameId: revertedAwardId })]);
  fake.revertKinds.add("award");
  const otherId = id();
  await insert(store, state(otherId), [newAction("start", { gameId: otherId })]);
  await new DurableOutbox(store, fake).drain();
  assert.equal((await store.get(paidId))?.state.awardTx?.status, "confirmed");
  assert.equal((await store.get(revertedAwardId))?.state.awardTx?.status, "failed");
  assert.deepEqual((await store.get(otherId))?.pendingActions, []);
});

test("end revert on a player win cancels the pending award fail-closed", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  fake.revertKinds.add("end");
  const gameId = id();
  const value = state(gameId);
  value.playerAddress = "0x00000000000000000000000000000000000000Aa";
  const endAction = planEnd(value, new Chess(), "player_win", "checkmate");
  assert.equal(value.awardTx?.status, "pending");
  await insert(store, value, [endAction]);
  await new DurableOutbox(store, fake).drain();
  const row = await store.get(gameId);
  assert.equal(row?.state.result, "aborted");
  assert.equal(row?.state.status, "fault");
  assert.equal(row?.state.awardTx?.status, "failed");
  assert.equal(row?.state.endTx?.status, "failed");
  assert.deepEqual(row?.pendingActions, []);
});

test("legacy apply-on-confirm ply from before the optimistic pipeline still applies", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  const gameId = id();
  const value = state(gameId);
  const ply = playerPly();
  stopClock(value.clock, Date.now());
  await insert(store, value, [newAction("ply", { gameId, ply })]);
  await new DurableOutbox(store, fake).drain();
  const row = await store.get(gameId);
  assert.deepEqual(row?.state.sans, ["e4"]);
  assert.equal(row?.state.status, "model_thinking");
  assert.equal(row?.state.clock.active, "model");
  assert.equal(row?.state.plies[0]?.chain.status, "confirmed");
  assert.deepEqual(row?.pendingActions, []);
});

test("legacy stopped-clock start from before the optimistic pipeline starts the clock", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  const gameId = id();
  const value = state(gameId);
  value.startTx = { status: "pending" };
  stopClock(value.clock, Date.now());
  await insert(store, value, [newAction("start", { gameId })]);
  await new DurableOutbox(store, fake).drain();
  const row = await store.get(gameId);
  assert.equal(row?.state.startTx.status, "confirmed");
  assert.equal(row?.state.clock.active, "player");
});

function stakedState(gameId: string): GameState {
  const value = state(gameId);
  value.playerAddress = "0x00000000000000000000000000000000000000Aa";
  value.stake = {
    txHash: "0xstakehash",
    from: value.playerAddress,
    amountOg: "0.1",
    blockNumber: 5,
    verifiedAt: Date.now(),
  };
  return value;
}

test("draw end confirmation queues the stake refund and the same drain pays it", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  const gameId = id();
  const value = stakedState(gameId);
  const endAction = planEnd(value, new Chess(), "draw", "draw agreed");
  assert.equal(value.refundTx?.status, "pending");
  await insert(store, value, [endAction]);
  await new DurableOutbox(store, fake).drain();
  const row = await store.get(gameId);
  assert.equal(row?.state.endTx?.status, "confirmed");
  assert.equal(row?.state.refundTx?.status, "confirmed");
  assert.equal(row?.state.refundTx?.amountOg, "0.1");
  assert.ok(row?.state.refundTx?.txHash);
  assert.deepEqual(row?.pendingActions, []);
  assert.deepEqual(fake.prepares.map((call) => call.kind), ["end", "refund"]);
  const refundCall = fake.prepares[1];
  assert.ok(refundCall?.kind === "refund");
  assert.equal(refundCall.args[0], value.stake?.from);
  assert.equal(refundCall.args[1], "100000000000000000");
});

test("a model win keeps the stake in the pot with no refund", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  const gameId = id();
  const value = stakedState(gameId);
  const endAction = planEnd(value, new Chess(), "model_win", "checkmate");
  assert.equal(value.refundTx, undefined);
  await insert(store, value, [endAction]);
  await new DurableOutbox(store, fake).drain();
  const row = await store.get(gameId);
  assert.equal(row?.state.endTx?.status, "confirmed");
  assert.equal(row?.state.refundTx, undefined);
  assert.deepEqual(row?.pendingActions, []);
  assert.deepEqual(fake.prepares.map((call) => call.kind), ["end"]);
});

test("reverted start on a staked game still refunds the stake", async () => {
  const store = new FairmateStore();
  const fake = new FakeChain();
  fake.revertKinds.add("start");
  const gameId = id();
  const value = stakedState(gameId);
  value.startTx = { status: "pending" };
  await insert(store, value, [newAction("start", { gameId })]);
  await new DurableOutbox(store, fake).drain();
  const row = await store.get(gameId);
  assert.equal(row?.state.status, "fault");
  assert.equal(row?.state.result, "aborted");
  assert.equal(row?.state.startTx.status, "failed");
  assert.equal(row?.state.refundTx?.status, "confirmed");
  assert.equal(row?.state.refundTx?.amountOg, "0.1");
  assert.deepEqual(row?.pendingActions, []);
  assert.deepEqual(fake.prepares.map((call) => call.kind), ["start", "refund"]);
});

test("exact journal verifier rejects start identity and move commitment drift", () => {
  const value = state(id());
  const startFenHash = canonicalHash(value.fen);
  const snapshot = {
    exists: true,
    startFenHash,
    player: "0x0000000000000000000000000000000000000000",
    moveCount: 0,
    result: 0,
    starts: [{
      startFenHash,
      player: "0x0000000000000000000000000000000000000000",
      model: value.model,
      verificationIdentity: value.effectiveSigner,
      txHash: "0xstart",
      blockNumber: 1,
    }],
    moves: [],
    ended: null,
    rewarded: false,
    award: null,
  };
  verifyJournalState(value, snapshot, value.fen);
  assert.throws(
    () => verifyJournalState(value, { ...snapshot, starts: [{ ...snapshot.starts[0], model: "drift" }] }, value.fen),
    /model/,
  );
  assert.throws(
    () => verifyJournalState(value, { ...snapshot, starts: [{ ...snapshot.starts[0], verificationIdentity: "0xdead" }] }, value.fen),
    /verification identity/,
  );
  assert.throws(
    () => verifyJournalState(value, { ...snapshot, moveCount: 1 }, value.fen),
    /move count/,
  );
  const moved = state(id());
  const committed = playerPly();
  moved.plies.push({ ...committed, chain: { status: "confirmed", moveNo: 1 } });
  moved.sans.push(committed.san);
  moved.fen = committed.fenAfter;
  moved.status = "model_thinking";
  const movedSnapshot = {
    ...snapshot,
    starts: [{
      ...snapshot.starts[0],
      txHash: moved.startTx.txHash!,
      blockNumber: moved.startTx.blockNumber!,
      model: moved.model,
      verificationIdentity: moved.effectiveSigner,
    }],
    moveCount: 1,
    moves: [{
      moveNo: 1,
      mover: 0,
      fenBeforeHash: committed.fenBeforeHash,
      fenAfterHash: committed.fenAfterHash,
      san: committed.san,
      receiptHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    }],
  };
  verifyJournalState(moved, movedSnapshot, committed.fenBefore);
  assert.throws(
    () => verifyJournalState(
      moved,
      { ...movedSnapshot, moves: [{ ...movedSnapshot.moves[0], fenAfterHash: "0xdead" }] },
      committed.fenBefore,
    ),
    /after/,
  );
});
