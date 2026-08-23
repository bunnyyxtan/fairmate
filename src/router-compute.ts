import { ethers } from "ethers";
import { sha256Utf8 } from "../shared/canonical";
import { computeRouterReceiptHash } from "../shared/receipt";
import {
  FAIRMATE_ROUTER_MAX_COMPLETION_PRICE_USD,
  FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD,
  FAIRMATE_ROUTER_MODEL,
  FAIRMATE_ROUTER_PROVIDER,
} from "../shared/router-policy";
import type {
  RouterReceiptBundle,
  RouterRequestConstraints,
  RouterTrace,
} from "../shared/protocol";
import { requireSecret } from "./config";

export const ROUTER_BASE_URL = "https://router-api.0g.ai/v1";
export const ROUTER_MODEL = FAIRMATE_ROUTER_MODEL;
export const ROUTER_PROVIDER = FAIRMATE_ROUTER_PROVIDER;
const MAX_OUTPUT_TOKENS = Number(process.env.FAIRMATE_MAX_OUTPUT_TOKENS ?? 800);
const REQUEST_TIMEOUT_MS = Number(process.env.FAIRMATE_MODEL_TIMEOUT_MS ?? 90_000);
export const ROUTER_MAX_PROMPT_PRICE_USD = FAIRMATE_ROUTER_MAX_PROMPT_PRICE_USD;
export const ROUTER_MAX_COMPLETION_PRICE_USD = FAIRMATE_ROUTER_MAX_COMPLETION_PRICE_USD;

export interface RouterProviderMetadata {
  address: string;
  canonical_id: string;
  model_id: string;
  is_healthy: boolean;
  verifiability?: string;
  trust_mode?: string;
  tee_acknowledged?: boolean;
  tee_attested?: boolean;
  tee_type?: string;
  tee_verifier?: string;
  provider_name?: string;
  provider_country?: string;
  serving_domain?: string;
  pricing_usd?: {
    prompt?: string;
    completion?: string;
  };
}

export interface RouterSelection {
  scheme: "router-teetls";
  model: string;
  provider: string;
  effectiveSigner: string;
  endpoint: string;
  verifiability: "TeeTLS";
  metadata: RouterProviderMetadata;
}

export interface RouterCompletion {
  content: string;
  receipt: RouterReceiptBundle;
  usage: Record<string, unknown>;
}

function exactProvider(list: RouterProviderMetadata[]): RouterProviderMetadata {
  const provider = list.find(
    (candidate) =>
      (candidate.canonical_id === ROUTER_MODEL || candidate.model_id === ROUTER_MODEL) &&
      candidate.address.toLowerCase() === ROUTER_PROVIDER.toLowerCase(),
  );
  if (!provider) {
    throw new Error(
      `0G Router: audited provider ${ROUTER_PROVIDER} for ${ROUTER_MODEL} is not listed; refusing provider drift`,
    );
  }
  if (
    provider.is_healthy !== true ||
    provider.verifiability !== "TeeTLS" ||
    provider.trust_mode !== "verified" ||
    provider.tee_attested !== true ||
    provider.tee_acknowledged !== true ||
    provider.tee_type !== "TDX" ||
    provider.tee_verifier !== "dstack"
  ) {
    throw new Error(
      `0G Router: provider ${provider.address} no longer satisfies the audited TeeTLS/TDX/dstack trust profile`,
    );
  }
  const prompt = Number(provider.pricing_usd?.prompt);
  const completion = Number(provider.pricing_usd?.completion);
  if (!Number.isFinite(prompt) || prompt > 0.0000009) {
    throw new Error(`0G Router: prompt price exceeds FairMate ceiling (${String(prompt)} USD/token)`);
  }
  if (!Number.isFinite(completion) || completion > 0.0000026) {
    throw new Error(`0G Router: completion price exceeds FairMate ceiling (${String(completion)} USD/token)`);
  }
  return provider;
}

export async function discoverRouterSelection(): Promise<RouterSelection> {
  // Require the key during boot, but never expose or log it.
  requireSecret(process.env, "OG_ROUTER_API_KEY");
  const response = await fetch(`${ROUTER_BASE_URL}/providers?model_id=${encodeURIComponent(ROUTER_MODEL)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`0G Router provider discovery failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { data?: RouterProviderMetadata[] };
  if (!Array.isArray(body.data)) throw new Error("0G Router provider discovery returned no data array");
  const provider = exactProvider(body.data);
  return {
    scheme: "router-teetls",
    model: ROUTER_MODEL,
    provider: ethers.getAddress(provider.address),
    effectiveSigner: ethers.getAddress(provider.address),
    endpoint: `${ROUTER_BASE_URL}/chat/completions`,
    verifiability: "TeeTLS",
    metadata: provider,
  };
}

interface RouterResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  usage?: Record<string, unknown>;
  x_0g_trace?: {
    request_id?: string;
    provider?: string;
    tee_verified?: boolean | null;
    billing?: {
      input_cost?: string;
      output_cost?: string;
      total_cost?: string;
    };
  };
}

