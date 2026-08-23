/**
 * Deploy the product contracts to 0G Chain and record the deployment:
 *   MoveJournal  — per-game board-state + receipt-hash journal (referee-written)
 *   ChallengePot — journal-bound, permissionless-award challenge pot
 *
 * Usage:
 *   pnpm run deploy -- --network=mainnet [--bounty=0.1 --cap=0.3 --fund=3]
 *
 * Writes evidence/deployment.<network>.json which the referee
 * server reads at boot.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { EVIDENCE_DIR, PROJECT_ROOT, findFlag, resolveNetwork } from "../src/config.js";
import { loadPrivateKey } from "../src/keys.js";

const net = resolveNetwork(process.argv, process.env);
const provider = new ethers.JsonRpcProvider(net.evmRpc, net.chainId);
const wallet = new ethers.Wallet(loadPrivateKey(), provider);

const bountyOg = findFlag(process.argv, "bounty") ?? (net.name === "mainnet" ? "0.1" : "0.004");
const capOg = findFlag(process.argv, "cap") ?? (net.name === "mainnet" ? "0.3" : "0.012");
const fundOg = findFlag(process.argv, "fund") ?? (net.name === "mainnet" ? "3" : "0.02");

interface BuildEntry {
  abi: ethers.InterfaceAbi;
  bytecode: string;
}

const build = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "build/FairMate.json"), "utf8")) as {
  MoveJournal: BuildEntry;
  ChallengePot: BuildEntry;
};

async function main() {
  console.log(`network : ${net.displayName} (chainId ${net.chainId})`);
  console.log(`deployer: ${wallet.address}`);

  const journalFactory = new ethers.ContractFactory(
    build.MoveJournal.abi,
    build.MoveJournal.bytecode,
    wallet,
  );
  const journal = await journalFactory.deploy();
  const journalDeployTx = journal.deploymentTransaction();
  await journal.waitForDeployment();
  const journalAddress = await journal.getAddress();
  console.log(`MoveJournal : ${journalAddress}`);

  const potFactory = new ethers.ContractFactory(
    build.ChallengePot.abi,
    build.ChallengePot.bytecode,
    wallet,
  );
  const pot = await potFactory.deploy(journalAddress);
  const potDeployTx = pot.deploymentTransaction();
  await pot.waitForDeployment();
  const potAddress = await pot.getAddress();
  console.log(`ChallengePot: ${potAddress}`);

  const potContract = new ethers.Contract(potAddress, build.ChallengePot.abi, wallet);
  const cfgTx = await potContract.configureBounty(
    ethers.parseEther(bountyOg),
    ethers.parseEther(capOg),
  );
  const cfgRcpt = await cfgTx.wait();
  console.log(`configureBounty(${bountyOg} OG per win, ${capOg} OG daily cap): ${cfgTx.hash}`);

  const fundTx = await wallet.sendTransaction({
    to: potAddress,
    value: ethers.parseEther(fundOg),
  });
  const fundRcpt = await fundTx.wait();
  console.log(`funded pot with ${fundOg} OG: ${fundTx.hash}`);

  const potBalance = BigInt(await provider.send("eth_getBalance", [potAddress, "latest"]));
  console.log(`pot balance: ${ethers.formatEther(potBalance)} OG`);

  const out = {
    kind: "fairmate-deployment",
    network: net.displayName,
    chainId: net.chainId,
    rpc: net.evmRpc,
    explorer: net.explorer,
    deployer: wallet.address,
    journalAddress,
    potAddress,
    config: { perWinBountyOg: bountyOg, dailyCapOg: capOg, fundedOg: fundOg },
    txs: {
      journalDeploy: journalDeployTx?.hash ?? null,
      potDeploy: potDeployTx?.hash ?? null,
      configureBounty: { hash: cfgTx.hash, block: cfgRcpt?.blockNumber ?? null },
      fund: { hash: fundTx.hash, block: fundRcpt?.blockNumber ?? null },
    },
    potBalanceOg: ethers.formatEther(potBalance),
    deployedAt: new Date().toISOString(),
  };
  const outPath = resolve(EVIDENCE_DIR, `deployment.${net.name}.json`);
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
