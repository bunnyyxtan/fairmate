/**
 * Mainnet Router self-play — Qwen plays BOTH sides so every ply carries a
 * TeeTLS-verified Router trace. Useful as a standalone demo of receipt density
 * (no chain writes; the product server does those per real game).
 *
 * Every response requires verify_tee=true and x_0g_trace.tee_verified=true.
 * Evidence stores exact request/response bytes, provider, billing and the
 * resulting commitment so any third party can re-run every exposed check:
 *   pnpm run verify -- --file=evidence/selfplay.json
 * NO mocks, NO fallbacks; exhausted retries are a hard, recorded failure.
 *
 * Usage: pnpm run selfplay        (TARGET_PLIES env, default 6)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Chess } from "chess.js";
import { canonicalHash } from "../shared/canonical.js";
import { EVIDENCE_DIR, NETWORKS } from "../src/config.js";
import { discoverRouterSelection, routerCompletion } from "../src/router-compute.js";
import { CHESS_SYSTEM_PROMPT, buildMoveUserPrompt, parseMove } from "../src/chess-agent.js";

const TARGET_PLIES = Number(process.env.TARGET_PLIES ?? 6);
const MAX_ATTEMPTS_PER_MOVE = 2;
const net = NETWORKS.mainnet;

async function main() {
  console.log(`[selfplay] ${net.displayName} — target ${TARGET_PLIES} attested plies`);
  const sel = await discoverRouterSelection();
  console.log(`[selfplay] Router ready — provider ${sel.provider}, model ${sel.model}`);

  const chess = new Chess();
  const startFen = chess.fen();
  const plies: Array<Record<string, unknown>> = [];
  const sans: string[] = [];

  for (let ply = 1; ply <= TARGET_PLIES; ply++) {
    if (chess.isGameOver()) break;
    let feedback: string | undefined;
    let done = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MOVE; attempt++) {
      const legalSans = chess.moves();
      const prompt = buildMoveUserPrompt({
        fen: chess.fen(),
        turn: chess.turn() as "w" | "b",
        fullmoveNumber: chess.moveNumber(),
        legalSans,
        recentHistory: sans.slice(-8),
        feedback,
      });
      const vc = await routerCompletion(
        sel,
        [
          { role: "system", content: CHESS_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        0.2,
      );
      const parsed = parseMove(vc.content, legalSans);
      if (!parsed) {
        feedback = `Your previous reply was not a single legal move from the list. Reply with ONLY the JSON object. Previous reply began: ${vc.content.slice(0, 80)}`;
        console.warn(`[selfplay] ply ${ply}: unparseable reply (attempt ${attempt}/${MAX_ATTEMPTS_PER_MOVE})`);
        continue;
      }
      const fenBefore = chess.fen();
      const played = chess.move(parsed.san);
      plies.push({
        ply,
        mover: "model",
        san: played.san,
        why: parsed.why || undefined,
        fenBefore,
        fenAfter: chess.fen(),
        fenBeforeHash: canonicalHash(fenBefore),
        fenAfterHash: canonicalHash(chess.fen()),
        receiptHash: vc.receipt.receiptHash,
        receipt: vc.receipt,
      });
      sans.push(played.san);
      console.log(`[selfplay] ply ${ply}: ${played.san} (${vc.receipt.latencyMs} ms, receipt ${vc.receipt.receiptHash.slice(0, 14)}…)`);
      done = true;
      break;
    }
    if (!done) {
      throw new Error(`[selfplay] ply ${ply}: model failed to produce a legal move — HARD FAIL (recorded, not papered over)`);
    }
  }

  const out = {
    kind: "fairmate-selfplay-evidence",
    network: net.displayName,
    chainId: net.chainId,
    model: sel.model,
    provider: sel.provider,
    effectiveSigner: sel.effectiveSigner,
    verificationScheme: sel.scheme,
    startFen,
    finalFen: chess.fen(),
    sans,
    plies,
    ranAt: new Date().toISOString(),
  };
  const outPath = resolve(EVIDENCE_DIR, "selfplay.router.mainnet.json");
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[selfplay] wrote ${outPath} (${plies.length} attested plies)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
