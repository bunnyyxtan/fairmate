import { createHash } from "node:crypto";

// Provider enforces 10 requests/min; each verified ply costs 2 requests
// (inference + signature fetch). Pace inference calls start-to-start.
const MIN_INFERENCE_INTERVAL_MS = Number(process.env.OG_MIN_REQUEST_INTERVAL_MS ?? 13_000);
let lastInferenceAt = 0;
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  createZGComputeNetworkBroker,
  InferenceVerifier,
} from "@0gfoundation/0g-compute-ts-sdk";
import { canonicalHash } from "./canonical.js";
import type { NetworkConfig } from "./config.js";

/**
 * Direct 0G Compute client — the ATTESTED path, vendored/trimmed from the
 * proven releasegate spike (generic parts only; evaluator logic removed).
 *
 * Verification is MANDATORY and layered:
 *  1. verifyService(): full TEE remote attestation (validates the TDX quote
 *     AND the quote↔signer binding internally — SDK 0.9.0 behavior).
 *  2. downloadQuoteReport(): archive the raw TDX quote; hashed as evidence.
 *  3. Per response: InferenceVerifier.fetchSignatureByChatID(baseServiceUrl,
 *     chatID, model) then verifySignature against the EFFECTIVE signer, and
 *     require the signed responseHash to equal sha256(raw response bytes).
 *  4. broker.inference.processResponse(provider, chatID, usageJSON).
 * Any missing/false verification is a HARD FAIL. No mocks, no fallbacks.
 */

interface ServiceStructOutput {
  provider: string;
  serviceType: string;
  url: string;
  inputPrice: bigint;
  outputPrice: bigint;
  updatedAt: bigint;
  model: string;
  verifiability: string;
  additionalInfo: string;
  teeSignerAddress: string;
  teeSignerAcknowledged: boolean;
}

export interface ComputeSelection {
  provider: string;
  model: string;
  baseServiceUrl: string;
  endpoint: string;
  verifiability: string;
  teeSignerAddress: string;
  additionalInfo: string;
  additionalInfoHash: string;
  effectiveSigner: string;
}

/** Resolve the effective response-signing address EXACTLY as the SDK does. */
export function resolveEffectiveSigner(
  teeSignerAddress: string,
  additionalInfo: string,
): string {
  if (!additionalInfo) {
    throw new Error("0G Compute: service additionalInfo is empty; cannot resolve signing address");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(additionalInfo) as Record<string, unknown>;
  } catch {
    throw new Error("0G Compute: service additionalInfo is not valid JSON; cannot resolve signing address");
  }
  let providerType = (parsed.ProviderType as string) || "decentralized";
  if (providerType !== "decentralized" && providerType !== "centralized") {
    providerType = "decentralized";
  }
  const isCentralized = providerType === "centralized";
  const targetTee = parsed.TargetTeeAddress as string | undefined;
  if (parsed.TargetSeparated === true && !isCentralized && targetTee) {
    return targetTee;
  }
  return teeSignerAddress;
}

interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [k: string]: unknown;
}

export type Broker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>;

export async function createBroker(net: NetworkConfig, privateKey: string): Promise<Broker> {
  const provider = new ethers.JsonRpcProvider(net.evmRpc);
  const wallet = new ethers.Wallet(privateKey, provider);
  return createZGComputeNetworkBroker(wallet);
}

/** Discover providers; pick explicit address or first acknowledged TEE provider. */
export async function selectProvider(
  broker: Broker,
  explicitProvider: string | undefined,
): Promise<{ selected: ComputeSelection; services: ServiceStructOutput[] }> {
  const services = (await broker.inference.listService()) as unknown as ServiceStructOutput[];
  if (services.length === 0) {
    throw new Error("0G Compute: listService returned no providers");
  }
  let svc: ServiceStructOutput | undefined;
  if (explicitProvider) {
    svc = services.find((s) => s.provider.toLowerCase() === explicitProvider.toLowerCase());
    if (!svc) {
      throw new Error(`0G Compute: requested provider ${explicitProvider} not found in listService`);
    }
  } else {
    svc =
      services.find((s) => s.teeSignerAddress && s.teeSignerAddress !== ethers.ZeroAddress) ??
      services[0];
  }
  if (!svc.teeSignerAddress || svc.teeSignerAddress === ethers.ZeroAddress) {
    throw new Error(
      `0G Compute: provider ${svc.provider} has no teeSignerAddress; cannot produce a verifiable receipt`,
    );
  }
  if (!svc.url) {
    throw new Error(`0G Compute: provider ${svc.provider} has no service base URL`);
  }
  const { endpoint, model } = await broker.inference.getServiceMetadata(svc.provider);
  const additionalInfo = svc.additionalInfo ?? "";
  const effectiveSigner = resolveEffectiveSigner(svc.teeSignerAddress, additionalInfo);
  return {
    services,
    selected: {
      provider: svc.provider,
      model,
      baseServiceUrl: svc.url,
      endpoint,
      verifiability: svc.verifiability,
      teeSignerAddress: svc.teeSignerAddress,
      additionalInfo,
      additionalInfoHash: canonicalHash(additionalInfo),
      effectiveSigner,
    },
  };
}

