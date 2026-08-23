/**
 * FairMate server — one process serves the API (referee) and the web app.
 * Development: vite middleware. Production: prebuilt dist/public.
 *
 * Production env: PORT, BASE_PATH, OG_CHAIN_NETWORK=mainnet,
 * OG_COMPUTE_TRANSPORT=router, OG_ROUTER_API_KEY, OG_WALLET_PRIVATE_KEY,
 * OG_JOURNAL_ADDRESS and OG_POT_ADDRESS. Development defaults are explicitly
 * isolated to Galileo + direct Compute and are never selected in production.
 */
import { createServer } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { createApiApp } from "./app.js";
import { retryComputeBoot } from "./compute-service.js";
import { recoverReferee, startRecoveredModels, sweepIdleGames } from "./referee.js";

const PORT = Number(process.env.PORT ?? 3000);
const rawBase = process.env.BASE_PATH ?? "/";
const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
const root = resolve(import.meta.dirname, "..");

async function main() {
  // Resolve durable outbox entries and verify active/startup-pending games
  // before traffic. Completed history is verified on evidence export.
  await recoverReferee();
  const app = createApiApp(base);
  const httpServer = createServer(app);

  if (process.env.NODE_ENV === "production") {
    const publicDir = resolve(root, "dist/public");
    app.use(base, express.static(publicDir));
    // SPA fallback for anything under base that isn't a file or the API
    app.use(base, (_req, res) => {
      res.sendFile(resolve(publicDir, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      configFile: resolve(root, "vite.config.ts"),
      // hmr.server lets the websocket upgrade ride our own http server, so
      // hot reload works through the proxied base path
      server: { middlewareMode: true, hmr: { server: httpServer } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] listening on ${PORT} (base ${base})`);
  });

  // TEE attestation + provider selection happens in the background; games are
  // rejected with 503 until it completes (never silently unverified). A
  // transient boot failure is retried by the sweep timer below.
  void retryComputeBoot(startRecoveredModels)?.catch((error) => {
    console.error(`[compute] initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  // abort abandoned games so they don't hold active-game slots forever, and
  // re-attempt a failed compute boot (self-throttled, no-op once ready)
  setInterval(() => {
    void retryComputeBoot(startRecoveredModels)?.catch((error) => {
      console.error(`[compute] boot retry failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    void sweepIdleGames().catch((error) => {
      console.error(`[referee] idle sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 60_000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
