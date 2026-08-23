/**
 * Compute service singleton — owns the 0G Compute broker, provider selection,
 * boot-time TEE remote attestation, and a lock that serializes inference calls
 * (the provider enforces 10 req/min; concurrent games must not race the pacer).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  attestService,
  createBroker,
  acknowledge,
  selectProvider,
  verifiedCompletion,
  type Broker,
  type ComputeSelection,
  type VerifiedCompletion,
} from "../src/compute.js";
import {
  discoverRouterSelection,
  routerCompletion,
  type RouterCompletion,
  type RouterSelection,
} from "../src/router-compute.js";
import { NETWORKS, EVIDENCE_DIR, type NetworkConfig } from "../src/config.js";
import { loadPrivateKey } from "../src/keys.js";
import type { AttestationInfo, VerificationScheme } from "../shared/protocol.js";

export type ComputeTransport = "direct" | "router";

export interface ComputeSelectionSummary {
  model: string;
  provider: string;
  effectiveSigner: string;
  verificationScheme: VerificationScheme;
}

export type ComputeCompletion =
  | { transport: "direct"; value: VerifiedCompletion }
  | { transport: "router"; value: RouterCompletion };

export interface ComputeState {
  ready: boolean;
  bootError: string | null;
  net: NetworkConfig;
  transport: ComputeTransport;
  selection: ComputeSelectionSummary | null;
  attestation: AttestationInfo | null;
}

const production = process.env.NODE_ENV === "production";
const transport = (process.env.OG_COMPUTE_TRANSPORT ?? (production ? "router" : "direct")) as ComputeTransport;
const netName = (process.env.OG_COMPUTE_NETWORK ??
  process.env.OG_TARGET_NETWORK ??
  (production ? "mainnet" : "testnet")) as "testnet" | "mainnet";
const state: ComputeState = {
  ready: false,
  bootError: null,
  net: NETWORKS[netName],
  transport,
  selection: null,
  attestation: null,
};

let broker: Broker | null = null;
let directSelection: ComputeSelection | null = null;
let routerSelection: RouterSelection | null = null;

// serialize all inference calls (pacing lives in verifiedCompletion; the lock
// prevents two games from checking the pacer concurrently)
let computeChain: Promise<unknown> = Promise.resolve();
function withComputeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = () => fn();
  const p = computeChain.then(run, run);
  computeChain = p.catch(() => undefined);
  return p;
}

/** Boot: broker + provider + attestation. Called from server start (async); rerunnable. */
export async function initCompute(): Promise<void> {
  try {
    state.bootError = null;
    if (transport !== "direct" && transport !== "router") {
      throw new Error(`Invalid OG_COMPUTE_TRANSPORT '${String(transport)}'; expected direct|router`);
    }
    if (production && transport !== "router") {
      throw new Error("Production FairMate requires OG_COMPUTE_TRANSPORT=router; direct Compute is development-only");
    }

    if (transport === "router") {
      routerSelection = await discoverRouterSelection();
      state.selection = {
        model: routerSelection.model,
        provider: routerSelection.provider,
        effectiveSigner: routerSelection.effectiveSigner,
        verificationScheme: "router-teetls",
      };
      const metadata = routerSelection.metadata;
      state.attestation = {
        provider: routerSelection.provider,
        model: routerSelection.model,
        effectiveSigner: routerSelection.effectiveSigner,
        verificationScheme: "router-teetls",
        quote: metadata,
        verifiedAt: Date.now(),
        notes: [
          "0G Router registry reports trust_mode=verified and tee_attested=true",
          `provider is pinned to ${routerSelection.provider}; provider drift fails closed`,
          "every move requests verify_tee=true and requires x_0g_trace.tee_verified=true",
          "exact request bytes, response bytes, Router trace and billing are hash-bound into the on-chain move receipt",
        ],
        trustBoundary:
          "0G Router verifies the provider TeeTLS signature and returns tee_verified=true. Router responses do not expose the raw provider signature, so FairMate independently checks byte/trace/commitment integrity but does not claim browser-side signature recovery.",
      };
      state.ready = true;
      console.log(
        `[compute] ready — Router provider ${routerSelection.provider} model ${routerSelection.model} scheme router-teetls`,
      );
      return;
    }

    const pk = loadPrivateKey();
    broker = await createBroker(state.net, pk);
    const explicit = process.env.OG_PROVIDER ?? undefined;
    const { selected } = await selectProvider(broker, explicit);
    directSelection = selected;
    state.selection = {
      model: selected.model,
      provider: selected.provider,
      effectiveSigner: selected.effectiveSigner,
      verificationScheme: "direct-teeml",
    };
    await acknowledge(broker, selected.provider);

    const reportsDir = resolve(EVIDENCE_DIR, "attestation");
    mkdirSync(reportsDir, { recursive: true });
    const att = await attestService(broker, selected, reportsDir);

    let quote: unknown = null;
    try {
      quote = JSON.parse(readFileSync(att.quoteFile, "utf8"));
    } catch {
      quote = { note: "raw quote file could not be parsed as JSON", file: att.quoteFile };
    }
    state.attestation = {
      provider: selected.provider,
      model: selected.model,
      effectiveSigner: selected.effectiveSigner,
      verificationScheme: "direct-teeml",
      quote,
      verifiedAt: Date.now(),
      notes: [
        "verifyService() performed full TDX quote validation and quote-to-signer binding (SDK-internal)",
        `raw quote archived, canonical hash ${att.rawQuoteHash}`,
        `per-move receipts are verified against effective signer ${selected.effectiveSigner}`,
      ],
      trustBoundary:
        "Direct TeeML receipts expose the raw provider signature. FairMate recomputes the response hash and recovers the attested signing address in the browser and offline verifier.",
    };
    state.ready = true;
    console.log(
      `[compute] ready — provider ${selected.provider} model ${selected.model} signer ${selected.effectiveSigner}`,
    );
  } catch (err) {
    state.bootError = err instanceof Error ? err.message : String(err);
    console.error(`[compute] BOOT FAILED: ${state.bootError}`);
  }
}

