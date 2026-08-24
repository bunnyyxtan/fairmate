/**
 * FairMate evidence verifier — re-derives EVERY claim from raw material.
 * Trust nothing in the file that can be recomputed or fetched from the chain.
 *
 * Usage:
 *   pnpm run verify                       # verify the bundled evidence set
 *   pnpm run verify -- --file=path.json   # verify one downloaded game bundle
 *
 * For a game bundle it checks three layers:
 *   RECEIPTS  every model ply: signed text structure, sha256(rawBody) binding,
 *             ECDSA recovery to the attested TEE signer, receiptHash
 *             recomputation, AND that the signed response actually contains
 *             the SAN that was played (output binding) for the position in
 *             the signed request (input binding).
 *   CHESS     full SAN replay from the start position — every recorded FEN
 *             and hash must re-derive; the final position must match.
 *   CHAIN     every recorded tx hash is fetched from the RPC: status 1,
 *             addressed to the journal, and its event args must equal the
 *             locally recomputed values (fen hashes, san, mover, receiptHash,
 *             move numbers, result enum). Contract storage (getGame) must
 *             agree on moveCount / result / player.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Chess } from "chess.js";
import { ethers } from "ethers";
import { NETWORKS, EVIDENCE_DIR, PROJECT_ROOT, findFlag, type NetworkConfig } from "../src/config.js";
import { canonicalHash } from "../shared/canonical.js";
import { verifyReceiptBundle, type ReceiptBundleLike } from "../shared/receipt.js";
import {
  FAIRMATE_ROUTER_MODEL,
  FAIRMATE_ROUTER_PROVIDER,
} from "../shared/router-policy.js";
import { parseMove } from "../src/chess-agent.js";

let passCount = 0;
let failCount = 0;
function must(cond: boolean, label: string): void {
  if (cond) {
    passCount += 1;
    console.log(`  PASS ${label}`);
  } else {
    failCount += 1;
    console.log(`  FAIL ${label}`);
  }
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

let net: NetworkConfig = NETWORKS.mainnet;
let provider = new ethers.JsonRpcProvider(net.evmRpc, net.chainId);

function selectEvidenceNetwork(chainId: number): void {
  const found = Object.values(NETWORKS).find((candidate) => candidate.chainId === chainId);
  if (!found) throw new Error(`unsupported evidence chainId ${chainId}`);
  net = found;
  provider = new ethers.JsonRpcProvider(net.evmRpc, net.chainId);
}

interface BuildEntry {
  abi: ethers.InterfaceAbi;
}
const build = JSON.parse(
  readFileSync(resolve(PROJECT_ROOT, "build/FairMate.json"), "utf8"),
) as { MoveJournal: BuildEntry; ChallengePot: BuildEntry };
const journalIface = new ethers.Interface(build.MoveJournal.abi);
const potIface = new ethers.Interface(build.ChallengePot.abi);

const RESULT_ENUM: Record<string, number> = {
  ongoing: 0,
  player_win: 1,
  model_win: 2,
  draw: 3,
  aborted: 4,
};

interface PlyLike {
  ply: number;
  mover: "player" | "model";
  san: string;
  fenBefore: string;
  fenAfter: string;
  fenBeforeHash: string;
  fenAfterHash: string;
  receiptHash: string | null;
  receipt?: ReceiptBundleLike & {
    rawBody: string;
    requestBodyJson: string;
    receiptHash: string;
  };
  chain?: { status: string; txHash?: string };
}

interface GameEvidence {
  kind: string;
  chainId: number;
  journalAddress: string;
  potAddress: string;
  gameId: string;
  playerAddress: string | null;
  model: string;
  provider: string;
  effectiveSigner: string;
  verificationScheme?: "direct-teeml" | "router-teetls";
  result: string;
  startFen: string;
  finalFen: string;
  sans: string[];
  startTx?: { status: string; txHash?: string };
  endTx?: { status: string; txHash?: string } | null;
  awardTx?: { status: string; txHash?: string; amountOg?: string } | null;
  plies: PlyLike[];
}

async function txEvents(
  txHash: string,
  iface: ethers.Interface,
  expectedTo: string,
): Promise<{ ok: boolean; events: ethers.LogDescription[] }> {
  const rcpt = await provider.getTransactionReceipt(txHash);
  if (!rcpt || rcpt.status !== 1) return { ok: false, events: [] };
  if ((rcpt.to ?? "").toLowerCase() !== expectedTo.toLowerCase()) return { ok: false, events: [] };
  const events: ethers.LogDescription[] = [];
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== expectedTo.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) events.push(parsed);
    } catch {
      /* other contract's log */
    }
  }
  return { ok: true, events };
}

