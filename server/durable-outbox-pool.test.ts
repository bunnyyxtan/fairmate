/**
 * Regression: concurrent drains must never starve the connection pool.
 *
 * DATABASE_POOL_SIZE is pinned to 4 BEFORE the pool module loads (the Vercel
 * default), then six drains race on one wallet lock. With a blocking
 * pg_advisory_lock, every waiter parks on a live pool connection while the
 * holder still needs connections for its own queries — four concurrent
 * drains then self-deadlock the instance and anchors/payouts stop. The
 * off-connection try-lock wait in withWalletLock is what this guards.
 */
process.env.DATABASE_POOL_SIZE = "4";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { Chess } from "chess.js";
import type { TransactionReceipt } from "ethers";
import type { GameState } from "../shared/protocol.js";
import { createClock } from "./game-clock.js";
import type { PreparedChainCall, SignedChainTransaction } from "./chain.js";
import type { AwardRead, OutboxChain } from "./durable-outbox.js";

const { pool } = await import("../db/pool.js");
const { DurableOutbox } = await import("./durable-outbox.js");
const { FairmateStore, newAction } = await import("./fairmate-store.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ids: string[] = [];

function id(): string {
  const value = `outbox-pool-test-${randomUUID()}`;
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
    startTx: { status: "pending" },
    model: "model",
    provider: "provider",
    effectiveSigner: "0x0000000000000000000000000000000000000001",
    verificationScheme: "direct-teeml",
    computeCostNeuron: "0",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Every chain call sleeps, so the wallet lock is held long enough to contend. */
class SlowChain implements OutboxChain {
  prepares = 0;
  nextNonce = 1;
  receipts = new Map<string, TransactionReceipt>();
  rawToHash = new Map<string, string>();

  async prepare(call: PreparedChainCall): Promise<SignedChainTransaction> {
    await sleep(40);
    this.prepares++;
    const nonce = this.nextNonce++;
    const rawTx = `raw-${nonce}-${call.kind}`;
    const txHash = `hash-${nonce}-${call.kind}`;
    this.rawToHash.set(rawTx, txHash);
    return { rawTx, txHash, nonce };
  }
  async receipt(txHash: string): Promise<TransactionReceipt | null> {
    await sleep(20);
    return this.receipts.get(txHash) ?? null;
  }
  async broadcast(rawTx: string): Promise<TransactionReceipt> {
    await sleep(40);
    const mined = { status: 1, blockNumber: 10 + this.nextNonce } as TransactionReceipt;
    this.receipts.set(this.rawToHash.get(rawTx) ?? rawTx, mined);
    return mined;
  }
  async award(): Promise<AwardRead> {
    return { rewarded: false };
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

test("six concurrent drains complete on a four-connection pool", async () => {
  assert.equal(pool.options.max, 4, "pool must be pinned to the serverless size");
  const fake = new SlowChain();
  const store = new FairmateStore();
  const games: string[] = [];
  for (let i = 0; i < 6; i++) {
    const gameId = id();
    games.push(gameId);
    const value = state(gameId);
    await store.withAdmissionLock((client) =>
      store
        .insert(
          {
            gameId,
            state: value,
            capabilityHash: `token-${gameId}`,
            admissionKey: `key-${gameId}`,
            admissionDay: "2099-03-01",
            status: value.status,
            pendingActions: [newAction("start", { gameId })],
          },
          client,
        )
        .then(() => undefined),
    );
  }
  const drains = Array.from({ length: 6 }, () =>
    new DurableOutbox(new FairmateStore(), fake).drain(),
  );
  const outcome = await Promise.race([
    Promise.all(drains).then(() => "drained"),
    sleep(60_000).then(() => "starved"),
  ]);
  assert.equal(outcome, "drained", "drains deadlocked the pool instead of completing");
  for (const gameId of games) {
    const row = await store.get(gameId);
    assert.equal(row?.state.startTx.status, "confirmed");
    assert.deepEqual(row?.pendingActions, []);
  }
  assert.equal(fake.prepares, 6);
});
