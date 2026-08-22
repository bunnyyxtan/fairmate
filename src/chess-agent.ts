/**
 * Chess move agent: prompt construction + robust SAN parsing against the
 * legal-move list. The model is ALWAYS constrained to the legal list — the
 * receipt claim is about provenance (which model, which input), never about
 * unconstrained play. Illegal/garbled replies get bounded retries with
 * corrective feedback; exhausting retries is a HARD FAIL (no random-move
 * fallback — that would fake the product).
 */

export const CHESS_SYSTEM_PROMPT = [
  "You are FairMate, a chess engine playing a serious game.",
  "You are given the position as FEN and the complete list of legal moves in SAN.",
  "Choose the strongest move for the side to move.",
  'Respond with ONLY a JSON object: {"move":"<one SAN exactly as it appears in the legal list>","why":"<max 12 words>"}',
  "No markdown, no code fences, no other text.",
].join(" ");

export function buildMoveUserPrompt(params: {
  fen: string;
  turn: "w" | "b";
  fullmoveNumber: number;
  legalSans: string[];
  recentHistory: string[];
  feedback?: string;
}): string {
  const { fen, turn, fullmoveNumber, legalSans, recentHistory, feedback } = params;
  const lines = [
    `Position (FEN): ${fen}`,
    `Side to move: ${turn === "w" ? "White" : "Black"}`,
    `Move number: ${fullmoveNumber}`,
    `Legal moves: ${legalSans.join(" ")}`,
  ];
  if (recentHistory.length > 0) lines.push(`Recent moves: ${recentHistory.join(" ")}`);
  if (feedback) lines.push(`CORRECTION: ${feedback}`);
  lines.push("Pick exactly one move from the legal list.");
  return lines.join("\n");
}

export interface ParsedMove {
  san: string;
  why: string;
  /** how the move was recovered from the reply */
  via: "json" | "json-normalized" | "bare-san";
}

/** Parse a model reply into a legal SAN, or null if unrecoverable. */
export function parseMove(content: string, legalSans: string[]): ParsedMove | null {
  let t = content.trim();
  // strip accidental code fences despite instructions
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  // 1) strict JSON
  try {
    const j = JSON.parse(t) as { move?: unknown; why?: unknown };
    if (j && typeof j.move === "string") {
      const m = j.move.trim();
      const why = typeof j.why === "string" ? j.why : "";
      if (legalSans.includes(m)) return { san: m, why, via: "json" };
      // normalize check/mate suffixes both ways
      const strip = (s: string) => s.replace(/[+#]/g, "");
      const norm = legalSans.find((s) => strip(s) === strip(m));
      if (norm) return { san: norm, why, via: "json-normalized" };
    }
  } catch {
    /* fall through to text scan */
  }

  // 2) strict fallback: the ENTIRE reply (sans fences) is a single legal SAN.
  // A reply that merely mentions a legal move inside prose is NOT an
  // unambiguous choice and must not be counted as one.
  const stripSuffix = (s: string) => s.replace(/[+#]/g, "");
  const exact = legalSans.find((s) => s === t || stripSuffix(s) === stripSuffix(t));
  if (exact) return { san: exact, why: "", via: "bare-san" };
  return null;
}