async function verifyGameEvidence(file: string): Promise<void> {
  const ev = JSON.parse(readFileSync(file, "utf8")) as GameEvidence;
  selectEvidenceNetwork(ev.chainId);
  section(`game evidence: ${file}`);
  must(
    ev.kind === "fairmate-game-evidence" || ev.kind === "fairmate-selfplay-evidence",
    `recognized evidence kind (${ev.kind})`,
  );
  const withChain = ev.kind === "fairmate-game-evidence";
  const productionRouter = ev.chainId === NETWORKS.mainnet.chainId;
  if (withChain) {
    must(ev.chainId === net.chainId, `evidence chainId ${ev.chainId} matches verifier network ${net.chainId}`);
  }
  if (productionRouter) {
    must(ev.verificationScheme === "router-teetls", "mainnet evidence uses the Router TeeTLS scheme");
    must(ev.model === FAIRMATE_ROUTER_MODEL, `mainnet model is pinned to ${FAIRMATE_ROUTER_MODEL}`);
    must(
      ev.provider.toLowerCase() === FAIRMATE_ROUTER_PROVIDER.toLowerCase(),
      `mainnet provider is pinned to ${FAIRMATE_ROUTER_PROVIDER}`,
    );
  }

  // ---- RECEIPTS -------------------------------------------------------------
  section("receipts (all exposed evidence recomputed locally)");
  const modelPlies = ev.plies.filter((p) => p.mover === "model");
  must(modelPlies.length > 0, `at least one model ply present (${modelPlies.length})`);
  for (const p of modelPlies) {
    const r = p.receipt;
    must(!!r, `ply ${p.ply}: receipt bundle present`);
    if (!r) continue;
    const metadata = r as ReceiptBundleLike & {
      scheme?: "direct-teeml" | "router-teetls";
      model?: string;
      provider?: string;
    };
    must(metadata.model === ev.model, `ply ${p.ply}: receipt model equals game model`);
    must(
      metadata.provider?.toLowerCase() === ev.provider.toLowerCase(),
      `ply ${p.ply}: receipt provider equals game provider`,
    );
    if (productionRouter) {
      must(metadata.scheme === "router-teetls", `ply ${p.ply}: receipt uses Router TeeTLS`);
      must(metadata.model === FAIRMATE_ROUTER_MODEL, `ply ${p.ply}: receipt model matches the FairMate pin`);
      must(
        metadata.provider?.toLowerCase() === FAIRMATE_ROUTER_PROVIDER.toLowerCase(),
        `ply ${p.ply}: receipt provider matches the FairMate pin`,
      );
    }
    const checks = verifyReceiptBundle(r);
    for (const c of checks) {
      must(c.pass, `ply ${p.ply}: ${c.name} — ${c.detail}`);
    }
    must(r.receiptHash === p.receiptHash, `ply ${p.ply}: receipt bundle commitment equals ply commitment`);
    // output binding: the signed response must decode to the SAN that was played
    try {
      const body = JSON.parse(r.rawBody) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content ?? "";
      const replay = new Chess(p.fenBefore);
      const parsed = parseMove(content, replay.moves());
      must(
        parsed !== null && parsed.san === p.san,
        `ply ${p.ply}: signed response content decodes to the played SAN (${p.san})`,
      );
    } catch {
      must(false, `ply ${p.ply}: rawBody parses as a completion response`);
    }
    // input binding: the signed request must be about the position before the move
    try {
      const req = JSON.parse(r.requestBodyJson) as { messages?: Array<{ role: string; content: string }> };
      const user = (req.messages ?? []).filter((m) => m.role === "user").pop();
      must(
        !!user && user.content.includes(`Position (FEN): ${p.fenBefore}`),
        `ply ${p.ply}: signed request contains the pre-move position (input binding)`,
      );
    } catch {
      must(false, `ply ${p.ply}: requestBodyJson parses`);
    }
  }

  // ---- CHESS ----------------------------------------------------------------
  section("chess replay");
  const chess = new Chess(ev.startFen);
  must(chess.fen() === ev.startFen, "start position loads");
  let replayOk = true;
  for (const p of ev.plies) {
    if (chess.fen() !== p.fenBefore) {
      must(false, `ply ${p.ply}: fenBefore matches replay (got ${chess.fen()})`);
      replayOk = false;
      break;
    }
    try {
      chess.move(p.san);
    } catch {
      must(false, `ply ${p.ply}: SAN ${p.san} is legal at its position`);
      replayOk = false;
      break;
    }
    if (chess.fen() !== p.fenAfter) {
      must(false, `ply ${p.ply}: fenAfter matches replay (got ${chess.fen()})`);
      replayOk = false;
      break;
    }
    must(
      canonicalHash(p.fenBefore) === p.fenBeforeHash && canonicalHash(p.fenAfter) === p.fenAfterHash,
      `ply ${p.ply}: fen hashes recompute`,
    );
  }
  if (replayOk) {
    must(true, `all ${ev.plies.length} SAN moves replay legally`);
    must(chess.fen() === ev.finalFen, "final position matches replay");
    must(
      JSON.stringify(ev.sans) === JSON.stringify(ev.plies.map((p) => p.san)),
      "sans list equals the ply sequence",
    );
  }

  // ---- CHAIN ----------------------------------------------------------------
  if (!withChain) return;
  section("on-chain cross-check (every recorded tx re-fetched from the RPC)");
  const journal = new ethers.Contract(ev.journalAddress, build.MoveJournal.abi, provider);

  const startHash = ev.startTx?.txHash;
  must(!!startHash, "startGame tx hash recorded");
  if (startHash) {
    const { ok, events } = await txEvents(startHash, journalIface, ev.journalAddress);
    const started = events.find((e) => e.name === "GameStarted");
    must(ok && !!started, "startGame tx succeeded on the journal contract");
    if (started) {
      must(started.args[0] === ev.gameId, "GameStarted.gameId matches");
      must(started.args[1] === canonicalHash(ev.startFen), "GameStarted.startFenHash recomputes from startFen");
      const evPlayer = (ev.playerAddress ?? ethers.ZeroAddress).toLowerCase();
      must((started.args[2] as string).toLowerCase() === evPlayer, "GameStarted.player is the recorded payout address");
      must(started.args[3] === ev.model, "GameStarted.model matches the evidence model");
      must((started.args[4] as string).toLowerCase() === ev.effectiveSigner.toLowerCase(), "GameStarted verification identity matches the evidence");
    }
  }

  for (const p of ev.plies) {
    const h = p.chain?.txHash;
    must(!!h && p.chain?.status === "confirmed", `ply ${p.ply}: commit tx recorded as confirmed`);
    if (!h) continue;
    const { ok, events } = await txEvents(h, journalIface, ev.journalAddress);
    const mc = events.find((e) => e.name === "MoveCommitted");
    must(ok && !!mc, `ply ${p.ply}: commit tx succeeded on the journal`);
    if (!mc) continue;
    must(mc.args[0] === ev.gameId, `ply ${p.ply}: event gameId matches`);
    must(Number(mc.args[1]) === p.ply, `ply ${p.ply}: on-chain moveNo equals ply number`);
    must(Number(mc.args[2]) === (p.mover === "model" ? 1 : 0), `ply ${p.ply}: on-chain mover byte matches (${p.mover})`);
    must(mc.args[3] === canonicalHash(p.fenBefore), `ply ${p.ply}: on-chain fenBeforeHash recomputes`);
    must(mc.args[4] === canonicalHash(p.fenAfter), `ply ${p.ply}: on-chain fenAfterHash recomputes`);
    must(mc.args[5] === p.san, `ply ${p.ply}: on-chain SAN matches`);
    const expectedReceipt = p.mover === "model" ? p.receiptHash : ethers.ZeroHash;
    must(mc.args[6] === expectedReceipt, `ply ${p.ply}: on-chain receiptHash equals ${p.mover === "model" ? "recomputed receipt commitment" : "zero (human move)"}`);
  }

  const endHash = ev.endTx?.txHash;
  must(!!endHash, "endGame tx hash recorded");
  if (endHash) {
    const { ok, events } = await txEvents(endHash, journalIface, ev.journalAddress);
    const ge = events.find((e) => e.name === "GameEnded");
    must(ok && !!ge, "endGame tx succeeded on the journal");
    if (ge) {
      must(ge.args[0] === ev.gameId, "GameEnded.gameId matches");
      must(Number(ge.args[1]) === RESULT_ENUM[ev.result], `GameEnded.result enum matches recorded result (${ev.result})`);
      must(ge.args[2] === canonicalHash(ev.finalFen), "GameEnded.finalFenHash recomputes from finalFen");
      must(Number(ge.args[3]) === ev.plies.length, "GameEnded.moveCount equals ply count");
    }
  }

  const g = (await journal.getGame(ev.gameId)) as {
    player: string;
    moveCount: bigint;
    result: bigint;
    exists: boolean;
  };
  must(g.exists, "journal storage: game exists");
  must(Number(g.moveCount) === ev.plies.length, `journal storage: moveCount ${Number(g.moveCount)} equals ply count (no hidden moves)`);
  must(Number(g.result) === RESULT_ENUM[ev.result], "journal storage: result matches");
  must(g.player.toLowerCase() === (ev.playerAddress ?? ethers.ZeroAddress).toLowerCase(), "journal storage: player matches");

  if (ev.awardTx?.txHash) {
    const { ok, events } = await txEvents(ev.awardTx.txHash, potIface, ev.potAddress);
    const wa = events.find((e) => e.name === "WinAwarded");
    must(ok && !!wa, "award tx succeeded on the pot");
    if (wa) {
      must(wa.args[0] === ev.gameId, "WinAwarded.gameId matches");
      must((wa.args[1] as string).toLowerCase() === (ev.playerAddress ?? "").toLowerCase(), "WinAwarded.winner is the journal-recorded player");
      if (ev.awardTx.amountOg) {
        must(ethers.formatEther(wa.args[2] as bigint) === ev.awardTx.amountOg, `WinAwarded.amount is ${ev.awardTx.amountOg} 0G`);
      }
    }
  }
}

