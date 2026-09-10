import assert from "node:assert/strict";
import test from "node:test";
import { parseEther } from "ethers";
import {
  POT_WINDOW_SECONDS,
  displayOg,
  effectivePaidInWindowWei,
  evaluateGasGate,
  evaluatePrizeGate,
  type PotFacts,
} from "./paid-admission.js";

const NOW_MS = Date.UTC(2026, 8, 10, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

const gas = { refereeBalanceOg: "0.5", gasReserveOg: "0.1" };

function potFacts(overrides: Partial<PotFacts> = {}): PotFacts {
  return {
    potBalanceOg: "3.1",
    perWinBountyOg: "0.2",
    dailyCapOg: "0.6",
    paidInWindowOg: "0.0",
    windowStart: NOW_SECONDS - 3_600,
    ...overrides,
  };
}

test("gate reasons show at most four decimals and never round a balance up", () => {
  assert.equal(displayOg(parseEther("0.00673252459699834")), "0.0067");
  assert.equal(displayOg(parseEther("0.09999")), "0.0999");
  assert.equal(displayOg(parseEther("3.1")), "3.1");
  assert.equal(displayOg(parseEther("2")), "2");
  assert.equal(displayOg(0n), "0");
  const gate = evaluateGasGate({ refereeBalanceOg: "0.00673252459699834", gasReserveOg: "0.1" });
  assert.match(gate.reason ?? "", /holds 0\.0067 0G/);
});

test("games stay closed while the referee wallet is below its gas reserve", () => {
  const gate = evaluateGasGate({ refereeBalanceOg: "0.006", gasReserveOg: "0.1" });
  assert.equal(gate.open, false);
  assert.match(gate.reason ?? "", /0\.006 0G/);
  assert.match(gate.reason ?? "", /0\.1 0G reserve/);
  assert.equal(evaluateGasGate({ refereeBalanceOg: "0.1", gasReserveOg: "0.1" }).open, true);
});

test("a healthy pot opens prize admission", () => {
  assert.deepEqual(evaluatePrizeGate(gas, potFacts(), NOW_MS), { open: true, reason: null });
});

test("the gas reserve applies to prize games before any pot rule", () => {
  const gate = evaluatePrizeGate({ refereeBalanceOg: "0", gasReserveOg: "0.1" }, potFacts({ perWinBountyOg: "0" }), NOW_MS);
  assert.equal(gate.open, false);
  assert.match(gate.reason ?? "", /referee wallet/);
});

test("an unconfigured bounty closes prize games", () => {
  const gate = evaluatePrizeGate(gas, potFacts({ perWinBountyOg: "0" }), NOW_MS);
  assert.equal(gate.open, false);
  assert.match(gate.reason ?? "", /no win bounty configured/);
});

test("a pot that cannot pay one win closes prize games", () => {
  const gate = evaluatePrizeGate(gas, potFacts({ potBalanceOg: "0.15" }), NOW_MS);
  assert.equal(gate.open, false);
  assert.match(gate.reason ?? "", /holds 0\.15 0G, below the 0\.2 0G win payout/);
  assert.equal(evaluatePrizeGate(gas, potFacts({ potBalanceOg: "0.2" }), NOW_MS).open, true);
});

test("daily-cap headroom is required for one more win inside the live window", () => {
  const capped = evaluatePrizeGate(gas, potFacts({ paidInWindowOg: "0.4" }), NOW_MS);
  assert.equal(capped.open, true, "0.4 paid + 0.2 win exactly fills a 0.6 cap");
  const exceeded = evaluatePrizeGate(gas, potFacts({ paidInWindowOg: "0.5" }), NOW_MS);
  assert.equal(exceeded.open, false);
  assert.match(exceeded.reason ?? "", /prize cap of 0\.6 0G/);
  assert.match(exceeded.reason ?? "", /reopen at 2026-09-11T11:00:00\.000Z/);
});

test("a window older than a day rolls over, so yesterday's payouts do not block today", () => {
  const stale = potFacts({ paidInWindowOg: "0.6", windowStart: NOW_SECONDS - POT_WINDOW_SECONDS });
  assert.equal(effectivePaidInWindowWei(stale, NOW_MS), 0n);
  assert.equal(evaluatePrizeGate(gas, stale, NOW_MS).open, true);
  const oneSecondFresh = potFacts({ paidInWindowOg: "0.6", windowStart: NOW_SECONDS - POT_WINDOW_SECONDS + 1 });
  assert.equal(evaluatePrizeGate(gas, oneSecondFresh, NOW_MS).open, false);
});

test("each unsettled prize game reserves one full win payout from the pot", () => {
  // 3.1 0G pot covers fifteen 0.2 0G payouts, cap is what binds first.
  assert.equal(evaluatePrizeGate(gas, potFacts(), NOW_MS, 2).open, true, "0.6 cap: two reserved + one more fits");
  const capBound = evaluatePrizeGate(gas, potFacts(), NOW_MS, 3);
  assert.equal(capBound.open, false, "three reserved wins already fill the 0.6 cap");
  assert.match(capBound.reason ?? "", /3 unsettled prize games already reserved/);
  const potBound = evaluatePrizeGate(gas, potFacts({ potBalanceOg: "0.4", dailyCapOg: "10" }), NOW_MS, 1);
  assert.equal(potBound.open, true, "0.4 covers one reserved + one more");
  const potShort = evaluatePrizeGate(gas, potFacts({ potBalanceOg: "0.4", dailyCapOg: "10" }), NOW_MS, 2);
  assert.equal(potShort.open, false);
  assert.match(potShort.reason ?? "", /holds 0\.4 0G, below the 0\.2 0G win payout plus 2 unsettled prize games/);
});

test("an unknown outstanding count fails closed instead of opening the slot", () => {
  assert.equal(evaluatePrizeGate(gas, potFacts(), NOW_MS, -1).open, false);
  assert.equal(evaluatePrizeGate(gas, potFacts(), NOW_MS, Number.NaN).open, false);
  assert.equal(evaluatePrizeGate(gas, potFacts(), NOW_MS, 1.5).open, false);
});
