import express from "express";
import { api } from "./routes.js";

/**
 * The API application, shared by the resident server (server/index.ts) and
 * the serverless entry (api/index.ts). Static assets are the host's job:
 * the resident server serves dist/public itself, serverless hosts serve the
 * same directory from their CDN.
 */
export function createApiApp(base: string): express.Express {
  const app = express();
  // Deployed behind exactly one reverse-proxy hop.
  // Never trust an arbitrary X-Forwarded-For chain supplied by the client.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "128kb" }));
  app.use(`${base}api`, api);
  return app;
}
