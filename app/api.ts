import type { AttestationInfo, GameState, PotInfo } from "@shared/protocol";

const apiRoot = `${import.meta.env.BASE_URL}api`;

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiRoot}/${path}`, {
      ...init,
      headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeout(error)) {
      throw new ApiFailure("The request timed out, the game will re-sync automatically.", 0);
    }
    throw error;
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string; detail?: string };
      message = body.error ?? message;
      if (body.detail) message += `: ${body.detail}`;
    } catch {
      // Preserve the explicit HTTP failure above when a proxy returns non-JSON.
    }
    throw new ApiFailure(message, response.status);
  }
  return response.json() as Promise<T>;
}

export interface Health {
  ok: boolean;
  attestationReady: boolean;
  bootError?: string;
}

export interface CreatedGame {
  game: GameState;
  accessToken: string;
}

function gameHeaders(accessToken: string): HeadersInit {
  return { "X-FairMate-Game-Token": accessToken };
}

export const api = {
  health: () => request<Health>("health"),
  pot: () => request<PotInfo>("pot"),
  attestation: () => request<AttestationInfo>("attestation"),
  createGame: (playerAddress?: string) =>
    request<CreatedGame>("games", {
      method: "POST",
      body: JSON.stringify(playerAddress ? { playerAddress } : {}),
    }),
  game: (id: string, accessToken: string) =>
    request<GameState>(`games/${encodeURIComponent(id)}`, { headers: gameHeaders(accessToken) }),
  move: (id: string, san: string, accessToken: string) =>
    request<GameState>(`games/${encodeURIComponent(id)}/moves`, {
      method: "POST",
      body: JSON.stringify({ san }),
      headers: gameHeaders(accessToken),
    }),
  resign: (id: string, accessToken: string) =>
    request<GameState>(`games/${encodeURIComponent(id)}/resign`, {
      method: "POST",
      headers: gameHeaders(accessToken),
    }),
  downloadEvidence: async (id: string, accessToken: string) => {
    let response: Response;
    try {
      response = await fetch(`${apiRoot}/games/${encodeURIComponent(id)}/evidence`, {
        headers: gameHeaders(accessToken),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      if (isTimeout(error)) throw new ApiFailure("Evidence download timed out, retry shortly.", 0);
      throw error;
    }
    if (!response.ok) {
      let message = `Evidence download failed (${response.status})`;
      try {
        const body = (await response.json()) as { error?: string };
        message = body.error ?? message;
      } catch {
        // Keep the explicit HTTP error.
      }
      throw new ApiFailure(message, response.status);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fairmate-game-${id.slice(2, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  },
};

export function explorerUrl(base: string, type: "address" | "tx", value: string): string {
  return `${base.replace(/\/$/, "")}/${type}/${encodeURIComponent(value)}`;
}