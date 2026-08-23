import { ethers } from "ethers";
import { canonicalHash } from "../shared/canonical.js";
import type { GameState } from "../shared/protocol.js";
import type { JournalSnapshot } from "./chain.js";
import { resultEnum } from "./referee-state.js";

function equal(actual: unknown, expected: unknown, label: string): void {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`chain reconciliation mismatch for ${label}: ${actual} != ${expected}`);
  }
}

export function verifyJournalState(
  state: GameState,
  chain: JournalSnapshot,
  startFen: string,
): void {
  if (!chain.exists) throw new Error(`chain reconciliation: game ${state.gameId} does not exist`);
  if (chain.starts.length !== 1) {
    throw new Error(`expected exactly one GameStarted, got ${chain.starts.length}`);
  }
  const started = chain.starts[0];
  equal(started.startFenHash, canonicalHash(startFen), "start event FEN");
  equal(started.player, state.playerAddress ?? ethers.ZeroAddress, "start event player");
  equal(started.model, state.model, "start event model");
  equal(started.verificationIdentity, state.effectiveSigner, "start event verification identity");
  if (state.startTx.txHash) equal(started.txHash, state.startTx.txHash, "start tx hash");
  if (state.startTx.blockNumber !== undefined) {
    equal(started.blockNumber, state.startTx.blockNumber, "start block");
  }
  equal(chain.startFenHash, canonicalHash(startFen), "start FEN");
  equal(chain.player, state.playerAddress ?? ethers.ZeroAddress, "player");
  equal(chain.moveCount, state.plies.length, "move count");
  equal(chain.moves.length, state.plies.length, "move events");
  state.plies.forEach((ply, index) => {
    const event = chain.moves[index];
    equal(event.moveNo, ply.ply, `ply ${ply.ply} number`);
    equal(event.mover, ply.mover === "model" ? 1 : 0, `ply ${ply.ply} mover`);
    equal(event.fenBeforeHash, ply.fenBeforeHash, `ply ${ply.ply} before`);
    equal(event.fenAfterHash, ply.fenAfterHash, `ply ${ply.ply} after`);
    equal(event.san, ply.san, `ply ${ply.ply} SAN`);
    equal(event.receiptHash, ply.receiptHash ?? ethers.ZeroHash, `ply ${ply.ply} receipt`);
  });
  if ((state.status === "ended" || state.status === "fault") && state.endTx?.status === "failed") {
    if (chain.ended || chain.result !== 0) throw new Error("failed local end is terminal on-chain");
  } else if (state.status === "ended" || state.status === "fault") {
    if (!chain.ended) throw new Error("terminal game has no GameEnded");
    equal(chain.ended.result, resultEnum(state.result), "result");
    equal(chain.ended.moveCount, state.plies.length, "ended move count");
    equal(chain.ended.finalFenHash, canonicalHash(state.fen), "final FEN");
    if (state.awardTx?.status === "confirmed" && !chain.rewarded) {
      throw new Error("confirmed award is not on-chain");
    }
  } else if (chain.ended || chain.result !== 0) {
    throw new Error("active game is ended on-chain");
  }
}