import assert from "node:assert/strict";
import test from "node:test";
import { parseEther } from "ethers";
import { checkStakeFacts, type StakeTxFacts } from "./stake-rules.js";

const POT = "0x00000000000000000000000000000000000000P0".replace("P", "a");
const PLAYER = "0x00000000000000000000000000000000000000bB";
const MIN = parseEther("0.1");

function facts(overrides: Partial<StakeTxFacts> = {}): StakeTxFacts {
  return {
    found: true,
    mined: true,
    status: 1,
    to: POT,
    from: PLAYER,
    valueWei: MIN,
    blockNumber: 42,
    ...overrides,
  };
}

test("a mined, exact stake from the payout address is accepted", () => {
  const check = checkStakeFacts(facts(), PLAYER, MIN, POT, "testnet");
  assert.ok(check.ok);
  assert.equal(check.amountOg, "0.1");
  assert.equal(check.blockNumber, 42);
});

test("overpaying is rejected so the fixed 0.2 OG award can never underpay a winner", () => {
  const check = checkStakeFacts(facts({ valueWei: parseEther("0.25") }), PLAYER, MIN, POT, "t");
  assert.ok(!check.ok && !check.retryable);
  assert.match(check.reason, /exactly 0\.1/);
  assert.match(check.reason, /0\.25/);
});

test("address comparisons are case-insensitive", () => {
  const check = checkStakeFacts(
    facts({ to: POT.toUpperCase().replace("0X", "0x"), from: PLAYER.toLowerCase() }),
    PLAYER.toUpperCase().replace("0X", "0x"),
    MIN,
    POT,
    "t",
  );
  assert.ok(check.ok);
});

test("an unknown transaction is retryable, not fatal", () => {
  const check = checkStakeFacts(null, PLAYER, MIN, POT, "t");
  assert.ok(!check.ok && check.retryable);
});

test("a known but unmined transaction is retryable", () => {
  const check = checkStakeFacts(facts({ mined: false, status: null, blockNumber: null }), PLAYER, MIN, POT, "t");
  assert.ok(!check.ok && check.retryable);
});

test("a reverted transfer is rejected permanently", () => {
  const check = checkStakeFacts(facts({ status: 0 }), PLAYER, MIN, POT, "t");
  assert.ok(!check.ok && !check.retryable);
  assert.match(check.reason, /reverted/);
});

test("a transfer to the wrong destination is rejected", () => {
  const check = checkStakeFacts(facts({ to: PLAYER }), PLAYER, MIN, POT, "t");
  assert.ok(!check.ok && !check.retryable);
  assert.match(check.reason, /ChallengePot/);
});

test("a contract creation (null to) is rejected", () => {
  const check = checkStakeFacts(facts({ to: null }), PLAYER, MIN, POT, "t");
  assert.ok(!check.ok && !check.retryable);
});

test("a stake from a third-party wallet is rejected", () => {
  const check = checkStakeFacts(facts({ from: POT }), PLAYER, MIN, POT, "t");
  assert.ok(!check.ok && !check.retryable);
  assert.match(check.reason, /payout address/);
});

test("an underpaid stake is rejected with both amounts named", () => {
  const check = checkStakeFacts(facts({ valueWei: parseEther("0.09") }), PLAYER, MIN, POT, "t");
  assert.ok(!check.ok && !check.retryable);
  assert.match(check.reason, /exactly 0\.1/);
  assert.match(check.reason, /0\.09/);
});