/** Ensure the provider's TEE signer is acknowledged (one tx per provider). */
export async function acknowledge(broker: Broker, provider: string): Promise<boolean> {
  const status = await broker.inference.checkProviderSignerStatus(provider);
  if (!status?.isAcknowledged) {
    await broker.inference.acknowledgeProviderSigner(provider);
    return true;
  }
  return false;
}

/** LedgerManager ABI — exact TypeChain shapes from the SDK. */
export const LEDGER_MANAGER_ABI = [
  "function MIN_ACCOUNT_BALANCE() view returns (uint256)",
  "function MIN_TRANSFER_AMOUNT() view returns (uint256)",
  "function addLedger(string additionalInfo) payable returns (uint256, uint256)",
  "function depositFund() payable",
  "function getLedger(address user) view returns (tuple(address user, uint256 availableBalance, uint256 totalBalance, string additionalInfo))",
];

export interface LedgerFundingResult {
  action: "none" | "addLedger" | "depositFund";
  onChainMinAccountBalanceOg: string;
  ledgerExisted: boolean;
  depositedOg: string;
  txHash: string | null;
  walletBalanceOg: string;
  ledgerAvailableOg: string | null;
}

/**
 * Fund the Direct Compute ledger, bypassing the SDK 0.9 broker's WRONG
 * hardcoded 3 OG minimum; the on-chain minimum is queried at runtime.
 * We never silently spend: no ledger + no explicit deposit → hard error.
 */
export async function ensureLedgerFunded(params: {
  net: NetworkConfig;
  privateKey: string;
  depositOg: number | undefined;
}): Promise<LedgerFundingResult> {
  const { net, privateKey, depositOg } = params;
  const provider = new ethers.JsonRpcProvider(net.evmRpc);
  const wallet = new ethers.Wallet(privateKey, provider);
  const walletAddress = await wallet.getAddress();
  const ledger = new ethers.Contract(net.ledgerManager, LEDGER_MANAGER_ABI, wallet);

  const onChainMinWei: bigint = await ledger.MIN_ACCOUNT_BALANCE();
  const onChainMinAccountBalanceOg = ethers.formatEther(onChainMinWei);
  const walletBalanceWei = await provider.getBalance(walletAddress);

  let existingAvailable: bigint | null = null;
  try {
    const raw = (await ledger.getLedger(walletAddress)) as { availableBalance: bigint };
    existingAvailable = raw.availableBalance;
  } catch {
    existingAvailable = null;
  }

  const base = {
    onChainMinAccountBalanceOg,
    ledgerExisted: existingAvailable !== null,
    walletBalanceOg: ethers.formatEther(walletBalanceWei),
    ledgerAvailableOg: existingAvailable === null ? null : ethers.formatEther(existingAvailable),
  };

  if (existingAvailable === null) {
    if (depositOg === undefined) {
      throw new Error(
        `0G Compute: no ledger exists and no OG_COMPUTE_DEPOSIT provided. Set OG_COMPUTE_DEPOSIT>=` +
          `${onChainMinAccountBalanceOg} (on-chain MIN_ACCOUNT_BALANCE). We never silently spend.`,
      );
    }
    const depositWei = ethers.parseEther(String(depositOg));
    if (depositWei < onChainMinWei) {
      throw new Error(
        `0G Compute: deposit ${depositOg} OG is below the on-chain ledger minimum ${onChainMinAccountBalanceOg} OG.`,
      );
    }
    const tx = await ledger.addLedger("fairmate-proof", { value: depositWei });
    const receipt = await tx.wait();
    return { ...base, action: "addLedger", depositedOg: String(depositOg), txHash: receipt?.hash ?? tx.hash };
  }

  if (depositOg === undefined) {
    return { ...base, action: "none", depositedOg: "0", txHash: null };
  }
  const depositWei = ethers.parseEther(String(depositOg));
  const tx = await ledger.depositFund({ value: depositWei });
  const receipt = await tx.wait();
  return { ...base, action: "depositFund", depositedOg: String(depositOg), txHash: receipt?.hash ?? tx.hash };
}

