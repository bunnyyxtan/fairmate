/**
 * Attested self-play — per-move attested inference.
 * Proof: 10 consecutive TEE-verified chess moves on Galileo testnet.
 * Self-play (the model moves for both sides) so every ply is an attested move.
 * Every response: signature fetched, ECDSA recovers to the ATTESTED TEE
 * signer, signed responseHash === sha256(raw response bytes we hold),
 * processResponse(usage) === true. Evidence stores the raw bytes so any
 * third party can re-verify without trusting us (scripts/verify-evidence.ts).
 * NO mocks, NO fallbacks; exhausted retries are a hard, recorded failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Chess } from "chess.js";
import { canonicalHash } from "../src/canonical.js";
import { NETWORKS } from "../src/config.js";
import {
  acknowledge,
  attestService,
  createBroker,
  ensureLedgerFunded,
  selectProvider,
  verifiedCompletion,
  type VerifiedCompletion,
} from "../src/compute.js";
import { CHESS_SYSTEM_PROMPT, buildMoveUserPrompt, parseMove } from "../src/chess-agent.js";
import { PROJECT_ROOT, loadPrivateKey } from "../src/keys.js";

const TARGET_PLIES = Number(process.env.TARGET_PLIES ?? 10);
const MAX_ATTEMPTS_PER_MOVE = 3;

const net = NETWORKS.testnet;
const key = loadPrivateKey();
const evidenceDir = resolve(PROJECT_ROOT, "evidence");
mkdirSync(resolve(evidenceDir, "attestation"), { recursive: true });

const startedAt = new Date().toISOString();
console.log(`[selfplay] ${net.displayName} — target ${TARGET_PLIES} attested plies`);

const broker = await createBroker(net, key);
const { selected: sel } = await selectProvider(broker, process.env.OG_PROVIDER);
console.log(`[selfplay] provider=${sel.provider}`);
console.log(`[selfplay] model=${sel.model} verifiability=${sel.verifiability}`);
console.log(`[selfplay] effectiveSigner=${sel.effectiveSigner}`);

// Ledger MUST exist before acknowledge — the SDK's signer check reverts with
// AccountNotExists otherwise (observed on-chain, 22 Aug 2026).
const deposit = process.env.OG_COMPUTE_DEPOSIT ? Number(process.env.OG_COMPUTE_DEPOSIT) : undefined;
const funding = await ensureLedgerFunded({ net, privateKey: key, depositOg: deposit });
console.log(
  `[selfplay] ledger: action=${funding.action} available=${funding.ledgerAvailableOg ?? "0"} OG ` +
    `(wallet ${funding.walletBalanceOg} OG)` + (funding.txHash ? ` tx=${funding.txHash}` : ""),
);

const ackTx = await acknowledge(broker, sel.provider);
console.log(`[selfplay] acknowledgeProviderSigner: ${ackTx ? "sent" : "already acknowledged"}`);

console.log("[selfplay] running TEE remote attestation (verifyService + getQuote)…");
const attestation = await attestService(broker, sel, resolve(evidenceDir, "attestation"));
console.log(
  `[selfplay] attestation OK — bound signer ${attestation.boundSigner}, quoteHash ${attestation.rawQuoteHash.slice(0, 18)}…`,
);

interface MoveEvidence {
  ply: number;
  side: "w" | "b";
  fenBefore: string;
  fenAfter: string;
  san: string;
  why: string;
  parseVia: string;
  illegalAttempts: number;
  chatID: string;
  signature: string;
  sigText: string;
  rawBody: string;
  rawBodySha256: string;
  requestBodyJson: string;
  requestHeaders: Record<string, string>;
  contentHash: string;
  recoveredSigner: string;
  receipt: {
    requestHash: string;
    responseHash: string;
    providerType: string;
    providerIdentity: string;
    tlsCertFingerprint: string;
    responseHashMatchesRawBody: boolean;
    requestHashSerialization: string;
  };
  receiptHash: string;
  latencyMs: number;
  usage: Record<string, unknown>;
}

const chess = new Chess();
const moves: MoveEvidence[] = [];

for (let ply = 1; ply <= TARGET_PLIES; ply++) {
  const fenBefore = chess.fen();
  const legal = chess.moves();
  if (legal.length === 0) break; // game over early (unlikely in 10 plies)
  const turn = chess.turn();

  let feedback: string | undefined;
  let done: { san: string; why: string; via: string; vc: VerifiedCompletion } | null = null;
  let illegalAttempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MOVE; attempt++) {
    const messages = [
      { role: "system", content: CHESS_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildMoveUserPrompt({
          fen: fenBefore,
          turn,
          fullmoveNumber: Math.ceil(ply / 2),
          legalSans: legal,
          recentHistory: chess.history().slice(-8),
          feedback,
        }),
      },
    ];
    const vc = await verifiedCompletion(broker, sel, messages, 0);
    const parsed = parseMove(vc.content, legal);
    if (parsed) {
      done = { san: parsed.san, why: parsed.why, via: parsed.via, vc };
      break;
    }
    illegalAttempts++;
    feedback =
      `Your previous reply was not a usable legal move (it began: ${vc.content.slice(0, 120)}). ` +
      `Reply with JSON only; "move" MUST be one of: ${legal.join(" ")}`;
    console.log(`[selfplay] ply ${ply} attempt ${attempt}: unparseable/illegal reply — retrying`);
  }

  if (!done) {
    const failure = {
      network: net.name, provider: sel.provider, model: sel.model,
      failedAtPly: ply, fen: fenBefore, illegalAttempts, startedAt,
      verdict: "Attested self-play FAIL — move quality: could not obtain a legal move in " + MAX_ATTEMPTS_PER_MOVE + " attempts",
    };
    writeFileSync(resolve(evidenceDir, "selfplay-evidence.json"), JSON.stringify({ failure, moves }, null, 2));
    console.error(`[selfplay] HARD FAIL at ply ${ply}: no legal move in ${MAX_ATTEMPTS_PER_MOVE} attempts.`);
    process.exit(1);
  }

  chess.move(done.san);
  // Commitment over the FULL signed receipt + the response-bytes hash it covers.
  // A verifier recomputes this from stored evidence and compares to the on-chain value.
  const receiptHash = canonicalHash({
    sigText: done.vc.signature.text,
    signature: done.vc.signature.signature,
    rawBodySha256: done.vc.rawBodySha256,
  });
  moves.push({
    ply,
    side: turn,
    fenBefore,
    fenAfter: chess.fen(),
    san: done.san,
    why: done.why,
    parseVia: done.via,
    illegalAttempts,
    chatID: done.vc.chatID,
    signature: done.vc.signature.signature,
    sigText: done.vc.signature.text,
    rawBody: done.vc.rawBody,
    rawBodySha256: done.vc.rawBodySha256,
    requestBodyJson: done.vc.requestBodyJson,
    requestHeaders: done.vc.requestHeaders,
    contentHash: canonicalHash(done.vc.content),
    recoveredSigner: done.vc.recoveredSigner,
    receipt: done.vc.receipt,
    receiptHash,
    latencyMs: done.vc.latencyMs,
    usage: done.vc.usage as Record<string, unknown>,
  });
  console.log(
    `[selfplay] ply ${ply} ${turn === "w" ? "W" : "B"} ${done.san.padEnd(7)} verified ✓ ` +
      `(sig ${done.vc.signature.signature.slice(0, 14)}…, ${done.vc.latencyMs}ms, retries ${illegalAttempts})`,
  );
}

const evidence = {
  leg: "A — per-move attested inference",
  network: net.name,
  chainId: net.chainId,
  provider: sel.provider,
  model: sel.model,
  verifiability: sel.verifiability,
  teeSignerAddress: sel.teeSignerAddress,
  effectiveSigner: sel.effectiveSigner,
  attestation,
  ledgerFunding: { action: funding.action, txHash: funding.txHash },
  startedAt,
  finishedAt: new Date().toISOString(),
  pgn: chess.pgn(),
  totalPlies: moves.length,
  totalIllegalAttempts: moves.reduce((a, m) => a + m.illegalAttempts, 0),
  moves,
};
writeFileSync(resolve(evidenceDir, "selfplay-evidence.json"), JSON.stringify(evidence, null, 2));

const pass = moves.length >= TARGET_PLIES;
console.log(`\n[selfplay] ${pass ? "PASS" : "FAIL"} — ${moves.length}/${TARGET_PLIES} attested plies, ` +
  `${evidence.totalIllegalAttempts} illegal attempts total`);
console.log(`[selfplay] PGN: ${chess.pgn()}`);
console.log(`[selfplay] evidence: evidence/selfplay-evidence.json`);
process.exit(pass ? 0 : 1);