async function verifyPotDrill(file: string): Promise<void> {
  section(`pot drill: ${file}`);
  const d = JSON.parse(readFileSync(file, "utf8")) as {
    chainId: number;
    drillJournal: string;
    drillPot: string;
    games: Record<string, string>;
    steps: Array<{ n: number; action: string; pass: boolean; txHash?: string }>;
    throwawayPlayers: { player: string };
  };
  selectEvidenceNetwork(d.chainId);
  must(d.steps.length > 0 && d.steps.every((s) => s.pass), `drill file reports ${d.steps.length}/${d.steps.length} steps passed`);
  const potCode = await provider.getCode(d.drillPot);
  const journalCode = await provider.getCode(d.drillJournal);
  must(potCode !== "0x" && journalCode !== "0x", "drill contracts exist on-chain");
  const pot = new ethers.Contract(d.drillPot, build.ChallengePot.abi, provider);
  must((await pot.journal()).toLowerCase() === d.drillJournal.toLowerCase(), "drill pot is bound to the drill journal (immutable)");
  must((await pot.rewarded(d.games.A_playerWin)) === true, "chain storage: winning drill game is marked rewarded");
  must((await pot.rewarded(d.games.B_modelWin)) === false, "chain storage: ModelWin drill game was never rewarded");
  const bal = BigInt(await provider.send("eth_getBalance", [d.drillPot, "latest"]));
  must(bal === 0n, "drill pot fully defunded after the drill");
  // the real award tx paid the throwaway player
  const awardStep = d.steps.find((s) => s.action.startsWith("award(") && s.txHash);
  must(!!awardStep, "drill includes a real award transaction");
  if (awardStep?.txHash) {
    const { ok, events } = await txEvents(awardStep.txHash, potIface, d.drillPot);
    const wa = events.find((e) => e.name === "WinAwarded");
    must(ok && !!wa, "award tx succeeded on the drill pot");
    if (wa) {
      must((wa.args[1] as string).toLowerCase() === d.throwawayPlayers.player.toLowerCase(), "WinAwarded.winner is the journal-recorded throwaway player");
    }
  }
}