/** One fully verified chat completion: the per-response TEE receipt. */
export interface VerifiedCompletion {
  content: string;
  chatID: string;
  usage: CompletionUsage;
  signature: { text: string; signature: string };
  effectiveSigner: string;
  recoveredSigner: string;
  signatureValid: boolean;
  receipt: {
    requestHash: string;
    responseHash: string;
    providerType: string;
    providerIdentity: string;
    tlsCertFingerprint: string;
    responseHashMatchesRawBody: boolean;
    requestHashSerialization: string;
  };
  rawBodySha256: string;
  /** Verbatim response body — the exact bytes the signed responseHash covers. */
  rawBody: string;
  /** Verbatim request body we sent (client-side commitment; requestHash is provider-internal). */
  requestBodyJson: string;
  /** Our signed 0G billing headers for the successful attempt (request-side binding). */
  requestHeaders: Record<string, string>;
  processResponseResult: boolean;
  latencyMs: number;
}

export async function verifiedCompletion(
  broker: Broker,
  sel: ComputeSelection,
  messages: Array<{ role: string; content: string }>,
  temperature: number,
): Promise<VerifiedCompletion> {
  const t0 = Date.now();
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) throw new Error("verifiedCompletion: no user message");
  const requestBody = { model: sel.model, messages, temperature };

  const bodyJson = JSON.stringify(requestBody);
  let res!: Response;
  let usedHeaders: Record<string, string> = {};
  for (let attempt = 1; ; attempt++) {
    const sinceLast = Date.now() - lastInferenceAt;
    if (sinceLast < MIN_INFERENCE_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_INFERENCE_INTERVAL_MS - sinceLast));
    }
    lastInferenceAt = Date.now();
    const headers = await broker.inference.getRequestHeaders(sel.provider, lastUser.content);
    usedHeaders = headers as unknown as Record<string, string>;
    res = await fetch(`${sel.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(headers as unknown as Record<string, string>) },
      body: bodyJson,
    });
    if (res.status !== 429 || attempt >= 4) break;
    const bodyText = await res.text().catch(() => "");
    console.warn(`[compute] provider 429 (attempt ${attempt}/4) — backing off 32s: ${bodyText.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 32_000));
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "(unreadable body)");
    throw new Error(`0G Compute: inference HTTP ${res.status} ${res.statusText} — ${bodyText.slice(0, 500)}`);
  }
  const rawBody = await res.text();
  type CompletionShape = {
    id?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: CompletionUsage;
  };
  let completion: CompletionShape;
  try {
    completion = JSON.parse(rawBody) as CompletionShape;
  } catch {
    throw new Error(`0G Compute: non-JSON completion body: ${rawBody.slice(0, 200)}`);
  }
  const chatID = res.headers.get("ZG-Res-Key") ?? completion.id ?? "";
  if (!chatID) throw new Error("0G Compute: no ZG-Res-Key header and no completion id; cannot verify");
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("0G Compute: empty completion content");
  }
  const usage = completion.usage;
  if (!usage || typeof usage !== "object") {
    throw new Error("0G Compute: response has no usage block; processResponse requires billing usage JSON");
  }

  const sig = await InferenceVerifier.fetchSignatureByChatID(sel.baseServiceUrl, chatID, sel.model);
  if (!sig || typeof sig.signature !== "string" || typeof sig.text !== "string") {
    throw new Error(`0G Compute: no response signature returned for chatID ${chatID}`);
  }
  const signatureValid = InferenceVerifier.verifySignature(sig.text, sig.signature, sel.effectiveSigner);
  if (!signatureValid) {
    throw new Error(`0G Compute: response signature failed verification against effective signer ${sel.effectiveSigner}`);
  }
  const recoveredSigner = ethers.verifyMessage(sig.text, sig.signature);
  if (recoveredSigner.toLowerCase() !== sel.effectiveSigner.toLowerCase()) {
    throw new Error(`0G Compute: recovered signer ${recoveredSigner} != effective signer ${sel.effectiveSigner}`);
  }
  // Receipt semantics (established empirically against the live TeeML provider,
  // re-verified on every call): sig.text is
  //   `${requestHash}:${responseHash}:${providerType}:${providerIdentity}:${tlsCertFingerprint}`
  // where responseHash = sha256(raw response body exactly as delivered to us).
  // The ECDSA signature covers sig.text and recovers to the attested TEE signer
  // (checked above). Binding chain: TDX quote -> TEE signer -> sig.text -> raw bytes we hold.
  const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  const parts = sig.text.split(":");
  if (parts.length !== 5) {
    throw new Error(`0G Compute: unexpected receipt format (${parts.length} fields): ${sig.text.slice(0, 200)}`);
  }
  const [receiptRequestHash, receiptResponseHash, providerType, providerIdentity, tlsCertFingerprint] = parts;
  const rawBodySha256 = sha256hex(rawBody);
  if (receiptResponseHash !== rawBodySha256) {
    throw new Error(
      `0G Compute: receipt response-hash mismatch — signed ${receiptResponseHash}, ` +
        `local sha256(rawBody) ${rawBodySha256}. The signature does NOT cover the response we received.`,
    );
  }
  // Request side: we sign our request via 0G billing headers; the receipt echoes a
  // provider-computed request hash. Record whether it is recomputable from our bytes.
  let requestHashSerialization = "provider-internal (not recomputable from client bytes)";
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k2, v2]) => [k2, sortKeys(v2)]),
          )
        : v;
  for (const [name, value] of Object.entries({
    "compact-json": bodyJson,
    "compact-json+newline": bodyJson + "\n",
    "sorted-compact-json": JSON.stringify(sortKeys(requestBody)),
  })) {
    if (sha256hex(value) === receiptRequestHash) {
      requestHashSerialization = name;
      break;
    }
  }

  const processResponseResult = await broker.inference.processResponse(
    sel.provider,
    chatID,
    JSON.stringify(usage),
  );
  if (processResponseResult !== true) {
    throw new Error(`0G Compute: processResponse did not verify (got ${String(processResponseResult)})`);
  }

  return {
    content,
    chatID,
    usage,
    signature: { text: sig.text, signature: sig.signature },
    effectiveSigner: sel.effectiveSigner,
    recoveredSigner,
    signatureValid,
    receipt: {
      requestHash: receiptRequestHash,
      responseHash: receiptResponseHash,
      providerType,
      providerIdentity,
      tlsCertFingerprint,
      responseHashMatchesRawBody: true,
      requestHashSerialization,
    },
    rawBodySha256,
    rawBody,
    requestBodyJson: bodyJson,
    requestHeaders: usedHeaders,
    processResponseResult,
    latencyMs: Date.now() - t0,
  };
}

