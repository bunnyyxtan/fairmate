/**
 * Payout demo — real value transfer.
 * Deploy ChallengePot on Galileo, fund it, configure a per-win bounty, award
 * a win to a fresh winner wallet, and verify the winner's balance delta.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { canonicalHash } from "../src/canonical.js";
import { NETWORKS } from "../src/config.js";
import { PROJECT_ROOT, loadPrivateKey } from "../src/keys.js";

const POT_FUND_OG = process.env.POT_FUND_OG ?? "0.02";
const BOUNTY_OG = process.env.BOUNTY_OG ?? "0.005";

const net = NETWORKS.testnet;
const key = loadPrivateKey();
const provider = new ethers.JsonRpcProvider(net.evmRpc);
const wallet = new ethers.Wallet(key, provider);
// direct read — bypasses ethers' identical-call coalescing cache (~250ms)
const rawBalance = async (a: string): Promise<bigint> =>
  BigInt(await provider.send("eth_getBalance", [a, "latest"]));

const build = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "build", "FairMate.json"), "utf8")) as {
  ChallengePot: { abi: ethers.InterfaceAbi; bytecode: string };
};

console.log(`[payout] deploying ChallengePot to ${net.displayName}…`);
const factory = new ethers.ContractFactory(build.ChallengePot.abi, build.ChallengePot.bytecode, wallet);
const pot = await factory.deploy(wallet.address); // referee = this wallet (documented MVP trust model)
await pot.waitForDeployment();
const potAddress = await pot.getAddress();
console.log(`[payout] ChallengePot: ${potAddress}`);
console.log(`[payout] deploy tx: ${net.explorer}/tx/${pot.deploymentTransaction()?.hash}`);

const c = pot as unknown as ethers.Contract;

const fundTx = await wallet.sendTransaction({ to: potAddress, value: ethers.parseEther(POT_FUND_OG) });
const fundRcpt = await fundTx.wait();
console.log(`[payout] funded ${POT_FUND_OG} OG: ${net.explorer}/tx/${fundRcpt?.hash}`);

const cfgTx = await c.configureBounty(ethers.parseEther(BOUNTY_OG), ethers.parseEther(BOUNTY_OG) * 4n);
const cfgRcpt = await cfgTx.wait();
console.log(`[payout] bounty ${BOUNTY_OG} OG/win (daily cap x4): ${net.explorer}/tx/${cfgRcpt?.hash}`);

// fresh winner wallet — proves an arbitrary external address gets paid
const winner = ethers.Wallet.createRandom();
const before = await rawBalance(winner.address);

const gameId = canonicalHash({ purpose: "fairmate payout demo", at: new Date().toISOString() });
const awardTx = await c.awardWin(gameId, winner.address);
const awardRcpt = await awardTx.wait();
console.log(`[payout] awardWin tx: ${net.explorer}/tx/${awardRcpt?.hash}`);

const after = await rawBalance(winner.address);
const delta = after - before;
console.log(`[payout] winner ${winner.address} balance delta: ${ethers.formatEther(delta)} OG`);

// double-award must revert
let doubleAwardReverted = false;
try {
  const t = await c.awardWin(gameId, winner.address);
  await t.wait();
} catch {
  doubleAwardReverted = true;
}
console.log(`[payout] double-award reverted: ${doubleAwardReverted}`);

const pass = delta === ethers.parseEther(BOUNTY_OG) && doubleAwardReverted;
const evidence = {
  leg: "C — real value transfer",
  network: net.name,
  chainId: net.chainId,
  potAddress,
  potExplorer: `${net.explorer}/address/${potAddress}`,
  deployTx: pot.deploymentTransaction()?.hash,
  fundTx: fundRcpt?.hash,
  configureTx: cfgRcpt?.hash,
  awardTx: awardRcpt?.hash,
  winner: winner.address,
  winnerBalanceDeltaOg: ethers.formatEther(delta),
  doubleAwardReverted,
  pass,
  finishedAt: new Date().toISOString(),
};
writeFileSync(
  resolve(PROJECT_ROOT, "evidence", "payout-evidence.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(`\n[payout] ${pass ? "PASS" : "FAIL"} — payout ${evidence.winnerBalanceDeltaOg} OG to ${winner.address}`);
process.exit(pass ? 0 : 1);
