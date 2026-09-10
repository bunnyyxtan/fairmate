import { formatEther, parseEther } from "ethers";

/**
 * Pure admission gates evaluated before any game is opened. The referee reads
 * live chain facts and this module decides, deterministically and testably,
 * whether FairMate can honour the game it is about to admit:
 *
 * - every game (practice included) anchors dozens of transactions from the
 *   referee wallet, so no game opens while that wallet is below its gas
 *   reserve, instead of stranding a half-anchored game;
 * - a prize game additionally needs a configured bounty, a pot that can pay
 *   it, and daily-cap headroom, so a player never stakes into a game whose
 *   win the contract would refuse to pay.
 */

/** Seconds in one ChallengePot payout window (mirrors the contract). */
export const POT_WINDOW_SECONDS = 24 * 60 * 60;

export type AdmissionGate = { open: true; reason: null } | { open: false; reason: string };

export interface GasFacts {
  refereeBalanceOg: string;
  gasReserveOg: string;
}

export interface PotFacts {
  potBalanceOg: string;
  perWinBountyOg: string;
  dailyCapOg: string;
  paidInWindowOg: string;
  /** unix seconds, as stored by the contract */
  windowStart: number;
}

function closed(reason: string): AdmissionGate {
  return { open: false, reason };
}

const OPEN: AdmissionGate = { open: true, reason: null };

/** Player-facing 0G amount: at most four decimals, never rounded up to look solvent. */
export function displayOg(wei: bigint): string {
  const [whole, frac = ""] = formatEther(wei).split(".");
  const cut = frac.slice(0, 4).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
}

export function evaluateGasGate(gas: GasFacts): AdmissionGate {
  const balance = parseEther(gas.refereeBalanceOg);
  const reserve = parseEther(gas.gasReserveOg);
  if (balance < reserve) {
    return closed(
      `the referee wallet holds ${displayOg(balance)} 0G for transaction fees, below its ${displayOg(reserve)} 0G reserve; games reopen once it is topped up`,
    );
  }
  return OPEN;
}

/**
 * Bounty already paid in the current window, applying the contract's window
 * roll: once a window is older than a day the next award starts a fresh one.
 */
export function effectivePaidInWindowWei(potFacts: PotFacts, nowMs: number): bigint {
  const nowSeconds = Math.floor(nowMs / 1000);
  if (nowSeconds >= potFacts.windowStart + POT_WINDOW_SECONDS) return 0n;
  return parseEther(potFacts.paidInWindowOg);
}

/**
 * Prize admission. `nowMs` should be the chain clock (latest block timestamp)
 * because the contract rolls its window on block.timestamp, not wall time.
 * `outstandingPrizeGames` reserves one full win payout for every staked game
 * that is still in play or whose settlement has not been confirmed on-chain,
 * so concurrent boards cannot be admitted against the same pot or cap headroom.
 */
export function evaluatePrizeGate(
  gas: GasFacts,
  potFacts: PotFacts,
  nowMs: number,
  outstandingPrizeGames = 0,
): AdmissionGate {
  const gasGate = evaluateGasGate(gas);
  if (!gasGate.open) return gasGate;
  const perWin = parseEther(potFacts.perWinBountyOg);
  if (perWin === 0n) {
    return closed("the ChallengePot has no win bounty configured, so prize games are paused");
  }
  if (!Number.isInteger(outstandingPrizeGames) || outstandingPrizeGames < 0) {
    return closed("the number of open prize games could not be determined, so prize admission is paused");
  }
  const reserved = perWin * BigInt(outstandingPrizeGames);
  const needed = reserved + perWin;
  const openGames =
    outstandingPrizeGames > 0
      ? ` plus ${outstandingPrizeGames} unsettled prize game${outstandingPrizeGames === 1 ? "" : "s"} already reserved`
      : "";
  const potBalance = parseEther(potFacts.potBalanceOg);
  if (potBalance < needed) {
    return closed(
      `the prize pool holds ${displayOg(potBalance)} 0G, below the ${displayOg(perWin)} 0G win payout${openGames}; prize games pause until the pot is funded`,
    );
  }
  const cap = parseEther(potFacts.dailyCapOg);
  const paid = effectivePaidInWindowWei(potFacts, nowMs);
  if (paid + needed > cap) {
    const reopensAt = new Date((potFacts.windowStart + POT_WINDOW_SECONDS) * 1000).toISOString();
    return closed(
      `today's prize cap of ${displayOg(cap)} 0G cannot cover another ${displayOg(perWin)} 0G win${openGames}; prize games reopen at ${reopensAt}`,
    );
  }
  return OPEN;
}