export function parseRouterCompletion(params: {
  rawBody: string;
  requestBodyJson: string;
  selection: RouterSelection;
  latencyMs: number;
  requestConstraints?: RouterRequestConstraints;
}): RouterCompletion {
  let body: RouterResponse;
  try {
    body = JSON.parse(params.rawBody) as RouterResponse;
  } catch {
    throw new Error(`0G Router returned non-JSON: ${params.rawBody.slice(0, 160)}`);
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("0G Router returned no assistant content");
  }
  if (body.model !== params.selection.model) {
    throw new Error(
      `0G Router model drift: requested ${params.selection.model}, response named ${String(body.model)}`,
    );
  }
  const trace = body.x_0g_trace;
  if (!trace?.request_id || !trace.provider || !ethers.isAddress(trace.provider)) {
    throw new Error("0G Router response is missing a valid request_id/provider trace");
  }
  if (trace.provider.toLowerCase() !== params.selection.provider.toLowerCase()) {
    throw new Error(
      `0G Router provider drift: pinned ${params.selection.provider}, response used ${trace.provider}`,
    );
  }
  if (trace.tee_verified !== true) {
    throw new Error(
      `0G Router TeeTLS verification failed or was absent for request ${trace.request_id}`,
    );
  }
  const billing = trace.billing;
  if (
    typeof billing?.input_cost !== "string" ||
    typeof billing.output_cost !== "string" ||
    typeof billing.total_cost !== "string" ||
    !/^\d+$/.test(billing.input_cost) ||
    !/^\d+$/.test(billing.output_cost) ||
    !/^\d+$/.test(billing.total_cost)
  ) {
    throw new Error(`0G Router request ${trace.request_id} returned invalid billing metadata`);
  }

  const requestBodySha256 = sha256Utf8(params.requestBodyJson);
  const rawBodySha256 = sha256Utf8(params.rawBody);
  const normalizedTrace: RouterTrace = {
    requestId: trace.request_id,
    provider: ethers.getAddress(trace.provider),
    teeVerified: true,
    billing: {
      inputCostNeuron: billing.input_cost,
      outputCostNeuron: billing.output_cost,
      totalCostNeuron: billing.total_cost,
    },
  };
  const requestConstraints = params.requestConstraints ?? {
    providerAddress: params.selection.provider,
    maxPromptPriceUsd: ROUTER_MAX_PROMPT_PRICE_USD,
    maxCompletionPriceUsd: ROUTER_MAX_COMPLETION_PRICE_USD,
  };
  const receiptHash = computeRouterReceiptHash({
    model: params.selection.model,
    provider: params.selection.provider,
    requestBodySha256,
    rawBodySha256,
    requestConstraints,
    trace: normalizedTrace,
  });
  const receipt: RouterReceiptBundle = {
    scheme: "router-teetls",
    chatID: body.id ?? trace.request_id,
    model: params.selection.model,
    provider: params.selection.provider,
    effectiveSigner: params.selection.effectiveSigner,
    rawBody: params.rawBody,
    rawBodySha256,
    requestBodyJson: params.requestBodyJson,
    requestBodySha256,
    requestConstraints,
    trace: normalizedTrace,
    receiptHash,
    latencyMs: params.latencyMs,
  };
  return { content, receipt, usage: body.usage ?? {} };
}

export async function routerCompletion(
  selection: RouterSelection,
  messages: Array<{ role: string; content: string }>,
  temperature: number,
): Promise<RouterCompletion> {
  const apiKey = requireSecret(process.env, "OG_ROUTER_API_KEY");
  const requestBodyJson = JSON.stringify({
    model: selection.model,
    messages,
    temperature,
    max_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: "json_object" },
    enable_thinking: true,
    reasoning_effort: "medium",
    stream: false,
    verify_tee: true,
  });
  const startedAt = Date.now();
  const requestConstraints: RouterRequestConstraints = {
    providerAddress: selection.provider,
    maxPromptPriceUsd: ROUTER_MAX_PROMPT_PRICE_USD,
    maxCompletionPriceUsd: ROUTER_MAX_COMPLETION_PRICE_USD,
  };
  const response = await fetch(selection.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-0G-Provider-Address": requestConstraints.providerAddress,
      "X-0G-Provider-Max-Price-Usd-Prompt": requestConstraints.maxPromptPriceUsd,
      "X-0G-Provider-Max-Price-Usd-Completion": requestConstraints.maxCompletionPriceUsd,
    },
    body: requestBodyJson,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `0G Router inference failed: HTTP ${response.status} ${response.statusText} — ${rawBody.slice(0, 300)}`,
    );
  }
  return parseRouterCompletion({
    rawBody,
    requestBodyJson,
    selection,
    latencyMs: Date.now() - startedAt,
    requestConstraints,
  });
}