interface RefundDrillEvidence {
  kind: string;
  chainId: number;
  site: string;
  potAddress: string;
  player: string;
  gameId: string;
  stakeTx: string;
  endTx: string;
  refundTx: string;
  steps: Array<{ n: number; action: string; pass: boolean; txHash?: string; block?: number }>;
  gameEvidence: GameEvidence & {
    endReason?: string;
    refundTx?: { status: string; txHash?: string; amountOg?: string } | null;
    stake?: { from: string; txHash: string; amountOg: string } | null;
  };
}

/**
 * Refund drill: a real staked game on the production site that ended draw/aborted.
 * Re-derives the whole money path from the chain: exact stake in (Funded), payout
 * address bound at game start (GameStarted), refundable result anchored (GameEnded
 * + journal storage), exact stake back out (Defunded), in that block order.
 */
async function verifyRefundDrill(file: string): Promise<void> {
  section(`refund drill: ${file}`);
  const d = JSON.parse(readFileSync(file, "utf8")) as RefundDrillEvidence;
  selectEvidenceNetwork(d.chainId);
  must(d.kind === "fairmate-refund-drill", `recognized evidence kind (${d.kind})`);
  must(d.chainId === net.chainId, `evidence chainId ${d.chainId} matches verifier network ${net.chainId}`);
  must(d.steps.length > 0 && d.steps.every((s) => s.pass), `drill file reports ${d.steps.length}/${d.steps.length} steps passed`);

  const ge = d.gameEvidence;
  must(ge.kind === "fairmate-game-evidence", "embedded game evidence has the standard kind");
  must(ge.gameId === d.gameId, "embedded game evidence is for the drill game");
  must(ge.result === "draw" || ge.result === "aborted", `game result is refundable (${ge.result})`);
  must((ge.playerAddress ?? "").toLowerCase() === d.player.toLowerCase(), "embedded payout address is the drill player");
  must(ge.stake?.txHash === d.stakeTx, "embedded stake record matches the drill stake tx");
  must(
    ge.refundTx?.status === "confirmed" && ge.refundTx.txHash === d.refundTx,
    "embedded evidence records the refund as confirmed with the drill tx hash",
  );
  must(ge.potAddress.toLowerCase() === d.potAddress.toLowerCase(), "embedded pot address matches the drill pot");

  const pot = new ethers.Contract(d.potAddress, build.ChallengePot.abi, provider);
  must(
    ((await pot.journal()) as string).toLowerCase() === ge.journalAddress.toLowerCase(),
    "pot is immutably bound to the journal in the evidence",
  );

  // ---- stake in: player -> pot, exact value, Funded event ------------------
  const stakeTx = await provider.getTransaction(d.stakeTx);
  const stakeRcpt = await provider.getTransactionReceipt(d.stakeTx);
  const stakeWei = stakeTx?.value ?? 0n;
  must(
    !!stakeTx && !!stakeRcpt && stakeRcpt.status === 1 &&
      stakeTx.from.toLowerCase() === d.player.toLowerCase() &&
      (stakeTx.to ?? "").toLowerCase() === d.potAddress.toLowerCase() &&
      stakeWei > 0n,
    `stake tx mined: player sent ${ethers.formatEther(stakeWei)} 0G to the pot`,
  );
  must(ge.stake?.amountOg === ethers.formatEther(stakeWei), `recorded stake amount recomputes (${ge.stake?.amountOg} 0G)`);
  {
    const { ok, events } = await txEvents(d.stakeTx, potIface, d.potAddress);
    const funded = events.find((e) => e.name === "Funded");
    must(
      ok && !!funded &&
        (funded.args[0] as string).toLowerCase() === d.player.toLowerCase() &&
        (funded.args[1] as bigint) === stakeWei,
      "Funded event binds the exact stake to the player",
    );
  }

  // ---- journal: payout address bound at start, refundable result anchored --
  const startHash = ge.startTx?.txHash;
  must(!!startHash, "startGame tx hash recorded");
  if (startHash) {
    const { ok, events } = await txEvents(startHash, journalIface, ge.journalAddress);
    const started = events.find((e) => e.name === "GameStarted");
    must(
      ok && !!started && started.args[0] === d.gameId &&
        (started.args[2] as string).toLowerCase() === d.player.toLowerCase(),
      "GameStarted binds the drill game to the player payout address",
    );
  }
  {
    const { ok, events } = await txEvents(d.endTx, journalIface, ge.journalAddress);
    const ended = events.find((e) => e.name === "GameEnded");
    must(
      ok && !!ended && ended.args[0] === d.gameId &&
        Number(ended.args[1]) === RESULT_ENUM[ge.result] &&
        ended.args[2] === canonicalHash(ge.finalFen) &&
        Number(ended.args[3]) === ge.plies.length,
      `GameEnded anchors the ${ge.result} result on the journal`,
    );
  }
  const journal = new ethers.Contract(ge.journalAddress, build.MoveJournal.abi, provider);
  const g = (await journal.getGame(d.gameId)) as { player: string; moveCount: bigint; result: bigint; exists: boolean };
  must(
    g.exists && Number(g.result) === RESULT_ENUM[ge.result] && g.player.toLowerCase() === d.player.toLowerCase(),
    "journal storage agrees: refundable result for the recorded player",
  );

  // ---- refund out: Defunded returns the exact stake to the player ----------
  const refundRcpt = await provider.getTransactionReceipt(d.refundTx);
  {
    const { ok, events } = await txEvents(d.refundTx, potIface, d.potAddress);
    const def = events.find((e) => e.name === "Defunded");
    must(ok && !!def, "refund tx succeeded on the pot");
    if (def) {
      must((def.args[0] as string).toLowerCase() === d.player.toLowerCase(), "Defunded.to is the player wallet");
      must((def.args[1] as bigint) === stakeWei, `Defunded.amount equals the stake to the wei (${ethers.formatEther(stakeWei)} 0G)`);
      must(ge.refundTx?.amountOg === ethers.formatEther(def.args[1] as bigint), "recorded refund amount recomputes");
    }
  }

  // ---- order: stake -> admission -> end anchor -> refund --------------------
  const startRcpt = startHash ? await provider.getTransactionReceipt(startHash) : null;
  const endRcpt = await provider.getTransactionReceipt(d.endTx);
  must(
    !!stakeRcpt && !!startRcpt && !!endRcpt && !!refundRcpt &&
      stakeRcpt.blockNumber <= startRcpt.blockNumber &&
      startRcpt.blockNumber <= endRcpt.blockNumber &&
      endRcpt.blockNumber <= refundRcpt.blockNumber,
    "block order: stake, admission, abort anchor, refund",
  );
}

