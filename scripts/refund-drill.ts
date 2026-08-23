/**
 * Stake refund drill — LIVE against the production FairMate site.
 *
 * Proves, with real OG on 0G Mainnet, that a staked game which ends without
 * a winner returns the player's stake automatically:
 *   1. send exactly the entry fee from the player wallet to the ChallengePot
 *   2. admit a prize game on the live site with that stake transaction
 *   3. let the abandonment sweep abort the idle game (never move a piece)
 *   4. watch the durable outbox anchor the abort and defund the stake back
 *   5. verify the Defunded event, the refund receipt, and exact balances
 *
 * The player wallet here is the referee/owner wallet itself: the drill's
 * point is the money path (pot -> player), not who the player is.
 *
 * Usage:
 *   pnpm exec tsx scripts/refund-drill.ts --network=mainnet \
 *     [--site=https://fairmate-cyan.vercel.app]
 *
 * If the drill client dies after the stake was sent (the server refunds on
 * its own either way — that is the whole point), resume verification with:
 *   pnpm exec tsx scripts/refund-drill.ts --network=mainnet --resume \
 *     --wallet-before=<OG> --pot-before=<OG> [--session=/tmp/fairmate-refund-session.json]
 * The before-balances come from the interrupted run's log; everything else is
 * reconstructed from the chain and the live API.
 *
 * Requires OG_WALLET_PRIVATE_KEY. Optionally set REFUND_DRILL_DB_URL to the
 * production DATABASE_URL to hard-verify the durable outbox is drained
 * before broadcasting an out-of-band transaction from the shared wallet
 * (one wallet = one nonce space; never race the outbox).
 *
 * Writes evidence/refund-drill.<network>.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { EVIDENCE_DIR, PROJECT_ROOT, findFlag, hasFlag, resolveNetwork } from "../src/config.js";
import { loadPrivateKey } from "../src/keys.js";

const net = resolveNetwork(process.argv, process.env);
const SITE = (findFlag(process.argv, "site") ?? "https://fairmate-cyan.vercel.app").replace(/\/$/, "");
const RESUME = hasFlag(process.argv, "resume");
const SESSION_PATH = findFlag(process.argv, "session") ?? "/tmp/fairmate-refund-session.json";
const provider = new ethers.JsonRpcProvider(net.evmRpc, net.chainId);
const wallet = new ethers.Wallet(loadPrivateKey(), provider);

interface BuildEntry {
  abi: ethers.InterfaceAbi;
}
const build = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "build/FairMate.json"), "utf8")) as {
  ChallengePot: BuildEntry;
};
const potIface = new ethers.Interface(build.ChallengePot.abi);

interface Step {
  n: number;
  action: string;
  kind: "tx" | "api" | "observation";
  txHash?: string;
  block?: number;
  expected: string;
  observed: string;
  pass: boolean;
  at: string;
}
const steps: Step[] = [];
let n = 0;
const t0 = Date.now();
function elapsed(): string {
  return `${((Date.now() - t0) / 1000).toFixed(0)}s`;
}
function record(s: Omit<Step, "n" | "at">) {
  n += 1;
  steps.push({ n, ...s, at: new Date().toISOString() });
  console.log(`${s.pass ? "PASS" : "FAIL"} ${String(n).padStart(2)}  [${elapsed()}] ${s.action} — ${s.observed}`);
}

const rawBalance = async (a: string) =>
  BigInt(await provider.send("eth_getBalance", [a, "latest"]));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiGet<T>(path: string, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${SITE}/api/${path}`, {
    headers: token ? { "X-FairMate-Game-Token": token } : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

async function apiPost<T>(path: string, payload: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${SITE}/api/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-FairMate-Game-Token": token } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45_000),
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

interface TxRef {
  status: "pending" | "confirmed" | "failed";
  txHash?: string;
  blockNumber?: number;
  amountOg?: string;
  error?: string;
}
interface LiveGame {
  gameId: string;
  status: string;
  result: string;
  endReason?: string;
  clock: { playerMs: number; modelMs: number };
  startTx: TxRef;
  endTx?: TxRef;
  refundTx?: TxRef;
  stake?: { txHash: string; from: string; amountOg: string };
}
interface PotInfo {
  entryFeeOg: string;
  refereeAddress: string;
  attestationReady: boolean;
  chain: { potAddress: string; chainId: number; explorer: string };
}

/** The outbox and this drill share one wallet, therefore one nonce space. */
async function assertOutboxDrained(): Promise<void> {
  const dbUrl = process.env.REFUND_DRILL_DB_URL;
  if (!dbUrl) {
    console.log("      (REFUND_DRILL_DB_URL not set — skipping direct outbox check)");
    return;
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const res = await client.query(
      `select count(*)::int as pending from "fairmate"."fairmate_games"
       where jsonb_array_length(pending_actions) > 0`,
    );
    const pending = (res.rows[0] as { pending: number }).pending;
    if (pending > 0) {
      throw new Error(
        `refusing to broadcast: ${pending} game(s) still have queued outbox actions on the shared wallet`,
      );
    }
    record({
      action: "durable outbox drained before out-of-band stake broadcast",
      kind: "observation",
      expected: "0 games with queued actions",
      observed: "0 games with queued actions",
      pass: true,
    });
  } finally {
    await client.end();
  }
}

