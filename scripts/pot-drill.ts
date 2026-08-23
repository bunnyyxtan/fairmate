/**
 * ChallengePot binding drill — LIVE on 0G Chain, against a dedicated
 * drill journal + drill pot (the product deployment stays clean of
 * synthetic fixtures).
 *
 * Proves, with real transactions and live reverts, that the pot is bound to
 * the journal:
 *   1. journal-recorded PlayerWin  -> award() pays the recorded player (real tx)
 *   2. second award(same game)     -> AlreadyRewarded
 *   3. ModelWin game               -> NotPlayerWin
 *   4. PlayerWin, player=0x0       -> NoPlayerRecorded
 *   5. PlayerWin beyond daily cap  -> DailyCapExceeded (cap really consumed by #1)
 *   6. ongoing game                -> GameNotEnded
 *   7. unknown gameId              -> NoSuchGame
 *   8. commitMove after endGame    -> GameAlreadyEnded
 *   9. model move w/o receiptHash  -> ModelMoveNeedsReceipt
 *  10. startGame from stranger     -> NotReferee
 *  11. owner defund reclaims leftover (real tx)
 *
 * Positive paths are real transactions; negative paths are proven by
 * eth_call (staticCall) at a recorded block — no gas theatre, and crucially
 * the drill NEVER fabricates a fake TEE receipt hash for a model move.
 *
 * All drill games are synthetic owner-marked fixtures: 1 ply (mover=player),
 * then endGame with the scenario's result. Payout goes to a fresh throwaway
 * address so the transfer is visible as an external credit.
 *
 * Usage: pnpm run drill        (writes evidence/pot-drill.json)
 */
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { EVIDENCE_DIR, PROJECT_ROOT, resolveNetwork } from "../src/config.js";
import { loadPrivateKey } from "../src/keys.js";
import { canonicalHash } from "../shared/canonical.js";

const net = resolveNetwork(process.argv, process.env);
const provider = new ethers.JsonRpcProvider(net.evmRpc, net.chainId);
const wallet = new ethers.Wallet(loadPrivateKey(), provider);

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FEN_AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPPPPPP/RNBQKBNR b KQkq e3 0 1";
const RESULT = { Ongoing: 0, PlayerWin: 1, ModelWin: 2, Draw: 3, Aborted: 4 } as const;

interface BuildEntry {
  abi: ethers.InterfaceAbi;
  bytecode: string;
}
const build = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "build/FairMate.json"), "utf8")) as {
  MoveJournal: BuildEntry;
  ChallengePot: BuildEntry;
};

interface Step {
  n: number;
  action: string;
  kind: "tx" | "staticcall" | "observation";
  txHash?: string;
  block?: number;
  revert?: string;
  expected: string;
  observed: string;
  pass: boolean;
}
const steps: Step[] = [];
let n = 0;
function record(s: Omit<Step, "n">) {
  n += 1;
  steps.push({ n, ...s });
  console.log(`${s.pass ? "PASS" : "FAIL"} ${String(n).padStart(2)}  ${s.action} — ${s.observed}`);
}

const rawBalance = async (a: string) =>
  BigInt(await provider.send("eth_getBalance", [a, "latest"]));

async function waitForReceipt(
  tx: ethers.TransactionResponse,
  label: string,
): Promise<ethers.TransactionReceipt> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt) {
        if (receipt.status !== 1) throw new Error(`${label} reverted: ${tx.hash}`);
        return receipt;
      }
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("no matching receipts found")) throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(
    `${label} receipt was not indexed after 30 seconds (${tx.hash}): ${String(lastError ?? "not found")}`,
  );
}

function revertName(iface: ethers.Interface, err: unknown): string {
  const e = err as { data?: string; info?: { error?: { data?: string } }; revert?: { name?: string } };
  if (e.revert?.name) return e.revert.name;
  const data = e.data ?? e.info?.error?.data;
  if (typeof data === "string") {
    try {
      const parsed = iface.parseError(data);
      if (parsed) return parsed.name;
    } catch {
      /* fallthrough */
    }
  }
  return `unrecognized (${String(err).slice(0, 120)})`;
}

async function expectRevert(
  action: string,
  iface: ethers.Interface,
  expected: string,
  fn: () => Promise<unknown>,
) {
  const block = await provider.getBlockNumber();
  try {
    await fn();
    record({ action, kind: "staticcall", block, expected: `revert ${expected}`, observed: "call succeeded (no revert)", pass: false });
  } catch (err) {
    const name = revertName(iface, err);
    record({
      action,
      kind: "staticcall",
      block,
      revert: name,
      expected: `revert ${expected}`,
      observed: `reverted with ${name}`,
      pass: name === expected,
    });
  }
}

