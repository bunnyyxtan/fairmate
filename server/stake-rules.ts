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
  minWei: bigint,
  potAddress: string,
  network: string,
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
  if (facts.valueWei < minWei) {
    return {
      ok: false,
      retryable: false,
      reason: `stake of ${formatEther(facts.valueWei)} OG is below the ${formatEther(minWei)} OG entry fee`,
    };
  }
  return { ok: true, amountOg: formatEther(facts.valueWei), blockNumber: facts.blockNumber };
}
