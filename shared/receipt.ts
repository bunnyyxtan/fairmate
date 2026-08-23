import { verifyMessage } from "ethers";
import { canonicalHash, sha256Utf8 } from "./canonical";
import {
  FAIRMATE_ROUTER_MAX_COMPLETION_PRICE_USD,
  FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD,
  FAIRMATE_ROUTER_MODEL,
  FAIRMATE_ROUTER_PROVIDER,
} from "./router-policy";
import type {
  DirectReceiptBundle,
  ReceiptBundle,
  RouterReceiptBundle,
  RouterRequestConstraints,
  RouterTrace,
} from "./protocol";

/**
 * TEE receipt verification — isomorphic (browser + node).
 *
 * A 0G Compute TeeML provider signs, with the attested enclave key, the text:
 *
 *   `${requestHash}:${responseHash}:${providerType}:${providerIdentity}:${tlsCertFingerprint}`
 *
 * where responseHash = sha256(raw response body bytes). Verifying a receipt
 * therefore needs NO trusted server: recompute the body hash, recover the
 * signer from the signature, and compare against the attested TEE signer.
 * This module is imported by the web app so the check runs in the player's
 * own browser, and by the CLI verifier so anyone can re-run it offline.
 */

export interface ParsedSigText {
  requestHash: string;
  responseHash: string;
  providerType: string;
  providerIdentity: string;
  tlsCertFingerprint: string;
}

export interface ReceiptCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface DirectReceiptBundleLike {
  scheme?: "direct-teeml";
  /** exact signed text from the provider's signing service */
  sigText: string;
  /** EIP-191 personal_sign signature over sigText */
  signature: string;
  /** TEE signer address expected to have produced the signature */
  effectiveSigner: string;
  /** raw response body bytes, as UTF-8 string, exactly as received */
  rawBody: string;
  /** sha256(rawBody) recorded at capture time */
  rawBodySha256: string;
  /** canonicalHash({ sigText, signature, rawBodySha256 }) — the on-chain commitment */
  receiptHash: string;
}

export interface RouterReceiptBundleLike {
  scheme: "router-teetls";
  model: string;
  provider: string;
  rawBody: string;
  rawBodySha256: string;
  requestBodyJson: string;
  requestBodySha256: string;
  requestConstraints: RouterRequestConstraints;
  trace: RouterTrace;
  receiptHash: string;
}

export type ReceiptBundleLike =
  | DirectReceiptBundleLike
  | RouterReceiptBundleLike
  | ReceiptBundle;

