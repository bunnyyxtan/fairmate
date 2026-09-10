import { formatEther } from "ethers";

/**
 * Pure entry-stake validation rules, kept free of provider/env dependencies
 * so they are unit-testable. The chain layer supplies observed transaction
 * facts; this module decides whether they admit a prize game.
 */

export interface StakeTxFacts {
  /** transaction is known to the RPC node */
  found: boolean;
  /** a receipt exists (the transaction was mined) */
  mined: boolean;
  status: number | null;
  to: string | null;
  from: string;
  valueWei: bigint;
  blockNumber: number | null;
}

export type StakeCheck =
  | { ok: true; amountOg: string; blockNumber: number }
  | { ok: false; retryable: boolean; reason: string };

export function checkStakeFacts(
  facts: StakeTxFacts | null,
  expectedFrom: string,
  requiredWei: bigint,
  potAddress: string,
  network: string,
  /**
   * Storage epoch floor. Stakes mined before it may already have been
   * consumed by a game whose record lived in a previous database, so they are
   * refused outright instead of being trusted as fresh.
   */
  minBlock = 0,
): StakeCheck {
  if (!facts || !facts.found) {
    return {
      ok: false,
      retryable: true,
      reason: `stake transaction was not found on ${network} yet, wait a few seconds for it to propagate and retry`,
    };
  }
  if (!facts.mined || facts.status === null || facts.blockNumber === null) {
    return {
      ok: false,
      retryable: true,
      reason: "stake transaction is not confirmed yet, retry in a few seconds",
    };
  }
  if (facts.status !== 1) {
    return {
      ok: false,
      retryable: false,
      reason: "stake transaction reverted on-chain, send a fresh stake",
    };
  }
  if (!facts.to || facts.to.toLowerCase() !== potAddress.toLowerCase()) {
    return {
      ok: false,
      retryable: false,
      reason: `stake must be sent to the ChallengePot address ${potAddress}`,
    };
  }
  if (facts.from.toLowerCase() !== expectedFrom.toLowerCase()) {
    return {
      ok: false,
      retryable: false,
      reason:
        "stake must be sent from your payout address, so the prize and any refund return to the wallet that paid",
    };
  }
  if (facts.valueWei !== requiredWei) {
    // Exact amount only: the win payout is a fixed configured bounty, so an
    // overpaid stake would be silently under-returned on a win. Refusing it
    // here keeps the advertised economics exactly true.
    return {
      ok: false,
      retryable: false,
      reason: `stake must be exactly ${formatEther(requiredWei)} 0G, this transaction sent ${formatEther(facts.valueWei)} 0G, send a fresh transfer for the exact amount`,
    };
  }
  if (facts.blockNumber < minBlock) {
    return {
      ok: false,
      retryable: false,
      reason: `stake was mined in block ${facts.blockNumber}, before FairMate's current storage epoch (block ${minBlock}); stakes from before the epoch cannot start a game, ask the pot owner to return that transfer and send a fresh stake`,
    };
  }
  return { ok: true, amountOg: formatEther(facts.valueWei), blockNumber: facts.blockNumber };
}