function gid(tag: string): string {
  return canonicalHash({ drill: tag, at: Date.now(), rand: Math.random().toString(36) });
}

async function main() {
  console.log(`network : ${net.displayName} (chainId ${net.chainId})`);
  console.log(`referee : ${wallet.address}`);

  // fresh throwaway payout target (key intentionally discarded after the run)
  const player = ethers.Wallet.createRandom().address;
  const player2 = ethers.Wallet.createRandom().address;

  // -- deploy drill pair ------------------------------------------------------
  const journal = await (async () => {
    const f = new ethers.ContractFactory(build.MoveJournal.abi, build.MoveJournal.bytecode, wallet);
    const c = await f.deploy();
    await c.waitForDeployment();
    return new ethers.Contract(await c.getAddress(), build.MoveJournal.abi, wallet);
  })();
  const pot = await (async () => {
    const f = new ethers.ContractFactory(build.ChallengePot.abi, build.ChallengePot.bytecode, wallet);
    const c = await f.deploy(await journal.getAddress());
    await c.waitForDeployment();
    return new ethers.Contract(await c.getAddress(), build.ChallengePot.abi, wallet);
  })();
  const journalAddress = await journal.getAddress();
  const potAddress = await pot.getAddress();
  console.log(`drill journal: ${journalAddress}`);
  console.log(`drill pot    : ${potAddress}`);

  const perWin = ethers.parseEther("0.001");
  await waitForReceipt(
    await pot.configureBounty(perWin, perWin),
    "configure drill bounty",
  ); // dailyCap == one win
  const fundTx = await wallet.sendTransaction({ to: potAddress, value: ethers.parseEther("0.002") });
  await waitForReceipt(fundTx, "fund drill pot");
  record({
    action: "deploy drill journal+pot, configure bounty 0.001/cap 0.001, fund 0.002 OG",
    kind: "tx",
    txHash: fundTx.hash,
    expected: "pot live with 0.002 OG",
    observed: `pot balance ${ethers.formatEther(await rawBalance(potAddress))} OG`,
    pass: (await rawBalance(potAddress)) === ethers.parseEther("0.002"),
  });

  const startHash = canonicalHash(START_FEN);
  const afterHash = canonicalHash(FEN_AFTER_E4);

  const mkGame = async (tag: string, playerAddr: string, plies: number, result: number | null) => {
    const id = gid(tag);
    await waitForReceipt(
      await journal.startGame(id, startHash, playerAddr, "drill-fixture", ethers.ZeroAddress),
      `start drill game ${tag}`,
    );
    for (let i = 0; i < plies; i++) {
      await waitForReceipt(
        await journal.commitMove(id, 0, startHash, afterHash, "e4", ethers.ZeroHash),
        `commit drill game ${tag}`,
      );
    }
    if (result !== null) {
      await waitForReceipt(
        await journal.endGame(id, result, afterHash),
        `end drill game ${tag}`,
      );
    }
    return id;
  };

  // -- scenario games ---------------------------------------------------------
  const gA = await mkGame("A-player-win", player, 1, RESULT.PlayerWin);
  const gB = await mkGame("B-model-win", player, 1, RESULT.ModelWin);
  const gC = await mkGame("C-no-player", ethers.ZeroAddress, 1, RESULT.PlayerWin);
  const gD = await mkGame("D-cap-exceeded", player2, 1, RESULT.PlayerWin);
  const gE = await mkGame("E-ongoing", player, 1, null);

  // 1. real award pays the journal-recorded player
  const before = await rawBalance(player);
  const awardTx = await pot.award(gA);
  const awardRcpt = await waitForReceipt(awardTx, "award drill winner");
  const after = await rawBalance(player);
  record({
    action: `award(${gA.slice(0, 10)}…) for journal-recorded PlayerWin`,
    kind: "tx",
    txHash: awardTx.hash,
    block: awardRcpt?.blockNumber,
    expected: `player ${player} receives 0.001 OG`,
    observed: `player balance ${ethers.formatEther(before)} -> ${ethers.formatEther(after)} OG`,
    pass: after - before === perWin,
  });

  const potIface = new ethers.Interface(build.ChallengePot.abi as ethers.InterfaceAbi);
  const journalIface = new ethers.Interface(build.MoveJournal.abi as ethers.InterfaceAbi);

  // 2-7. award bindings
  await expectRevert("award same game twice", potIface, "AlreadyRewarded", () => pot.award.staticCall(gA));
  await expectRevert("award a ModelWin game", potIface, "NotPlayerWin", () => pot.award.staticCall(gB));
  await expectRevert("award PlayerWin with no player recorded", potIface, "NoPlayerRecorded", () => pot.award.staticCall(gC));
  await expectRevert("award beyond the daily cap (cap consumed by step 2)", potIface, "DailyCapExceeded", () => pot.award.staticCall(gD));
  await expectRevert("award an ongoing game", potIface, "GameNotEnded", () => pot.award.staticCall(gE));
  await expectRevert("award unknown gameId", potIface, "NoSuchGame", () => pot.award.staticCall(gid("Z-unknown")));

  // 8-9. journal lifecycle bindings
  await expectRevert("commitMove after endGame", journalIface, "GameAlreadyEnded", () =>
    journal.commitMove.staticCall(gA, 0, startHash, afterHash, "e4", ethers.ZeroHash),
  );
  await expectRevert("model move without receiptHash", journalIface, "ModelMoveNeedsReceipt", () =>
    journal.commitMove.staticCall(gE, 1, startHash, afterHash, "e4", ethers.ZeroHash),
  );

  // 10. stranger cannot write the journal (eth_call with a foreign `from`)
  await expectRevert("startGame from a non-referee address", journalIface, "NotReferee", () =>
    provider.call({
      to: journalAddress,
      from: player,
      data: journalIface.encodeFunctionData("startGame", [
        gid("S-stranger"),
        startHash,
        player,
        "drill-fixture",
        ethers.ZeroAddress,
      ]),
    }),
  );

  // 11. permissionless award — call comes from a different sender than the referee.
  //     (static proof: eth_call with from=player2 on game D would still hit the
  //      cap; instead prove sender-independence on an UNREWARDED valid game by
  //      checking award.staticCall with a foreign `from` fails ONLY with the
  //      cap error, not an authorization error)
  {
    const block = await provider.getBlockNumber();
    try {
      await provider.call({
        to: potAddress,
        from: player2,
        data: potIface.encodeFunctionData("award", [gD]),
      });
      record({ action: "award from a stranger address (permissionless)", kind: "staticcall", block, expected: "no authorization revert (only DailyCapExceeded)", observed: "call succeeded", pass: false });
    } catch (err) {
      const name = revertName(potIface, err);
      record({
        action: "award from a stranger address (permissionless)",
        kind: "staticcall",
        block,
        revert: name,
        expected: "DailyCapExceeded (cap binds; sender is irrelevant — no auth error)",
        observed: `reverted with ${name}`,
        pass: name === "DailyCapExceeded",
      });
    }
  }

  // 12. owner reclaims leftover
  const leftover = await rawBalance(potAddress);
  const defundTx = await pot.defund(wallet.address, leftover);
  const defundRcpt = await waitForReceipt(defundTx, "defund drill pot");
  record({
    action: "owner defund reclaims leftover pot",
    kind: "tx",
    txHash: defundTx.hash,
    block: defundRcpt?.blockNumber,
    expected: `pot balance 0 after reclaiming ${ethers.formatEther(leftover)} OG`,
    observed: `pot balance ${ethers.formatEther(await rawBalance(potAddress))} OG`,
    pass: (await rawBalance(potAddress)) === 0n,
  });

  const passCount = steps.filter((s) => s.pass).length;
  const out = {
    kind: "fairmate-pot-drill",
    network: net.displayName,
    chainId: net.chainId,
    explorer: net.explorer,
    referee: wallet.address,
    drillJournal: journalAddress,
    drillPot: potAddress,
    throwawayPlayers: { player, player2 },
    note:
      `Synthetic owner-marked fixtures on a DEDICATED drill journal+pot; the product deployment (evidence/deployment.${net.name}.json) is separate. Negative paths proven via eth_call at the recorded block. No fake TEE receipt is ever fabricated: the only model-move commit attempted here is the one that must revert.`,
    games: { A_playerWin: gA, B_modelWin: gB, C_noPlayer: gC, D_capExceeded: gD, E_ongoing: gE },
    steps,
    result: `${passCount}/${steps.length} checks passed`,
    ranAt: new Date().toISOString(),
  };
  const outPath = resolve(EVIDENCE_DIR, `pot-drill.${net.name}.json`);
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n${passCount}/${steps.length} checks passed -> ${outPath}`);
  if (passCount !== steps.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