async function verifyDeployment(file: string): Promise<void> {
  section(`deployment: ${file}`);
  const d = JSON.parse(readFileSync(file, "utf8")) as {
    chainId: number;
    journalAddress: string;
    potAddress: string;
    deployer: string;
  };
  selectEvidenceNetwork(d.chainId);
  must(d.chainId === net.chainId, "deployment chainId matches verifier network");
  must((await provider.getCode(d.journalAddress)) !== "0x", `journal ${d.journalAddress} exists on-chain`);
  must((await provider.getCode(d.potAddress)) !== "0x", `pot ${d.potAddress} exists on-chain`);
  const pot = new ethers.Contract(d.potAddress, build.ChallengePot.abi, provider);
  const journal = new ethers.Contract(d.journalAddress, build.MoveJournal.abi, provider);
  must((await pot.journal()).toLowerCase() === d.journalAddress.toLowerCase(), "pot.journal() is the deployed journal (award binding is immutable)");
  must((await pot.owner()).toLowerCase() === d.deployer.toLowerCase(), "pot.owner() is the recorded deployer");
  must((await journal.referee()).toLowerCase() === d.deployer.toLowerCase(), "journal.referee() is the recorded deployer");
  const perWin = (await pot.perWinBounty()) as bigint;
  console.log(`  INFO current pot config: perWinBounty ${ethers.formatEther(perWin)} 0G, balance ${ethers.formatEther(BigInt(await provider.send("eth_getBalance", [d.potAddress, "latest"])))} 0G`);
}

