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
import { api } from "./routes";
import { initCompute } from "./compute-service";
import { recoverReferee, startRecoveredModels, sweepIdleGames } from "./referee";

const PORT = Number(process.env.PORT ?? 3000);
const rawBase = process.env.BASE_PATH ?? "/";
const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
const root = resolve(import.meta.dirname, "..");

async function main() {
  // Resolve durable outbox entries and verify active/startup-pending games
  // before traffic. Completed history is verified on evidence export.
  await recoverReferee();
  const app = express();
  // Production is deployed behind exactly one reverse-proxy hop.
  // Never trust an arbitrary X-Forwarded-For chain supplied by the client.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "128kb" }));

  app.use(`${base}api`, api);
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
  // rejected with 503 until it completes (never silently unverified).
  void initCompute()
    .then(() => startRecoveredModels())
    .catch((error) => {
      console.error(`[compute] initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    });

  // abort abandoned games so they don't hold active-game slots forever
  setInterval(() => {
    void sweepIdleGames().catch((error) => {
      console.error(`[referee] idle sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 60_000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