/**
 * Full TEE remote attestation for a provider. Hard-fails.
 *
 * SDK 0.9.0 reality (verified against the shipped lib): the quote↔signer
 * binding is validated INSIDE verifyService (dcap quote validation, compose
 * hash, signing-address comparison); Provider.getQuote returns an empty
 * signingAddress by design. So we (a) hard-require verifyService success,
 * (b) archive the raw TDX quote via downloadQuoteReport and hash it as
 * evidence, (c) bind per-move signature checks to sel.effectiveSigner.
 */
export async function attestService(
  broker: Broker,
  sel: ComputeSelection,
  reportsDir: string,
): Promise<{ verifySuccess: boolean; boundSigner: string; rawQuoteHash: string; quoteFile: string }> {
  const verification = (await broker.inference.verifyService(sel.provider, reportsDir)) as unknown as
    | (Record<string, unknown> & { success?: boolean })
    | null;
  if (!verification || verification.success !== true) {
    throw new Error(
      `0G Compute: verifyService did not succeed — TEE remote attestation failed ` +
        `(got: ${JSON.stringify(verification).slice(0, 300)})`,
    );
  }
  const quoteFile = resolve(reportsDir, `raw-quote-${sel.provider.toLowerCase()}.json`);
  const dl = broker.inference as unknown as {
    downloadQuoteReport: (providerAddress: string, outputPath: string) => Promise<void>;
  };
  await dl.downloadQuoteReport(sel.provider, quoteFile);
  const rawQuote = readFileSync(quoteFile, "utf8");
  if (!rawQuote || rawQuote.trim().length < 100) {
    throw new Error("0G Compute: downloaded TDX quote is empty/truncated — cannot archive evidence");
  }
  if (!sel.effectiveSigner || sel.effectiveSigner === ethers.ZeroAddress) {
    throw new Error("0G Compute: no effective TEE signer to bind per-move signatures to");
  }
  return {
    verifySuccess: true,
    boundSigner: sel.effectiveSigner,
    rawQuoteHash: canonicalHash(rawQuote),
    quoteFile,
  };
}
