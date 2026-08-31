/**
 * Live pin audit — one verified move against the ACTIVE Router provider pin.
 *
 * Run this BEFORE shipping a provider re-pin. It proves, end to end, that:
 *   1. discovery accepts the pinned provider's live listing profile
 *      (healthy, TeeTLS, verified, TDX, dstack, pricing under ceilings);
 *   2. a real completion routes to that exact provider (no drift) and the
 *      Router reports tee_verified=true for it;
 *   3. the captured receipt passes the full offline verifier chain
 *      (hash binding, routing constraints, trace consistency, billing);
 *   4. the signed response decodes to a legal SAN, like production replay.
 *
 * Usage: OG_ROUTER_API_KEY must be set. `pnpm run audit:pin`
 * Cost: one qwen3.7-max move (~$0.004 at the pinned pricing).
 */
import { Chess } from "chess.js";
import { discoverRouterSelection, routerCompletion } from "../src/router-compute.js";
import { verifyReceiptBundle } from "../shared/receipt.js";
import { parseMove } from "../src/chess-agent.js";
import { FAIRMATE_ROUTER_PROVIDER } from "../shared/router-policy.js";

const chess = new Chess();
chess.move("e4");
chess.move("e5");
chess.move("Nf3");
const legal = chess.moves();
const messages = [
  {
    role: "system",
    content:
      'You are FairMate, a chess engine playing a serious game. You are given the position as FEN and the complete list of legal moves in SAN. Choose the strongest move for the side to move. Respond with ONLY a JSON object: {"move":"<one SAN exactly as it appears in the legal list>","why":"<max 12 words>"} No markdown, no code fences, no other text.',
  },
  {
    role: "user",
    content: `Position (FEN): ${chess.fen()}\nSide to move: Black\nMove number: 2\nLegal moves: ${legal.join(" ")}\nPick exactly one move from the legal list.`,
  },
];

console.log(`[audit] active pin: ${FAIRMATE_ROUTER_PROVIDER}`);
const selection = await discoverRouterSelection();
console.log(
  `[audit] discovery OK: provider=${selection.provider} model=${selection.model} listedLatency=${String(selection.metadata.latency)}ms healthy=${String(selection.metadata.is_healthy)}`,
);
const started = Date.now();
const res = await routerCompletion(selection, messages, 0.2);
console.log(`[audit] completion OK in ${Date.now() - started}ms`);
console.log(
  `[audit] trace: requestId=${res.receipt.trace.requestId} provider=${res.receipt.trace.provider} teeVerified=${String(res.receipt.trace.teeVerified)}`,
);
console.log(`[audit] billing: total=${res.receipt.trace.billing.totalCostNeuron} neuron`);

const parsed = parseMove(res.content, legal);
console.log(`[audit] move: ${parsed ? parsed.san : "UNPARSEABLE"} — ${res.content.slice(0, 120)}`);

let failures = parsed ? 0 : 1;
for (const c of verifyReceiptBundle(res.receipt)) {
  console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.name} - ${c.detail}`);
  if (!c.pass) failures += 1;
}
if (failures > 0) {
  console.error(`[audit] FAILED: ${failures} check(s) failed — do NOT ship this pin`);
  process.exit(1);
}
console.log("[audit] all checks passed: the active pin serves verified inference end to end");