export function getComputeState(): ComputeState {
  return state;
}

let initInFlight: Promise<void> | null = null;
let lastInitAttemptAt = 0;
const INIT_RETRY_COOLDOWN_MS = Number(process.env.OG_COMPUTE_RETRY_MS ?? 30_000);

/**
 * Starts (or restarts) the compute boot unless it is ready, already in
 * flight, or inside the retry cooldown. Returns the in-flight promise when a
 * boot was started, null otherwise. initCompute never rejects — without this,
 * one transient Router failure would leave an instance permanently serving
 * 503s for game creation while its health endpoint stays green.
 */
export function retryComputeBoot(onReady: () => Promise<void>): Promise<void> | null {
  if (state.ready || initInFlight) return null;
  const now = Date.now();
  if (now - lastInitAttemptAt < INIT_RETRY_COOLDOWN_MS) return null;
  lastInitAttemptAt = now;
  initInFlight = initCompute()
    .then(() => (state.ready ? onReady() : undefined))
    .finally(() => {
      initInFlight = null;
    });
  return initInFlight;
}

/** One verified inference call, serialized behind the global compute lock. */
export function completion(
  messages: Array<{ role: string; content: string }>,
  temperature: number,
): Promise<ComputeCompletion> {
  if (!state.ready || !state.selection) {
    throw new Error("compute not ready");
  }
  if (state.transport === "router") {
    if (!routerSelection) throw new Error("Router selection missing after compute initialization");
    const sel = routerSelection;
    return withComputeLock(async () => ({
      transport: "router" as const,
      value: await routerCompletion(sel, messages, temperature),
    }));
  }
  if (!broker || !directSelection) throw new Error("direct broker/selection missing after compute initialization");
  const b = broker;
  const sel = directSelection;
  return withComputeLock(async () => ({
    transport: "direct" as const,
    value: await verifiedCompletion(b, sel, messages, temperature),
  }));
}
