import assert from "node:assert/strict";
import test from "node:test";
import { createClock, startTurn, stopClock, tickClock } from "./game-clock";

test("creates a 5+0 clock with the player running", () => {
  const clock = createClock(1_000);
  assert.equal(clock.playerMs, 300_000);
  assert.equal(clock.modelMs, 300_000);
  assert.equal(clock.active, "player");
  assert.equal(clock.activeSince, 1_000);
});

test("charges only the active side and switches without an increment", () => {
  const clock = createClock(1_000, 10_000);
  assert.equal(startTurn(clock, "model", 3_500), null);
  assert.equal(clock.playerMs, 7_500);
  assert.equal(clock.modelMs, 10_000);
  assert.equal(clock.active, "model");

  assert.equal(startTurn(clock, "player", 7_500), null);
  assert.equal(clock.playerMs, 7_500);
  assert.equal(clock.modelMs, 6_000);
});

test("returns the side whose flag falls", () => {
  const clock = createClock(10, 1_000);
  assert.equal(tickClock(clock, 1_011), "player");
  assert.equal(clock.playerMs, 0);
});

test("stopping a clock charges elapsed time and clears the active side", () => {
  const clock = createClock(100, 5_000);
  assert.equal(stopClock(clock, 1_100), null);
  assert.equal(clock.playerMs, 4_000);
  assert.equal(clock.active, null);
  assert.equal(clock.activeSince, null);
});

test("does not add time when the supplied clock moves backwards", () => {
  const clock = createClock(1_000, 5_000);
  assert.equal(tickClock(clock, 900), null);
  assert.equal(clock.playerMs, 5_000);
  assert.equal(clock.activeSince, 900);
});

test("does not switch sides after the current side has already expired", () => {
  const clock = createClock(0, 1_000);
  assert.equal(startTurn(clock, "model", 1_001), "player");
  assert.equal(clock.playerMs, 0);
  assert.equal(clock.active, "player");
});