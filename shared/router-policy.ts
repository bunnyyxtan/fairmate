/** Production 0G Router policy shared by server, browser and offline verifier. */
export const FAIRMATE_ROUTER_MODEL = "qwen3.7-max";

/**
 * Active provider pin for NEW inference. Audited 2026-08-31 after the Router
 * delisted the original provider: live listing shows is_healthy=true,
 * verifiability=TeeTLS, trust_mode=verified, tee_attested+tee_acknowledged,
 * tee_type=TDX, tee_verifier=dstack, pricing 0.000000825/0.0000024755 USD per
 * token (inside the FairMate ceilings below). Chosen over the sibling
 * provider 0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C (identical profile and
 * price) for consistently lower listed latency across two samples.
 */
export const FAIRMATE_ROUTER_PROVIDER = "0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0";

/**
 * Every provider FairMate has audited and pinned for qwen3.7-max, in order.
 * Receipts and stored game evidence verify against MEMBERSHIP of this set: a
 * receipt is judged by the policy that was active when it was recorded. New
 * inference is always bound to the single active FAIRMATE_ROUTER_PROVIDER.
 *
 *  1. 0xF203A388e9E70F09ece38046a6D40a89cf896309 - pinned at launch, delisted
 *     by the Router by 2026-08-31 (no longer appears on any model listing).
 *  2. 0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0 - active since 2026-08-31.
 */
export const FAIRMATE_ROUTER_AUDITED_PROVIDERS = [
  "0xF203A388e9E70F09ece38046a6D40a89cf896309",
  "0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0",
] as const;

/** True when the address is one of FairMate's audited (past or present) providers. */
export function isAuditedRouterProvider(address: string): boolean {
  const needle = address.toLowerCase();
  return FAIRMATE_ROUTER_AUDITED_PROVIDERS.some((a) => a.toLowerCase() === needle);
}

/**
 * Router price ceilings (USD per million tokens, sent verbatim as the
 * X-0G-Provider-Max-Price-Usd-* headers and committed into every receipt).
 * Like the provider pin, ceilings rotate by policy epoch: new inference is
 * bound to the single ACTIVE pair, while receipts and stored evidence verify
 * against MEMBERSHIP of the audited set, so evidence recorded under an
 * earlier epoch keeps verifying after a rotation.
 *
 *  1. 0.9 / 2.6   - launch epoch; both qwen3.7-max providers listed
 *                   0.825 / 2.4755 per million tokens.
 *  2. 1.9 / 5.5   - active since 2026-09-10. The Router raised qwen3.7-max
 *                   on both audited providers to 1.75 / 5.25 per million
 *                   tokens; the trust profile (TeeTLS, verified, TDX, dstack)
 *                   was unchanged, so the pin stays and only the ceiling moves.
 */
export interface RouterPriceCeilings {
  readonly maxPromptPriceUsd: string;
  readonly maxCompletionPriceUsd: string;
}

export const FAIRMATE_ROUTER_AUDITED_PRICE_CEILINGS: readonly RouterPriceCeilings[] = [
  { maxPromptPriceUsd: "0.9", maxCompletionPriceUsd: "2.6" },
  { maxPromptPriceUsd: "1.9", maxCompletionPriceUsd: "5.5" },
];

export const FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD = "1.9";
export const FAIRMATE_ROUTER_MAX_COMPLETION_PRICE_USD = "5.5";

/** True when the pair is one of FairMate's audited (past or present) ceiling epochs. */
export function isAuditedRouterPriceCeiling(ceilings: RouterPriceCeilings): boolean {
  return FAIRMATE_ROUTER_AUDITED_PRICE_CEILINGS.some(
    (epoch) =>
      epoch.maxPromptPriceUsd === ceilings.maxPromptPriceUsd &&
      epoch.maxCompletionPriceUsd === ceilings.maxCompletionPriceUsd,
  );
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Exact decimal string to BigInt at a fixed scale; null for anything that is not a plain non-negative decimal. */
function scaledDecimal(value: string, scale: number): bigint | null {
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(scale, "0");
  if (fraction.length > scale) return null;
  return BigInt(match[1] + fraction);
}

/**
 * True when a listed per-token USD price (string, as the Router publishes it)
 * is at or under a per-million-token ceiling string. Compared as exact
 * decimals, never as floats, so 0.0000019 per token equals a 1.9 ceiling.
 * Malformed or missing prices are NOT within any ceiling.
 */
export function withinPerMillionCeiling(perTokenUsd: string | undefined, perMillionCeilingUsd: string): boolean {
  const ceiling = scaledDecimal(perMillionCeilingUsd, 18);
  if (ceiling === null || ceiling <= 0n) {
    throw new Error(`Invalid Router price ceiling '${perMillionCeilingUsd}'`);
  }
  if (perTokenUsd === undefined) return false;
  const price = scaledDecimal(perTokenUsd, 24);
  if (price === null) return false;
  return price <= ceiling;
}
