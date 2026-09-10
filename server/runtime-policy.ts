export interface FairMateRuntimeEnv {
  FAIRMATE_PRACTICE_ONLY?: string;
  FAIRMATE_RECOVERY_DATABASE_URL?: string;
  DATABASE_URL?: string;
}

function nonempty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/** Recovery storage always implies practice-only, even after an explicit false. */
export function practiceOnlyFromEnv(env: FairMateRuntimeEnv): boolean {
  return nonempty(env.FAIRMATE_RECOVERY_DATABASE_URL) ||
    env.FAIRMATE_PRACTICE_ONLY?.trim().toLowerCase() === "true";
}

/** Selects storage without ever returning or logging both connection strings. */
export function databaseUrlFromEnv(env: FairMateRuntimeEnv): string | undefined {
  return nonempty(env.FAIRMATE_RECOVERY_DATABASE_URL)
    ? env.FAIRMATE_RECOVERY_DATABASE_URL
    : nonempty(env.DATABASE_URL)
      ? env.DATABASE_URL
      : undefined;
}

export class PracticeOnlyAdmissionError extends Error {
  constructor() {
    super("FairMate recovery is practice-only; payout addresses and stake transactions are not accepted");
  }
}

/**
 * Pure, first-line admission gate. Presence is intentionally checked rather
 * than truthiness so even empty financial fields cannot enter paid handling.
 */
export function enforceAdmissionPolicy(
  practiceOnly: boolean,
  playerAddress: string | undefined,
  stakeTxHash: string | undefined,
): void {
  if (practiceOnly && (playerAddress !== undefined || stakeTxHash !== undefined)) {
    throw new PracticeOnlyAdmissionError();
  }
}

/** Explicitly unavailable financial metadata for the chain-free recovery API. */
export function practiceOnlyFinancials() {
  return {
    potBalanceOg: null,
    perWinBountyOg: null,
    entryFeeOg: null,
    dailyCapOg: null,
    paidInWindowOg: null,
    windowStart: null,
    refereeAddress: null,
  } as const;
}

export const practiceOnly = practiceOnlyFromEnv(process.env);