async function main() {
  const fileArg = findFlag(process.argv, "file");

  if (fileArg) {
    const file = resolve(fileArg);
    const header = JSON.parse(readFileSync(file, "utf8")) as { chainId?: number; kind?: string };
    if (typeof header.chainId === "number") selectEvidenceNetwork(header.chainId);
    console.log(`FairMate evidence verifier — network ${net.displayName} (${net.evmRpc})`);
    if (header.kind === "fairmate-refund-drill") await verifyRefundDrill(file);
    else await verifyGameEvidence(file);
  } else {
    const requested = findFlag(process.argv, "network") ?? "mainnet";
    if (requested !== "mainnet" && requested !== "testnet") {
      throw new Error(`invalid --network=${requested}; expected mainnet|testnet`);
    }
    selectEvidenceNetwork(NETWORKS[requested].chainId);
    console.log(`FairMate evidence verifier — network ${net.displayName} (${net.evmRpc})`);
    const deployment = resolve(EVIDENCE_DIR, `deployment.${net.name}.json`);
    const sample = resolve(EVIDENCE_DIR, `sample-game.${net.name}.json`);
    const drill = resolve(EVIDENCE_DIR, `pot-drill.${net.name}.json`);
    const refundDrill = resolve(EVIDENCE_DIR, `refund-drill.${net.name}.json`);
    if (existsSync(deployment)) await verifyDeployment(deployment);
    if (existsSync(sample)) await verifyGameEvidence(sample);
    if (existsSync(drill)) await verifyPotDrill(drill);
    if (existsSync(refundDrill)) await verifyRefundDrill(refundDrill);
    if (!existsSync(deployment) && !existsSync(sample) && !existsSync(drill) && !existsSync(refundDrill)) {
      console.error("no evidence files found and no --file given");
      process.exit(2);
    }
  }

  console.log(`\n${passCount + failCount} checks: ${passCount} passed, ${failCount} failed`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