function parseFunded(logs: readonly ethers.Log[], potAddress: string) {
  return logs
    .filter((log) => log.address.toLowerCase() === potAddress.toLowerCase())
    .map((log) => {
      try {
        return potIface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "Funded");
}

async function main() {
  console.log(`network : ${net.displayName} (chainId ${net.chainId})`);
  console.log(`site    : ${SITE}`);
  console.log(`player  : ${wallet.address} (referee wallet acting as player)`);
  if (RESUME) console.log(`mode    : RESUME — money already moved, reconstructing verification`);

  // -- preflight --------------------------------------------------------------
  let pot: PotInfo | null = null;
  for (let i = 0; i < 24; i += 1) {
    const { status, body } = await apiGet<PotInfo>("pot");
    if (status === 200 && body.attestationReady) {
      pot = body;
      break;
    }
    console.log(`      [${elapsed()}] waiting for live site attestation (status ${status})…`);
    await sleep(10_000);
  }
  if (!pot) throw new Error("live site never reported attestationReady");
  if (pot.chain.chainId !== net.chainId) {
    throw new Error(`site targets chainId ${pot.chain.chainId}, drill targets ${net.chainId}`);
  }
  const potAddress = ethers.getAddress(pot.chain.potAddress);
  const entryFeeWei = ethers.parseEther(pot.entryFeeOg);
  record({
    action: "live site preflight",
    kind: "api",
    expected: "attestation ready, mainnet pot config",
    observed: `entry fee ${pot.entryFeeOg} OG, pot ${potAddress}, referee ${pot.refereeAddress}`,
    pass: ethers.getAddress(pot.refereeAddress) === wallet.address,
  });

  let walletBefore: bigint;
  let potBefore: bigint;
  let stakeTxHash: string;
  let gameId: string;
  let token: string;
  let game: LiveGame;
  let admittedAt: number;

  if (!RESUME) {
    await assertOutboxDrained();

    walletBefore = await rawBalance(wallet.address);
    potBefore = await rawBalance(potAddress);
    record({
      action: "balances before stake",
      kind: "observation",
      expected: "recorded for exact reconciliation",
      observed: `player ${ethers.formatEther(walletBefore)} OG, pot ${ethers.formatEther(potBefore)} OG`,
      pass: walletBefore > entryFeeWei,
    });

    // -- 1. stake -------------------------------------------------------------
    const stakeTx = await wallet.sendTransaction({ to: potAddress, value: entryFeeWei });
    const stakeRcpt = await stakeTx.wait();
    if (!stakeRcpt || stakeRcpt.status !== 1) throw new Error(`stake transfer failed: ${stakeTx.hash}`);
    stakeTxHash = stakeTx.hash;
    const funded = parseFunded(stakeRcpt.logs, potAddress);
    record({
      action: `stake ${pot.entryFeeOg} OG into the ChallengePot`,
      kind: "tx",
      txHash: stakeTxHash,
      block: stakeRcpt.blockNumber,
      expected: `Funded(${wallet.address}, ${pot.entryFeeOg} OG)`,
      observed: funded
        ? `Funded(${funded.args[0]}, ${ethers.formatEther(funded.args[1] as bigint)} OG)`
        : "no Funded event in stake receipt",
      pass:
        Boolean(funded) &&
        ethers.getAddress(String(funded!.args[0])) === wallet.address &&
        (funded!.args[1] as bigint) === entryFeeWei,
    });

    // -- 2. admit the prize game ------------------------------------------------
    const created = await apiPost<{ game: LiveGame; accessToken: string } & { error?: string }>(
      "games",
      { playerAddress: wallet.address, stakeTxHash },
    );
    if (created.status !== 201) {
      throw new Error(`game admission failed (${created.status}): ${JSON.stringify(created.body)}`);
    }
    game = created.body.game;
    gameId = game.gameId;
    token = created.body.accessToken;
    writeFileSync(SESSION_PATH, JSON.stringify({ gameId, accessToken: token, site: SITE }));
    record({
      action: "prize game admitted on the live site with the stake tx",
      kind: "api",
      expected: "201 with stake recorded",
      observed: `game ${gameId.slice(0, 12)}… stake ${game.stake?.amountOg} OG from ${game.stake?.from}`,
      pass:
        game.stake?.amountOg === pot.entryFeeOg &&
        ethers.getAddress(String(game.stake?.from)) === wallet.address,
    });
    admittedAt = Date.now();
  } else {
    // -- RESUME: the stake/admission/abort already happened; rebuild the facts --
    const session = JSON.parse(readFileSync(SESSION_PATH, "utf8")) as {
      gameId: string;
      accessToken: string;
      site: string;
    };
    if (session.site !== SITE) throw new Error(`session site ${session.site} != drill site ${SITE}`);
    gameId = session.gameId;
    token = session.accessToken;

    const wb = findFlag(process.argv, "wallet-before");
    const pb = findFlag(process.argv, "pot-before");
    if (!wb || !pb) throw new Error("--resume requires --wallet-before=<OG> and --pot-before=<OG> from the interrupted run's log");
    walletBefore = ethers.parseEther(wb);
    potBefore = ethers.parseEther(pb);
    record({
      action: "balances before stake (carried from the interrupted run's log)",
      kind: "observation",
      expected: "exact values printed by the interrupted run before it staked",
      observed: `player ${ethers.formatEther(walletBefore)} OG, pot ${ethers.formatEther(potBefore)} OG`,
      pass: walletBefore > entryFeeWei,
    });

    const polled = await apiGet<LiveGame>(`games/${gameId}`, token);
    if (polled.status !== 200) throw new Error(`cannot load game ${gameId}: ${polled.status}`);
    game = polled.body;
    if (!game.stake?.txHash) throw new Error("game has no recorded stake; nothing to verify");
    stakeTxHash = game.stake.txHash;

    const stakeRcpt = await provider.getTransactionReceipt(stakeTxHash);
    if (!stakeRcpt) throw new Error(`stake receipt not found: ${stakeTxHash}`);
    const funded = parseFunded(stakeRcpt.logs, potAddress);
    record({
      action: `stake ${pot.entryFeeOg} OG into the ChallengePot (re-verified from chain)`,
      kind: "tx",
      txHash: stakeTxHash,
      block: stakeRcpt.blockNumber,
      expected: `Funded(${wallet.address}, ${pot.entryFeeOg} OG), receipt status 1`,
      observed: funded
        ? `Funded(${funded.args[0]}, ${ethers.formatEther(funded.args[1] as bigint)} OG), status ${stakeRcpt.status}`
        : `no Funded event, status ${stakeRcpt.status}`,
      pass:
        stakeRcpt.status === 1 &&
        Boolean(funded) &&
        ethers.getAddress(String(funded!.args[0])) === wallet.address &&
        (funded!.args[1] as bigint) === entryFeeWei,
    });
    record({
      action: "prize game admitted on the live site with the stake tx",
      kind: "api",
      expected: "live game records the exact stake from the player wallet",
      observed: `game ${gameId.slice(0, 12)}… stake ${game.stake.amountOg} OG from ${game.stake.from}`,
      pass:
        game.stake.amountOg === pot.entryFeeOg &&
        ethers.getAddress(String(game.stake.from)) === wallet.address,
    });
    admittedAt = Date.now();
  }

  // -- 3. abandon: never move; the idle sweep must abort the game ----------------
  if (game.result === "ongoing") {
    console.log(`      [${elapsed()}] abandoning game — polling while the idle sweep does its job…`);
  }
  const abortDeadline = admittedAt + 5.75 * 60 * 1000;
  while (game.result === "ongoing") {
    if (Date.now() > abortDeadline) break;
    await sleep(15_000);
    const idleFor = ((Date.now() - admittedAt) / 1000).toFixed(0);
    try {
      const polled = await apiGet<LiveGame>(`games/${gameId}`, token);
      if (polled.status !== 200) {
        console.log(`      [${elapsed()}] poll ${polled.status} — retrying`);
        continue;
      }
      game = polled.body;
    } catch (err) {
      console.log(`      [${elapsed()}] poll error (${err instanceof Error ? err.message : err}) — retrying`);
      continue;
    }
    console.log(
      `      [${elapsed()}] idle ${idleFor}s · status=${game.status} result=${game.result} playerClock=${Math.round(game.clock.playerMs / 1000)}s`,
    );
  }
  record({
    action: "idle game aborted by the abandonment sweep (no move ever sent)",
    kind: "api",
    expected: "result=aborted, reason 'abandoned, idle timeout', player clock never expired",
    observed: `result=${game.result}, endReason=${game.endReason ?? "-"}, playerClock=${Math.round(game.clock.playerMs / 1000)}s left`,
    pass:
      game.result === "aborted" &&
      game.endReason === "abandoned, idle timeout" &&
      game.clock.playerMs > 0,
  });
  if (game.result !== "aborted") {
    throw new Error(`game did not abort (result=${game.result}); drill cannot continue`);
  }

  // -- 4. the outbox anchors the abort, then defunds the stake -------------------
  const refundDeadline = Date.now() + 6 * 60 * 1000;
  let evidenceNudges = 0;
  while ((game.refundTx?.status ?? "pending") === "pending" && Date.now() < refundDeadline) {
    await sleep(10_000);
    try {
      const polled = await apiGet<LiveGame>(`games/${gameId}`, token);
      if (polled.status === 200) game = polled.body;
      console.log(
        `      [${elapsed()}] endTx=${game.endTx?.status ?? "-"} refundTx=${game.refundTx?.status ?? "-"}`,
      );
      // An evidence request nudges the outbox drain server-side while anchors
      // are pending; harmless once everything settled.
      if ((game.refundTx?.status ?? "pending") === "pending" && evidenceNudges < 12) {
        evidenceNudges += 1;
        await apiGet(`games/${gameId}/evidence`, token);
      }
    } catch (err) {
      console.log(`      [${elapsed()}] poll error (${err instanceof Error ? err.message : err}) — retrying`);
    }
  }
  record({
    action: "stake refund confirmed by the durable outbox",
    kind: "tx",
    txHash: game.refundTx?.txHash,
    block: game.refundTx?.blockNumber,
    expected: "endTx confirmed, refundTx confirmed with a tx hash",
    observed: `endTx=${game.endTx?.status} (${game.endTx?.txHash ?? "-"}), refundTx=${game.refundTx?.status} (${game.refundTx?.txHash ?? "-"}), amount=${game.refundTx?.amountOg ?? "-"}`,
    pass:
      game.endTx?.status === "confirmed" &&
      game.refundTx?.status === "confirmed" &&
      Boolean(game.refundTx?.txHash) &&
      game.refundTx?.amountOg === pot.entryFeeOg,
  });
  if (game.refundTx?.status !== "confirmed" || !game.refundTx.txHash) {
    throw new Error(`refund never confirmed (status=${game.refundTx?.status ?? "missing"})`);
  }

  // -- 5. independent on-chain verification --------------------------------------
  const refundRcpt = await provider.getTransactionReceipt(game.refundTx.txHash);
  if (!refundRcpt) throw new Error(`refund receipt not found: ${game.refundTx.txHash}`);
  const defunded = refundRcpt.logs
    .filter((log) => log.address.toLowerCase() === potAddress.toLowerCase())
    .map((log) => {
      try {
        return potIface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "Defunded");
  record({
    action: "Defunded event on the ChallengePot returns the exact stake",
    kind: "tx",
    txHash: game.refundTx.txHash,
    block: refundRcpt.blockNumber,
    expected: `Defunded(${wallet.address}, ${pot.entryFeeOg} OG), receipt status 1`,
    observed: defunded
      ? `Defunded(${defunded.args[0]}, ${ethers.formatEther(defunded.args[1] as bigint)} OG), status ${refundRcpt.status}`
      : `no Defunded event, status ${refundRcpt.status}`,
    pass:
      refundRcpt.status === 1 &&
      Boolean(defunded) &&
      ethers.getAddress(String(defunded!.args[0])) === wallet.address &&
      (defunded!.args[1] as bigint) === entryFeeWei,
  });

  const walletAfter = await rawBalance(wallet.address);
  const potAfter = await rawBalance(potAddress);
  // Exact reconciliation: the wallet paid gas for its own stake transfer and
  // (as referee/owner) for the start anchor, end anchor and defund; the stake
  // itself went out and came back. Any other traffic in the window would
  // break this identity, so it doubles as an isolation check.
  const gasOf = async (txHash?: string): Promise<bigint> => {
    if (!txHash) return 0n;
    const rcpt = await provider.getTransactionReceipt(txHash);
    if (!rcpt) throw new Error(`receipt disappeared for ${txHash}`);
    return rcpt.gasUsed * rcpt.gasPrice;
  };
  const gasStake = await gasOf(stakeTxHash);
  const gasStart = await gasOf(game.startTx.txHash);
  const gasEnd = await gasOf(game.endTx?.txHash);
  const gasDefund = await gasOf(game.refundTx.txHash);
  const expectedWalletAfter = walletBefore - gasStake - gasStart - gasEnd - gasDefund;
  record({
    action: "exact balance reconciliation (stake out, refund in, only gas lost)",
    kind: "observation",
    expected: `player ${ethers.formatEther(expectedWalletAfter)} OG, pot ${ethers.formatEther(potBefore)} OG`,
    observed: `player ${ethers.formatEther(walletAfter)} OG, pot ${ethers.formatEther(potAfter)} OG`,
    pass: walletAfter === expectedWalletAfter && potAfter === potBefore,
  });

  // -- 6. the game's evidence JSON shows the confirmed refund ---------------------
  let evidence: Record<string, unknown> | null = null;
  const evidenceDeadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < evidenceDeadline) {
    const res = await apiGet<Record<string, unknown>>(`games/${gameId}/evidence`, token);
    if (res.status === 200) {
      evidence = res.body;
      break;
    }
    console.log(`      [${elapsed()}] evidence not settled yet (${res.status}) — retrying`);
    await sleep(10_000);
  }
  const evidenceRefund = (evidence?.refundTx ?? null) as TxRef | null;
  record({
    action: "evidence JSON records the confirmed refund",
    kind: "api",
    expected: `refundTx.status=confirmed, txHash=${game.refundTx.txHash}`,
    observed: evidence
      ? `result=${String(evidence.result)}, refundTx.status=${evidenceRefund?.status}, txHash=${evidenceRefund?.txHash}`
      : "evidence endpoint never settled",
    pass:
      Boolean(evidence) &&
      evidence!.result === "aborted" &&
      evidenceRefund?.status === "confirmed" &&
      evidenceRefund?.txHash === game.refundTx.txHash,
  });

  // -- write the drill record ------------------------------------------------------
  const passCount = steps.filter((s) => s.pass).length;
  const out = {
    kind: "fairmate-refund-drill",
    network: net.displayName,
    chainId: net.chainId,
    explorer: net.explorer,
    site: SITE,
    potAddress,
    player: wallet.address,
    resumedVerification: RESUME,
    note:
      "Live production drill: a real prize game staked the entry fee, was deliberately abandoned, " +
      "and the abandonment sweep aborted it; the durable outbox then anchored the abort and " +
      "returned the stake with an owner defund. The player wallet is the referee wallet — the " +
      "drill proves the money path, not the player's identity. The game's full evidence JSON " +
      "is embedded below." +
      (RESUME
        ? " The drill client was interrupted mid-run; the server refunded on its own (that is " +
          "the design under test) and this record was rebuilt afterwards from the chain and the " +
          "live API, with before-balances carried from the interrupted run's log."
        : ""),
    gameId,
    stakeTx: stakeTxHash,
    endTx: game.endTx?.txHash ?? null,
    refundTx: game.refundTx.txHash,
    steps,
    result: `${passCount}/${steps.length} checks passed`,
    gameEvidence: evidence,
    ranAt: new Date().toISOString(),
  };
  const outPath = resolve(EVIDENCE_DIR, `refund-drill.${net.name}.json`);
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n${passCount}/${steps.length} checks passed -> ${outPath}`);
  if (passCount !== steps.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
