import assert from "node:assert/strict";
import test from "node:test";
import {
  FAIRMATE_ROUTER_AUDITED_PRICE_CEILINGS,
  FAIRMATE_ROUTER_MAX_COMPLETION_PRICE_USD,
  FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD,
  isAuditedRouterPriceCeiling,
  withinPerMillionCeiling,
} from "./router-policy.js";

test("the active ceiling pair is a member of the audited set", () => {
  assert.equal(
    isAuditedRouterPriceCeiling({
      maxPromptPriceUsd: FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD,
      maxCompletionPriceUsd: FAIRMATE_ROUTER_MAX_COMPLETION_PRICE_USD,
    }),
    true,
  );
  assert.equal(
    FAIRMATE_ROUTER_AUDITED_PRICE_CEILINGS.at(-1)?.maxPromptPriceUsd,
    FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD,
  );
});

test("every audited epoch verifies and unknown or mixed pairs do not", () => {
  for (const epoch of FAIRMATE_ROUTER_AUDITED_PRICE_CEILINGS) {
    assert.equal(isAuditedRouterPriceCeiling(epoch), true);
  }
  assert.equal(isAuditedRouterPriceCeiling({ maxPromptPriceUsd: "99", maxCompletionPriceUsd: "2.6" }), false);
  assert.equal(isAuditedRouterPriceCeiling({ maxPromptPriceUsd: "1.9", maxCompletionPriceUsd: "2.6" }), false);
  assert.equal(isAuditedRouterPriceCeiling({ maxPromptPriceUsd: "1.90", maxCompletionPriceUsd: "5.5" }), false);
});

test("listed per-token prices compare exactly against per-million ceilings", () => {
  assert.equal(withinPerMillionCeiling("0.0000019", "1.9"), true);
  assert.equal(withinPerMillionCeiling("0.00000175", FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD), true);
  assert.equal(withinPerMillionCeiling("0.00000525", FAIRMATE_ROUTER_MAX_COMPLETION_PRICE_USD), true);
  assert.equal(withinPerMillionCeiling("0.00000175", "0.9"), false);
  assert.equal(withinPerMillionCeiling("0.0000019000001", "1.9"), false);
  assert.equal(withinPerMillionCeiling("0.000000825", "0.9"), true);
  assert.equal(withinPerMillionCeiling(undefined, "1.9"), false);
  assert.equal(withinPerMillionCeiling("", "1.9"), false);
  assert.equal(withinPerMillionCeiling("1e-6", "1.9"), false);
  assert.equal(withinPerMillionCeiling("-0.000001", "1.9"), false);
  assert.throws(() => withinPerMillionCeiling("0.000001", "abc"), /Invalid Router price ceiling/);
  assert.throws(() => withinPerMillionCeiling("0.000001", "0"), /Invalid Router price ceiling/);
});