function stripHexPrefix(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

export function parseSigText(sigText: string): ParsedSigText | null {
  const parts = sigText.split(":");
  if (parts.length !== 5) return null;
  const [requestHash, responseHash, providerType, providerIdentity, tlsCertFingerprint] = parts;
  if (!requestHash || !responseHash) return null;
  return { requestHash, responseHash, providerType, providerIdentity, tlsCertFingerprint };
}

/** Recompute the receipt commitment exactly as the referee commits it on-chain. */
export function computeReceiptHash(b: {
  sigText: string;
  signature: string;
  rawBodySha256: string;
}): string {
  return canonicalHash({
    sigText: b.sigText,
    signature: b.signature,
    rawBodySha256: b.rawBodySha256,
  });
}

export function computeRouterReceiptHash(b: {
  model: string;
  provider: string;
  requestBodySha256: string;
  rawBodySha256: string;
  requestConstraints: RouterRequestConstraints;
  trace: RouterTrace;
}): string {
  return canonicalHash({
    scheme: "router-teetls",
    model: b.model,
    provider: b.provider.toLowerCase(),
    requestBodySha256: b.requestBodySha256,
    requestConstraints: {
      providerAddress: b.requestConstraints.providerAddress.toLowerCase(),
      maxPromptPriceUsd: b.requestConstraints.maxPromptPriceUsd,
      maxCompletionPriceUsd: b.requestConstraints.maxCompletionPriceUsd,
    },
    rawBodySha256: b.rawBodySha256,
    requestId: b.trace.requestId,
    traceProvider: b.trace.provider.toLowerCase(),
    teeVerified: b.trace.teeVerified,
    billing: b.trace.billing,
  });
}

/**
 * Full receipt verification. Every check is recomputed from raw material —
 * nothing is taken on faith from the server that handed over the bundle.
 */
function verifyDirectReceiptBundle(
  b: DirectReceiptBundleLike | DirectReceiptBundle,
): ReceiptCheck[] {
  const checks: ReceiptCheck[] = [];
  const push = (name: string, pass: boolean, detail: string) =>
    checks.push({ name, pass, detail });

  const parsed = parseSigText(b.sigText);
  push(
    "sigText structure",
    parsed !== null,
    parsed
      ? "signed text has the 5 expected fields (reqHash:respHash:type:identity:tlsFp)"
      : `signed text does not parse into 5 fields: ${b.sigText.slice(0, 80)}…`,
  );
  if (!parsed) return checks;

  // NOTE: hashes inside sigText (and the recorded rawBodySha256) are BARE hex
  // sha256 digests — no 0x prefix. Normalize before comparing.
  const bodyHash = sha256Utf8(b.rawBody).slice(2);
  const respHash = stripHexPrefix(parsed.responseHash);
  push(
    "response bytes bound",
    bodyHash === respHash,
    bodyHash === respHash
      ? `sha256(rawBody) = ${bodyHash.slice(0, 16)}… matches the signed responseHash`
      : `sha256(rawBody) = ${bodyHash} but signed responseHash = ${respHash}`,
  );

  const recorded = stripHexPrefix(b.rawBodySha256);
  push(
    "recorded body hash consistent",
    bodyHash === recorded,
    bodyHash === recorded
      ? "recorded rawBodySha256 matches recomputed hash"
      : `recorded rawBodySha256 = ${recorded} but recomputed = ${bodyHash}`,
  );

  let recovered: string | null = null;
  try {
    recovered = verifyMessage(b.sigText, b.signature);
  } catch {
    recovered = null;
  }
  const signerOk = recovered !== null && recovered.toLowerCase() === b.effectiveSigner.toLowerCase();
  push(
    "TEE signature",
    signerOk,
    signerOk
      ? `signature recovers to attested TEE signer ${recovered}`
      : `signature recovers to ${recovered ?? "(invalid signature)"} — expected ${b.effectiveSigner}`,
  );

  const recomputedCommitment = computeReceiptHash({
    sigText: b.sigText,
    signature: b.signature,
    rawBodySha256: b.rawBodySha256,
  });
  push(
    "on-chain commitment",
    recomputedCommitment === b.receiptHash,
    recomputedCommitment === b.receiptHash
      ? `receiptHash recomputes to ${recomputedCommitment.slice(0, 18)}… — matches the committed value`
      : `recomputed ${recomputedCommitment} but bundle claims ${b.receiptHash}`,
  );

  return checks;
}

function verifyRouterReceiptBundle(
  b: RouterReceiptBundleLike | RouterReceiptBundle,
): ReceiptCheck[] {
  const checks: ReceiptCheck[] = [];
  const push = (name: string, pass: boolean, detail: string) =>
    checks.push({ name, pass, detail });

  const requestHash = sha256Utf8(b.requestBodyJson);
  push(
    "request bytes bound",
    requestHash === b.requestBodySha256,
    requestHash === b.requestBodySha256
      ? `sha256(requestBodyJson) matches ${requestHash.slice(0, 18)}…`
      : `request hash mismatch: recomputed ${requestHash}, recorded ${b.requestBodySha256}`,
  );

  const bodyHash = sha256Utf8(b.rawBody);
  push(
    "response bytes bound",
    bodyHash === b.rawBodySha256,
    bodyHash === b.rawBodySha256
      ? `sha256(rawBody) matches ${bodyHash.slice(0, 18)}…`
      : `response hash mismatch: recomputed ${bodyHash}, recorded ${b.rawBodySha256}`,
  );

  let requestOk = false;
  try {
    const req = JSON.parse(b.requestBodyJson) as { model?: unknown; verify_tee?: unknown };
    requestOk = req.model === b.model && req.verify_tee === true;
  } catch {
    requestOk = false;
  }
  push(
    "verification requested",
    requestOk,
    requestOk
      ? `request names ${b.model} and explicitly sets verify_tee=true`
      : "request body is invalid, names another model, or did not request TEE verification",
  );

  const constraintsOk =
    b.requestConstraints.providerAddress.toLowerCase() === b.provider.toLowerCase() &&
    b.model === FAIRMATE_ROUTER_MODEL &&
    b.provider.toLowerCase() === FAIRMATE_ROUTER_PROVIDER.toLowerCase() &&
    b.requestConstraints.maxPromptPriceUsd === FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD &&
    b.requestConstraints.maxCompletionPriceUsd === FAIRMATE_ROUTER_MAX_COMPLETION_PRICE_USD;
  push(
    "routing constraints bound",
    constraintsOk,
    constraintsOk
      ? `FairMate's fixed model, provider and ${FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD}/${FAIRMATE_ROUTER_MAX_COMPLETION_PRICE_USD} Router ceilings are bound`
      : "model, provider, or price-ceiling metadata does not match FairMate's fixed Router policy",
  );

  let traceOk = false;
  try {
    const response = JSON.parse(b.rawBody) as {
      model?: unknown;
      x_0g_trace?: {
        request_id?: unknown;
        provider?: unknown;
        tee_verified?: unknown;
        billing?: {
          input_cost?: unknown;
          output_cost?: unknown;
          total_cost?: unknown;
        };
      };
    };
    const trace = response.x_0g_trace;
    traceOk =
      response.model === b.model &&
      trace?.request_id === b.trace.requestId &&
      typeof trace.provider === "string" &&
      trace.provider.toLowerCase() === b.provider.toLowerCase() &&
      trace.provider.toLowerCase() === b.trace.provider.toLowerCase() &&
      trace.tee_verified === true &&
      b.trace.teeVerified === true &&
      trace.billing?.input_cost === b.trace.billing.inputCostNeuron &&
      trace.billing?.output_cost === b.trace.billing.outputCostNeuron &&
      trace.billing?.total_cost === b.trace.billing.totalCostNeuron;
  } catch {
    traceOk = false;
  }
  push(
    "Router TeeTLS trace",
    traceOk,
    traceOk
      ? `raw response carries tee_verified=true for provider ${b.provider}`
      : "raw response trace does not match the recorded verified provider/billing metadata",
  );

  const commitment = computeRouterReceiptHash(b);
  push(
    "on-chain commitment",
    commitment === b.receiptHash,
    commitment === b.receiptHash
      ? `Router evidence commitment recomputes to ${commitment.slice(0, 18)}…`
      : `recomputed ${commitment} but bundle claims ${b.receiptHash}`,
  );
  return checks;
}

/**
 * Verify every client-recomputable property. Direct TeeML receipts include a
 * raw provider signature. Router TeeTLS receipts intentionally do not; for the
 * latter this verifies exact request/response/trace binding while the
 * tee_verified boolean remains an explicit Router trust boundary.
 */
export function verifyReceiptBundle(b: ReceiptBundleLike): ReceiptCheck[] {
  return b.scheme === "router-teetls"
    ? verifyRouterReceiptBundle(b)
    : verifyDirectReceiptBundle(b);
}

export function allChecksPass(checks: ReceiptCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.pass);
}
