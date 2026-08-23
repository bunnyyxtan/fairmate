import { Router, type Request } from "express";
import type { ApiError, PotInfo } from "../shared/protocol.js";
import { getComputeState } from "./compute-service.js";
import { chainInfo, readPot, refereeAddress } from "./chain.js";
import {
  ENTRY_FEE_OG,
  RefereeError,
  createGame,
  gameEvidence,
  getGame,
  playerMove,
  resign,
} from "./referee.js";

export const api = Router();

function clientIp(req: Request): string {
  return req.ip ?? "unknown";
}

function gameAccessToken(req: Request): string | undefined {
  const value = req.get("x-fairmate-game-token");
  return value?.trim() || undefined;
}

function fail(res: { status: (code: number) => { json: (b: ApiError) => void } }, err: unknown): void {
  if (err instanceof RefereeError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[api] 500: ${msg}`);
  res.status(500).json({ error: "internal error" });
}

api.get("/health", (_req, res) => {
  const c = getComputeState();
  res.json({ ok: true, attestationReady: c.ready, bootError: c.bootError });
});

api.get("/pot", async (_req, res) => {
  try {
    const c = getComputeState();
    const reads = await readPot();
    const info: PotInfo = {
      chain: chainInfo(),
      ...reads,
      entryFeeOg: ENTRY_FEE_OG,
      refereeAddress: refereeAddress(),
      model: c.selection?.model ?? "",
      provider: c.selection?.provider ?? "",
      effectiveSigner: c.selection?.effectiveSigner ?? "",
      verificationScheme: c.selection?.verificationScheme ?? "router-teetls",
      attestationReady: c.ready,
    };
    res.json(info);
  } catch (err) {
    fail(res, err);
  }
});

api.get("/attestation", (_req, res) => {
  const c = getComputeState();
  if (!c.attestation) {
    res.status(503).json({ error: c.bootError ?? "attestation in progress" });
    return;
  }
  res.json(c.attestation);
});

api.post("/games", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { playerAddress?: string; stakeTxHash?: string };
    res.status(201).json(await createGame(clientIp(req), body.playerAddress, body.stakeTxHash));
  } catch (err) {
    fail(res, err);
  }
});

api.get("/games/:id", async (req, res) => {
  try {
    res.json(await getGame(req.params.id, gameAccessToken(req)));
  } catch (err) {
    fail(res, err);
  }
});

api.post("/games/:id/moves", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { san?: string };
    if (typeof body.san !== "string" || body.san.length === 0 || body.san.length > 12) {
      res.status(400).json({ error: "body must be { san: string }" });
      return;
    }
    res.json(await playerMove(req.params.id, body.san, gameAccessToken(req)));
  } catch (err) {
    fail(res, err);
  }
});

api.post("/games/:id/resign", async (req, res) => {
  try {
    res.json(await resign(req.params.id, gameAccessToken(req)));
  } catch (err) {
    fail(res, err);
  }
});

api.get("/games/:id/evidence", async (req, res) => {
  try {
    const bundle = await gameEvidence(req.params.id, gameAccessToken(req));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="fairmate-game-${req.params.id.slice(2, 10)}.json"`,
    );
    res.json(bundle);
  } catch (err) {
    fail(res, err);
  }
});
