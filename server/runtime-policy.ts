export interface FairMateRuntimeEnv {
  FAIRMATE_PRACTICE_ONLY?: string;
  FAIRMATE_RECOVERY_DATABASE_URL?: string;
  DATABASE_URL?: string;
  /**
   * Storage epoch floor: entry stakes mined before this block number are never
   * accepted. Replacement storage starts without the consumed-stake table of
   * the previous database, so without a floor any historical stake could be
   * replayed. Mandatory whenever FAIRMATE_RECOVERY_DATABASE_URL is in use.
   */
  FAIRMATE_STAKE_MIN_BLOCK?: string;
}

function nonempty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * Parses the stake floor. `unset` means no floor was configured, `invalid`
 * means one was configured but cannot be trusted (both fail closed for paid
 * play on replacement storage).
 */
export function stakeMinBlockFromEnv(
  env: FairMateRuntimeEnv,
): { kind: "unset" } | { kind: "invalid"; raw: string } | { kind: "set"; block: number } {
  const raw = env.FAIRMATE_STAKE_MIN_BLOCK?.trim() ?? "";
  if (!raw) return { kind: "unset" };
  if (!/^[0-9]{1,15}$/.test(raw)) return { kind: "invalid", raw };
  const block = Number(raw);
  if (!Number.isSafeInteger(block) || block <= 0) return { kind: "invalid", raw };
  return { kind: "set", block };
}

/**
 * Why paid admission is closed by configuration, or null when prize games
 * may open (subject to the live admission gates).
 */
export function practiceOnlyReasonFromEnv(env: FairMateRuntimeEnv): string | null {
  if (env.FAIRMATE_PRACTICE_ONLY?.trim().toLowerCase() === "true") {
    return "FAIRMATE_PRACTICE_ONLY=true";
  }
  const floor = stakeMinBlockFromEnv(env);
  if (floor.kind === "invalid") {
    return "FAIRMATE_STAKE_MIN_BLOCK is not a positive block number";
  }
  if (nonempty(env.FAIRMATE_RECOVERY_DATABASE_URL) && floor.kind === "unset") {
    return "replacement storage is active without a FAIRMATE_STAKE_MIN_BLOCK stake floor";
  }
  return null;
}

/**
 * Practice-only unless the operator explicitly enabled paid play AND every
 * stake-replay protection the storage needs is configured.
 */
export function practiceOnlyFromEnv(env: FairMateRuntimeEnv): boolean {
  return practiceOnlyReasonFromEnv(env) !== null;
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
    super("FairMate is practice-only right now; payout addresses and stake transactions are not accepted");
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

/** Explicitly unavailable financial metadata for the chain-free practice API. */
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

export const practiceOnlyReason = practiceOnlyReasonFromEnv(process.env);
export const practiceOnly = practiceOnlyReason !== null;
const stakeFloor = stakeMinBlockFromEnv(process.env);
/** Block floor applied to every entry stake; 0 when no floor is configured. */
export const stakeMinBlock = stakeFloor.kind === "set" ? stakeFloor.block : 0;
