/**
 * Independent evidence verifier.
 *
 * Re-derives every claim in selfplay + anchoring evidence from raw bytes + public chain
 * state, WITHOUT trusting the process that wrote the files. Anyone with this
 * repo and an RPC endpoint can run it:  npx tsx scripts/verify-evidence.ts
 *
 * Verified:   receipt signature -> attested TEE signer; signed responseHash ->
 *             exact raw response bytes; response content -> unambiguous SAN;
 *             legal game replay from the start position; on-chain journal
 *             entries -> recomputed receipt commitments.
 * NOT claimed: request-side provenance beyond our signed billing headers
 *             (provider requestHash is not client-recomputable), model intent.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Chess } from "chess.js";
import { ethers } from "ethers";
import { canonicalHash } from "../src/canonical.js";
import { parseMove } from "../src/chess-agent.js";
import { NETWORKS } from "../src/config.js";
import { PROJECT_ROOT } from "../src/keys.js";

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface EvMove {
  ply: number;
  fenBefore: string;
  fenAfter: string;
  san: string;
  signature: string;
  sigText: string;
  rawBody: string;
  rawBodySha256: string;
  receiptHash: string;
  receipt: { requestHash: string; responseHash: string };
}
interface LegA {
  effectiveSigner: string;
  model: string;
  provider: string;
  attestation: Record<string, unknown>;
  moves: EvMove[];
}

let checks = 0;
let failures = 0;
function must(cond: boolean, label: string): void {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const legA = JSON.parse(
  readFileSync(resolve(PROJECT_ROOT, "evidence", "selfplay-evidence.json"), "utf8"),
) as LegA;
console.log(`[verify] ${legA.moves.length} moves; claimed TEE signer ${legA.effectiveSigner}`);

// Layer 0 — attestation linkage
const att = legA.attestation ?? {};
must(
  String(att.boundSigner ?? "").toLowerCase() === legA.effectiveSigner.toLowerCase(),
  "attestation.boundSigner == effectiveSigner",
);

// Layer 1 — receipts against raw bytes
for (const m of legA.moves) {
  const parts = m.sigText.split(":");
  must(parts.length === 5, `ply ${m.ply}: signed text has 5 fields`);
  must(parts[1] === sha256hex(m.rawBody), `ply ${m.ply}: signed responseHash == sha256(rawBody)`);
  must(sha256hex(m.rawBody) === m.rawBodySha256, `ply ${m.ply}: stored rawBodySha256 correct`);
  must(
    parts[0] === m.receipt.requestHash && parts[1] === m.receipt.responseHash,
    `ply ${m.ply}: stored receipt fields match signed text`,
  );
  let recovered = "";
  try {
    recovered = ethers.verifyMessage(m.sigText, m.signature);
  } catch {
    /* leave empty -> fails below */
  }
  must(
    recovered.toLowerCase() === legA.effectiveSigner.toLowerCase(),
    `ply ${m.ply}: ECDSA recovers to attested signer`,
  );
  must(
    canonicalHash({ sigText: m.sigText, signature: m.signature, rawBodySha256: m.rawBodySha256 }) ===
      m.receiptHash,
    `ply ${m.ply}: receiptHash recomputes from receipt parts`,
  );
  const body = JSON.parse(m.rawBody) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content ?? "";
  const legal = new Chess(m.fenBefore).moves();
  const parsed = parseMove(content, legal);
  must(parsed?.san === m.san, `ply ${m.ply}: response content unambiguously chooses ${m.san}`);
}

// Layer 2 — legal game replay from the standard start position
const chess = new Chess();
for (const m of legA.moves) {
  must(chess.fen() === m.fenBefore, `ply ${m.ply}: fenBefore continues the game`);
  try {
    chess.move(m.san);
  } catch {
    must(false, `ply ${m.ply}: SAN ${m.san} is legal at fenBefore`);
  }
  must(chess.fen() === m.fenAfter, `ply ${m.ply}: fenAfter matches independent replay`);
}

// Layer 3 — on-chain journal matches recomputed commitments
const legBPath = resolve(PROJECT_ROOT, "evidence", "anchor-evidence.json");
if (existsSync(legBPath)) {
  const legB = JSON.parse(readFileSync(legBPath, "utf8")) as { journalAddress: string; gameId: string };
  const net = NETWORKS.testnet;
  const rpc = new ethers.JsonRpcProvider(net.evmRpc);
  const journal = new ethers.Contract(
    legB.journalAddress,
    [
      "function moveCount(bytes32) view returns (uint32)",
      "function games(bytes32) view returns (bytes32 startFenHash, address player, uint64 startedAt, uint32 moveCount, bool exists)",
      "event MoveCommitted(bytes32 indexed gameId, uint32 indexed moveNo, bytes32 fenBeforeHash, bytes32 fenAfterHash, string san, bytes32 receiptHash)",
    ],
    rpc,
  );
  const game = await journal.games(legB.gameId);
  must(Boolean(game.exists), "on-chain game exists");
  must(game.startFenHash === canonicalHash(legA.moves[0].fenBefore), "on-chain startFenHash matches");
  must(Number(await journal.moveCount(legB.gameId)) === legA.moves.length, "on-chain moveCount matches");
  const events = (await journal.queryFilter(journal.filters.MoveCommitted(legB.gameId), 0, "latest")).filter(
    (e): e is ethers.EventLog => "args" in e,
  );
  must(events.length === legA.moves.length, "on-chain MoveCommitted event count matches");
  for (const m of legA.moves) {
    const ev = events.find((e) => Number(e.args[1]) === m.ply);
    must(ev !== undefined, `ply ${m.ply}: MoveCommitted event found on chain`);
    if (!ev) continue;
    must(ev.args[4] === m.san, `ply ${m.ply}: on-chain SAN matches`);
    must(
      ev.args[2] === canonicalHash(m.fenBefore) && ev.args[3] === canonicalHash(m.fenAfter),
      `ply ${m.ply}: on-chain FEN hashes match`,
    );
    must(ev.args[5] === m.receiptHash, `ply ${m.ply}: on-chain receiptHash == recomputed commitment`);
  }
} else {
  console.log("[verify] anchor-evidence.json not found — on-chain layer skipped");
}

console.log(`\n[verify] ${checks} checks, ${failures} failures`);
if (failures === 0) {
  console.log(
    "VERIFIED: TEE-signed receipts cover the exact response bytes; signatures recover to the attested signer; " +
      "each response unambiguously chose its move; the game replays legally from the start position; " +
      "on-chain journal commitments match hashes recomputed from raw evidence.",
  );
  console.log(
    "NOT CLAIMED: request-side provenance beyond our signed billing headers (provider requestHash is not " +
      "client-recomputable), and nothing about model intent or strength.",
  );
}
process.exit(failures === 0 ? 0 : 1);
