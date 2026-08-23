/**
 * Serverless entry (Vercel). The same referee runs here with one adaptation:
 * trailing background work — anchor drains, model inference, idle sweeps —
 * is pinned to the invocation via waitUntil instead of relying on a resident
 * event loop. Postgres remains the source of truth for outbox order, wallet
 * nonces, inference leases and admission, so any number of concurrent
 * instances stay safe (proven by the two-replica tests).
 *
 * Boot per instance: recover the referee before serving traffic, then run
 * TEE attestation in the background; games are rejected with 503 until it
 * completes (never silently unverified). A failed boot is retried on the
 * next request instead of poisoning the instance.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { createApiApp } from "../server/app.js";
import { background, setBackgroundKeeper } from "../server/background.js";
import { initCompute } from "../server/compute-service.js";
import { recoverReferee, startRecoveredModels, sweepIdleGames } from "../server/referee.js";

setBackgroundKeeper((work) => waitUntil(work));

const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;
let bootPromise: Promise<void> | null = null;

const app = createApiApp("/") as unknown as (
  req: IncomingMessage,
  res: ServerResponse,
) => void;

function ensureBoot(): Promise<void> {
  if (!bootPromise) {
    bootPromise = (async () => {
      await recoverReferee();
      background("compute init", initCompute().then(() => startRecoveredModels()));
    })().catch((error) => {
      bootPromise = null;
      throw error;
    });
  }
  return bootPromise;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await ensureBoot();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[serverless] boot failed: ${message}`);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "referee recovery is not complete" }));
    return;
  }
  const now = Date.now();
  if (now - lastSweepAt > SWEEP_INTERVAL_MS) {
    lastSweepAt = now;
    background("idle sweep", sweepIdleGames());
  }
  app(req, res);
}
