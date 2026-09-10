import assert from "node:assert/strict";
import test from "node:test";
import {
  PracticeOnlyAdmissionError,
  databaseUrlFromEnv,
  enforceAdmissionPolicy,
  practiceOnlyFinancials,
  practiceOnlyFromEnv,
} from "./runtime-policy.js";

test("practice-only flag is true only for a true value and defaults to legacy mode", () => {
  assert.equal(practiceOnlyFromEnv({}), false);
  assert.equal(practiceOnlyFromEnv({ FAIRMATE_PRACTICE_ONLY: "false" }), false);
  assert.equal(practiceOnlyFromEnv({ FAIRMATE_PRACTICE_ONLY: "TRUE" }), true);
  assert.equal(practiceOnlyFromEnv({ FAIRMATE_PRACTICE_ONLY: " true " }), true);
  assert.equal(practiceOnlyFromEnv({ FAIRMATE_PRACTICE_ONLY: "1" }), false);
});

test("a nonempty recovery database forces practice-only despite an explicit false", () => {
  assert.equal(practiceOnlyFromEnv({
    FAIRMATE_PRACTICE_ONLY: "false",
    FAIRMATE_RECOVERY_DATABASE_URL: "postgres://recovery",
  }), true);
  assert.equal(practiceOnlyFromEnv({
    FAIRMATE_PRACTICE_ONLY: "false",
    FAIRMATE_RECOVERY_DATABASE_URL: "   ",
  }), false);
});

test("recovery database is preferred while empty values retain the legacy database", () => {
  assert.equal(databaseUrlFromEnv({
    DATABASE_URL: "postgres://legacy",
    FAIRMATE_RECOVERY_DATABASE_URL: "postgres://recovery",
  }), "postgres://recovery");
  assert.equal(databaseUrlFromEnv({
    DATABASE_URL: "postgres://legacy",
    FAIRMATE_RECOVERY_DATABASE_URL: "",
  }), "postgres://legacy");
  assert.equal(databaseUrlFromEnv({}), undefined);
});

test("practice-only admission rejects either paid field, including empty supplied fields", () => {
  for (const fields of [
    ["0xplayer", undefined],
    [undefined, "0xstake"],
    ["0xplayer", "0xstake"],
    ["", undefined],
  ] as const) {
    assert.throws(
      () => enforceAdmissionPolicy(true, fields[0], fields[1]),
      PracticeOnlyAdmissionError,
    );
  }
});

test("practice admission remains available and legacy paid admission is preserved", () => {
  assert.doesNotThrow(() => enforceAdmissionPolicy(true, undefined, undefined));
  assert.doesNotThrow(() => enforceAdmissionPolicy(false, "0xplayer", "0xstake"));
});

test("practice-only API financial metadata is explicitly unavailable", () => {
  assert.deepEqual(practiceOnlyFinancials(), {
    potBalanceOg: null,
    perWinBountyOg: null,
    entryFeeOg: null,
    dailyCapOg: null,
    paidInWindowOg: null,
    windowStart: null,
    refereeAddress: null,
  });
});