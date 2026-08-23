import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { pool } from "../db/pool.js";
import { Chess } from "chess.js";
import type { GameState, PlyRecord } from "../shared/protocol.js";
import { FairmateStore, newAction } from "./fairmate-store.js";
import { createClock, stopClock } from "./game-clock.js";
import { applyPly } from "./referee-state.js";
import { canonicalHash } from "../shared/canonical.js";

const ids: string[] = [];

function gameId(): string {
  const id = `test-${randomUUID()}`;
  ids.push(id);
  return id;
}

function state(id: string, status: GameState["status"] = "awaiting_player"): GameState {
  const chess = new Chess();
  const clock = createClock(Date.now());
  if (status !== "awaiting_player") stopClock(clock, Date.now());
  return {
    gameId: id,
    playerAddress: null,
    playerColor: "w",
    fen: chess.fen(),
    sans: [],
    status,
    result: "ongoing",
    clock,
    plies: [],
    chain: {
      network: "test",
      chainId: 1,
      explorer: "https://example.invalid",
      journalAddress: "0x0000000000000000000000000000000000000002",
      potAddress: "0x0000000000000000000000000000000000000003",
    },
    startTx: { status: "confirmed", blockNumber: 1, txHash: "0x01" },
    model: "test-model",
    provider: "test-provider",
    effectiveSigner: "0x0000000000000000000000000000000000000001",
    verificationScheme: "direct-teeml",
    computeCostNeuron: "0",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function insert(store: FairmateStore, value: GameState, plannedAt = Date.now()): Promise<void> {
  await store.withAdmissionLock(async (client) => {
    await store.insert(
      {
        gameId: value.gameId,
        state: value,
        capabilityHash: `token-${value.gameId}`,
        admissionKey: `admission-${value.gameId}`,
        admissionDay: "2099-01-01",
        status: value.status,
        pendingActions: [{ ...newAction("start", { gameId: value.gameId }), plannedAt }],
      },
      client,
    );
  });
}

after(async () => {
  if (ids.length) {
    await pool.query(`delete from "fairmate"."fairmate_games" where game_id = any($1::text[])`, [
      ids,
    ]);
  }
  await pool.end();
});

test("two real stores re-read persisted token, admission and state after restart", async () => {
  const first = new FairmateStore();
  const id = gameId();
  await insert(first, state(id));
  const second = new FairmateStore();
  const row = await second.get(id);
  assert.equal(row?.capabilityHash, `token-${id}`);
  assert.equal(row?.admissionKey, `admission-${id}`);
  assert.deepEqual(row?.state.sans, []);
  assert.equal(row?.pendingActions.length, 1);
});

test("PostgreSQL per-game advisory lock permits one logical ply", async () => {
  const first = new FairmateStore();
  const second = new FairmateStore();
  const id = gameId();
  const initial = state(id);
  await insert(first, initial);
  await first.save(id, initial, []);
  const mutate = (store: FairmateStore) =>
    store.withGameLock(id, async (client) => {
      const row = await store.get(id, client);
      assert.ok(row);
      if (row.state.sans.length !== 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
      row.state.sans.push("e4");
      await store.save(id, row.state, [], client);
    });
  await Promise.all([mutate(first), mutate(second)]);
  assert.deepEqual((await first.get(id))?.state.sans, ["e4"]);
});

test("inference lease is exclusive and supports expiry takeover", async () => {
  const first = new FairmateStore();
  const second = new FairmateStore();
  const id = gameId();
  const thinking = state(id, "model_thinking");
  await insert(first, thinking);
  await first.save(id, thinking, []);
  assert.equal(await first.claimInference(id, 30), true);
  assert.equal(await second.claimInference(id, 30), false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await second.claimInference(id, 1000), true);
});

test("definitively failed starts do not consume persisted daily admission", async () => {
  const store = new FairmateStore();
  const id = gameId();
  const failed = state(id);
  failed.status = "fault";
  failed.result = "aborted";
  failed.startTx = { status: "failed", error: "reverted" };
  let globalBefore = 0;
  await store.withAdmissionLock(async (client) => {
    globalBefore = (await store.admissionCounts("2099-01-01", `admission-${id}`, client)).dailyGlobal;
  });
  await insert(store, failed);
  await store.save(id, failed, []);
  await store.withAdmissionLock(async (client) => {
    const counts = await store.admissionCounts("2099-01-01", `admission-${id}`, client);
    assert.equal(counts.dailyForKey, 0);
    assert.equal(counts.dailyGlobal, globalBefore);
  });
});

test("prepared nonce precedes an unsigned action on an older row", async () => {
  const store = new FairmateStore();
  const olderUnsignedId = gameId();
  const newerPreparedId = gameId();
  await insert(store, state(olderUnsignedId), 100);
  await insert(store, state(newerPreparedId), 200);
  const prepared = await store.get(newerPreparedId);
  const head = prepared?.pendingActions[0];
  assert.ok(prepared && head);
  head.nonce = 7;
  head.txHash = "0x07";
  head.rawTx = "0x0707";
  await store.save(newerPreparedId, prepared.state, prepared.pendingActions);
  const listed = (await store.listPending())
    .filter((row) => row.gameId === olderUnsignedId || row.gameId === newerPreparedId)
    .map((row) => row.gameId);
  assert.deepEqual(listed, [newerPreparedId, olderUnsignedId]);
});

test("setPendingSigned updates only the matching queue head", async () => {
  const store = new FairmateStore();
  const id = gameId();
  const value = state(id);
  const head = { ...newAction("start", { gameId: id }), plannedAt: 1 };
  const tail = { ...newAction("ply", { gameId: id }), plannedAt: 2 };
  await store.withAdmissionLock(async (client) => {
    await store.insert(
      {
        gameId: id,
        state: value,
        capabilityHash: `token-${id}`,
        admissionKey: `admission-${id}`,
        admissionDay: "2099-01-01",
        status: value.status,
        pendingActions: [head, tail],
      },
      client,
    );
  });
  await store.setPendingSigned(id, { ...head, rawTx: "0xraw", txHash: "0xhash", nonce: 3 });
  const row = await store.get(id);
  assert.equal(row?.pendingActions.length, 2);
  assert.equal(row?.pendingActions[0]?.rawTx, "0xraw");
  assert.equal(row?.pendingActions[1]?.id, tail.id);
  assert.equal(row?.pendingActions[1]?.rawTx, undefined);
  await store.setPendingSigned(id, { ...tail, rawTx: "0xwrong" });
  assert.equal((await store.get(id))?.pendingActions[0]?.rawTx, "0xraw");
});

test("registerStake burns a stake tx hash once, case-insensitively", async () => {
  const store = new FairmateStore();
  const a = gameId();
  const b = gameId();
  const hash = `0xAB${randomUUID().replaceAll("-", "")}`;
  try {
    const first = await store.withAdmissionLock((client) => store.registerStake(hash, a, client));
    const second = await store.withAdmissionLock((client) =>
      store.registerStake(hash.toLowerCase(), b, client),
    );
    assert.equal(first, true);
    assert.equal(second, false);
  } finally {
    await pool.query(`delete from "fairmate"."fairmate_stakes" where tx_hash = $1`, [
      hash.toLowerCase(),
    ]);
  }
});

test("optimistic ply application advances board, phase and clock immediately", () => {
  const id = gameId();
  const value = state(id);
  const chess = new Chess();
  const before = chess.fen();
  const played = chess.move("e4");
  assert.ok(played);
  const ply: PlyRecord = {
    ply: 1,
    mover: "player",
    san: played.san,
    fenBefore: before,
    fenAfter: chess.fen(),
    fenBeforeHash: canonicalHash(before),
    fenAfterHash: canonicalHash(chess.fen()),
    receiptHash: null,
    chain: { status: "pending" },
    at: Date.now(),
  };
  const next = applyPly(value, ply, Date.now());
  assert.equal(next, null);
  assert.deepEqual(value.sans, ["e4"]);
  assert.equal(value.status, "model_thinking");
  assert.equal(value.clock.active, "model");
  assert.equal(value.plies[0]?.chain.status, "pending");
  assert.equal(value.plies[0]?.chain.moveNo, 1);
});

test("terminal optimistic ply ends the game locally and plans the end anchor", () => {
  const id = gameId();
  const value = state(id, "model_thinking");
  const chess = new Chess();
  for (const [index, san] of ["f3", "e5", "g4"].entries()) {
    const before = chess.fen();
    const move = chess.move(san);
    assert.ok(move);
    value.sans.push(move.san);
    value.plies.push({
      ply: index + 1,
      mover: index % 2 === 0 ? "player" : "model",
      san: move.san,
      fenBefore: before,
      fenAfter: chess.fen(),
      fenBeforeHash: canonicalHash(before),
      fenAfterHash: canonicalHash(chess.fen()),
      receiptHash: index % 2 === 0 ? null : "0x01",
      chain: { status: "confirmed", moveNo: index + 1 },
      at: Date.now(),
    });
  }
  value.fen = chess.fen();
  const before = chess.fen();
  const mate = chess.move("Qh4#");
  assert.ok(mate);
  const ply: PlyRecord = {
    ply: 4,
    mover: "model",
    san: mate.san,
    fenBefore: before,
    fenAfter: chess.fen(),
    fenBeforeHash: canonicalHash(before),
    fenAfterHash: canonicalHash(chess.fen()),
    receiptHash: "0x02",
    chain: { status: "pending" },
    at: Date.now(),
  };
  const next = applyPly(value, ply, Date.now());
  assert.equal(value.status, "ended");
  assert.equal(value.result, "model_win");
  assert.equal(value.endTx?.status, "pending");
  assert.equal(value.clock.active, null);
  assert.equal(next?.kind, "end");
  assert.deepEqual(value.sans, ["f3", "e5", "g4", "Qh4#"]);
});
