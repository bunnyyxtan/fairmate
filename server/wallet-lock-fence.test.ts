/**
 * Regression: the wallet lock must survive long chain waits and must fence
 * the drain when its session dies anyway.
 *
 * The holder's connection runs no statements of its own while a drain waits
 * on the chain, and managed Postgres terminates idle-in-transaction sessions.
 * The heartbeat interval is pinned to 50ms BEFORE the store module loads so
 * the keep-alive is observable within one test. Session death is simulated
 * with pg_terminate_backend on the holder: the fence must trip, the lock must
 * be gone, the drain must refuse to continue, and the pool must stay usable.
 */
process.env.FAIRMATE_WALLET_LOCK_HEARTBEAT_MS = "50";

import assert from "node:assert/strict";
import test, { after } from "node:test";

const { pool } = await import("../db/pool.js");
const { FairmateStore } = await import("./fairmate-store.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Holder {
  pid: number;
  state: string | null;
  query: string | null;
  state_change: Date | null;
}

async function holders(): Promise<Holder[]> {
  const result = await pool.query(
    `select l.pid, a.state, a.query, a.state_change
     from pg_locks l left join pg_stat_activity a on a.pid = l.pid
     where l.locktype = 'advisory' and l.granted
       and l.classid = (hashtextextended($1, 0) >> 32)::int
       and l.objid = (hashtextextended($1, 0) & x'ffffffff'::bigint)::oid`,
    ["fairmate:referee-wallet:v1"],
  );
  return result.rows as Holder[];
}

after(async () => {
  await pool.end();
});

test("heartbeat keeps the lock session active during a long drain", async () => {
  const store = new FairmateStore();
  await store.withWalletLock(async (fence) => {
    const [first] = await holders();
    assert.ok(first, "wallet lock is held while draining");
    await sleep(400);
    const [later] = await holders();
    assert.equal(later?.pid, first.pid, "the same backend still holds the lock");
    assert.equal(fence.held(), true);
    // Activity columns are visible only with track_activities and stats
    // privileges; where they are, the heartbeat must have run recently.
    if (first.state && first.state !== "disabled" && first.state_change && later?.state_change) {
      assert.ok(
        later.state_change.getTime() > first.state_change.getTime(),
        "heartbeat statements keep resetting the session's idle clock",
      );
      assert.equal(later.query?.trim(), "select 1");
    }
  });
  assert.deepEqual(await holders(), []);
});

test("a terminated lock session trips the fence and releases the lock", async () => {
  const store = new FairmateStore();
  let heldAfterKill: boolean | null = null;
  let assertion: Error | null = null;
  await assert.rejects(
    store.withWalletLock(async (fence) => {
      const [holder] = await holders();
      assert.ok(holder);
      assert.equal(fence.held(), true);
      await pool.query("select pg_terminate_backend($1)", [holder.pid]);
      // The client learns about the termination asynchronously; the fence
      // flips as soon as the connection error or the next heartbeat lands.
      for (let i = 0; i < 40 && fence.held(); i++) await sleep(50);
      heldAfterKill = fence.held();
      try {
        fence.assertHeld();
      } catch (error) {
        assertion = error as Error;
      }
      return "finished despite a dead session";
    }),
  );
  assert.equal(heldAfterKill, false, "fence reports the lost lock");
  assert.match(String(assertion), /wallet lock lost/);
  assert.deepEqual(await holders(), [], "no lock survives the terminated session");
  // The dead connection was discarded, not returned: the pool still works.
  assert.equal(await store.withWalletLock(async () => "reacquired"), "reacquired");
  assert.deepEqual(await holders(), []);
});
