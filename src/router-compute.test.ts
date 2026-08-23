import assert from "node:assert/strict";
import test from "node:test";
import {
  allChecksPass,
  computeRouterReceiptHash,
  verifyReceiptBundle,
} from "../shared/receipt.js";
import {
  ROUTER_MODEL,
  ROUTER_PROVIDER,
  parseRouterCompletion,
  type RouterSelection,
} from "./router-compute.js";

const selection: RouterSelection = {
  scheme: "router-teetls",
  model: ROUTER_MODEL,
  provider: ROUTER_PROVIDER,
  effectiveSigner: ROUTER_PROVIDER,
  endpoint: "https://router-api.0g.ai/v1/chat/completions",
  verifiability: "TeeTLS",
  metadata: {
    address: ROUTER_PROVIDER,
    canonical_id: ROUTER_MODEL,
    model_id: ROUTER_MODEL,
    is_healthy: true,
  },
};

function response(teeVerified = true): string {
  return JSON.stringify({
    id: "chat-1",
    model: ROUTER_MODEL,
    choices: [{ message: { content: '{"move":"e5","why":"Claims the centre"}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
    x_0g_trace: {
      request_id: "request-1",
      provider: ROUTER_PROVIDER,
      tee_verified: teeVerified,
      billing: {
        input_cost: "1000",
        output_cost: "2000",
        total_cost: "3000",
      },
    },
  });
}

test("accepts a pinned, TeeTLS-verified Router response and binds its bytes", () => {
  const requestBodyJson = JSON.stringify({
    model: ROUTER_MODEL,
    messages: [{ role: "user", content: "Position (FEN): test" }],
    verify_tee: true,
  });
  const completion = parseRouterCompletion({
    rawBody: response(),
    requestBodyJson,
    selection,
    latencyMs: 42,
  });
  assert.equal(completion.content.includes('"e5"'), true);
  assert.equal(completion.receipt.trace.teeVerified, true);
  assert.equal(allChecksPass(verifyReceiptBundle(completion.receipt)), true);
});

test("rejects a Router response whose TeeTLS verification is false", () => {
  assert.throws(
    () =>
      parseRouterCompletion({
        rawBody: response(false),
        requestBodyJson: JSON.stringify({ model: ROUTER_MODEL, verify_tee: true }),
        selection,
        latencyMs: 42,
      }),
    /verification failed or was absent/,
  );
});

test("rejects model or provider drift even when tee_verified is true", () => {
  const wrongModel = JSON.parse(response()) as Record<string, unknown>;
  wrongModel.model = "qwen3.8-max";
  assert.throws(
    () =>
      parseRouterCompletion({
        rawBody: JSON.stringify(wrongModel),
        requestBodyJson: JSON.stringify({ model: ROUTER_MODEL, verify_tee: true }),
        selection,
        latencyMs: 42,
      }),
    /model drift/,
  );

  const wrongProvider = JSON.parse(response()) as {
    x_0g_trace: { provider: string };
  };
  wrongProvider.x_0g_trace.provider = "0x0000000000000000000000000000000000000001";
  assert.throws(
    () =>
      parseRouterCompletion({
        rawBody: JSON.stringify(wrongProvider),
        requestBodyJson: JSON.stringify({ model: ROUTER_MODEL, verify_tee: true }),
        selection,
        latencyMs: 42,
      }),
    /provider drift/,
  );
});

test("client checks fail if committed Router response bytes are tampered", () => {
  const requestBodyJson = JSON.stringify({ model: ROUTER_MODEL, verify_tee: true });
  const completion = parseRouterCompletion({
    rawBody: response(),
    requestBodyJson,
    selection,
    latencyMs: 42,
  });
  const tampered = { ...completion.receipt, rawBody: completion.receipt.rawBody.replace("e5", "a5") };
  assert.equal(allChecksPass(verifyReceiptBundle(tampered)), false);
});

test("client rejects self-consistent evidence with looser Router price ceilings", () => {
  const completion = parseRouterCompletion({
    rawBody: response(),
    requestBodyJson: JSON.stringify({ model: ROUTER_MODEL, verify_tee: true }),
    selection,
    latencyMs: 42,
  });
  const tampered = {
    ...completion.receipt,
    requestConstraints: {
      ...completion.receipt.requestConstraints,
      maxPromptPriceUsd: "99",
    },
  };
  tampered.receiptHash = computeRouterReceiptHash(tampered);
  const checks = verifyReceiptBundle(tampered);
  assert.equal(checks.find((check) => check.name === "routing constraints bound")?.pass, false);
  assert.equal(allChecksPass(checks), false);
});