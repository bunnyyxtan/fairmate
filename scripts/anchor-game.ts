/**
 * Chain anchoring — commit every move of a played game on-chain.
 * Deploy MoveJournal on Galileo, start a game, commit every move from the
 * selfplay evidence (board hash before/after + SAN + TEE receipt hash), then
 * read the journal back from chain and print explorer links.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { canonicalHash } from "../src/canonical.js";
import { NETWORKS } from "../src/config.js";
import { PROJECT_ROOT, loadPrivateKey } from "../src/keys.js";

const net = NETWORKS.testnet;
const key = loadPrivateKey();
const provider = new ethers.JsonRpcProvider(net.evmRpc);
const wallet = new ethers.Wallet(key, provider);

const build = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "build", "FairMate.json"), "utf8")) as {
  MoveJournal: { abi: ethers.InterfaceAbi; bytecode: string };
};
const legA = JSON.parse(
  readFileSync(resolve(PROJECT_ROOT, "evidence", "selfplay-evidence.json"), "utf8"),
) as {
  model: string;
  effectiveSigner: string;
  moves: Array<{ ply: number; fenBefore: string; fenAfter: string; san: string; receiptHash: string }>;
};
if (!legA.moves?.length) throw new Error("anchor: no moves in selfplay evidence — run selfplay first");

console.log(`[anchor] deploying MoveJournal to ${net.displayName}…`);
const factory = new ethers.ContractFactory(build.MoveJournal.abi, build.MoveJournal.bytecode, wallet);
const journal = await factory.deploy();
await journal.waitForDeployment();
const journalAddress = await journal.getAddress();
const deployTx = journal.deploymentTransaction();
console.log(`[anchor] MoveJournal: ${journalAddress}`);
console.log(`[anchor] deploy tx: ${net.explorer}/tx/${deployTx?.hash}`);

const gameId = canonicalHash({ startedAt: new Date().toISOString(), purpose: "fairmate demo game" });
const startFenHash = canonicalHash(legA.moves[0].fenBefore);

const c = journal as unknown as ethers.Contract;
const startTx = await c.startGame(gameId, startFenHash, wallet.address, legA.model, legA.effectiveSigner);
const startRcpt = await startTx.wait();
console.log(`[anchor] startGame tx: ${net.explorer}/tx/${startRcpt?.hash}`);

const commitTxs: Array<{ ply: number; san: string; tx: string }> = [];
for (const m of legA.moves) {
  const tx = await c.commitMove(
    gameId,
    canonicalHash(m.fenBefore),
    canonicalHash(m.fenAfter),
    m.san,
    m.receiptHash,
  );
  const rcpt = await tx.wait();
  commitTxs.push({ ply: m.ply, san: m.san, tx: rcpt?.hash ?? tx.hash });
  console.log(`[anchor] ply ${m.ply} ${m.san.padEnd(7)} committed: ${net.explorer}/tx/${rcpt?.hash}`);
}

// read back from chain — confirmable, not fire-and-forget
const count: bigint = await c.moveCount(gameId);
const events = await c.queryFilter(c.filters.MoveCommitted(gameId), 0, "latest");
console.log(`[anchor] on-chain moveCount=${count} events=${events.length}`);
if (Number(count) !== legA.moves.length || events.length !== legA.moves.length) {
  console.error("[anchor] FAIL — on-chain journal does not match committed moves");
  process.exit(1);
}

const evidence = {
  leg: "B — per-move chain anchoring",
  network: net.name,
  chainId: net.chainId,
  journalAddress,
  journalExplorer: `${net.explorer}/address/${journalAddress}`,
  deployTx: deployTx?.hash,
  gameId,
  startTx: startRcpt?.hash,
  commitTxs,
  onChainMoveCount: Number(count),
  finishedAt: new Date().toISOString(),
};
writeFileSync(
  resolve(PROJECT_ROOT, "evidence", "anchor-evidence.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(`\n[anchor] PASS — ${count} moves anchored, journal ${evidence.journalExplorer}`);
