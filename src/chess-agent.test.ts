import assert from "node:assert/strict";
import test from "node:test";
import { buildMoveUserPrompt, parseMove } from "./chess-agent";

test("accepts an exact legal SAN from strict JSON", () => {
  assert.deepEqual(parseMove('{"move":"Nf6","why":"Develops with tempo"}', ["Nf6", "e5"]), {
    san: "Nf6",
    why: "Develops with tempo",
    via: "json",
  });
});

test("normalizes only check and mate suffixes against the authoritative legal list", () => {
  assert.equal(parseMove('{"move":"Qh7"}', ["Qh7#"])?.san, "Qh7#");
  assert.equal(parseMove('{"move":"Qh7#"}', ["Qh7+"])?.san, "Qh7+");
});

test("rejects prose that merely mentions a legal move", () => {
  assert.equal(parseMove("I would play Nf6 because it develops.", ["Nf6", "e5"]), null);
});

test("accepts a bare SAN only when the entire response is the move", () => {
  assert.equal(parseMove("```json\nO-O\n```", ["O-O"])?.san, "O-O");
  assert.equal(parseMove("O-O now", ["O-O"]), null);
});

test("prompt binds FEN, legal SANs, history and corrective feedback", () => {
  const prompt = buildMoveUserPrompt({
    fen: "8/8/8/8/8/8/8/K6k b - - 0 1",
    turn: "b",
    fullmoveNumber: 1,
    legalSans: ["Kg2", "Kh2"],
    recentHistory: ["Ka1"],
    feedback: "choose one listed move",
  });
  assert.match(prompt, /Position \(FEN\): 8\/8\/8\/8\/8\/8\/8\/K6k b - - 0 1/);
  assert.match(prompt, /Legal moves: Kg2 Kh2/);
  assert.match(prompt, /Recent moves: Ka1/);
  assert.match(prompt, /CORRECTION: choose one listed move/);
});