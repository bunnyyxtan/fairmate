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

export const FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD = "0.9";
export const FAIRMATE_ROUTER_MAX_COMPLETION_PRICE_USD = "2.6";
