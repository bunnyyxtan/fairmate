/**
 * DEV-ONLY design preview harness (never served in production builds).
 *
 * The real game screen requires a funded mainnet match (start tx + Router
 * inference + per-ply anchors), so visual work iterates here instead:
 *   /?preview=turn      — your move, journal fully in sync
 *   /?preview=anchor    — you play ON while two anchors settle in background
 *   /?preview=thinking  — Qwen thinking, model clock burning, anchor trailing
 *   /?preview=settling  — you won; end + award anchors still confirming
 *   /?preview=resigning — resignation request in flight (sub-second)
 *   /?preview=win       — PrizeMoment (award confirmed)
 *   /?preview=loss      — HonestResult (model win)
 * Every value below is a clearly-fake fixture; nothing touches the API.
 */
import type { GameState, PlyRecord, PotInfo } from "@shared/protocol";
import { ExternalLink } from "lucide-react";
import { GameView } from "./GameView";
import { Brand } from "./Lobby";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const AFTER_E4_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2";

const chain = {
  network: "Aristotle Mainnet",
  chainId: 16661,
  explorer: "https://chainscan.0g.ai",
  journalAddress: "0x78718E892705129417636F70ceE11A97ca5AD726",
  potAddress: "0x9BD5f06Ce7aB22dfF739Ed2b2886BfB49acc69Ef",
};

const pot: PotInfo = {
  chain,
  potBalanceOg: "2.90",
  perWinBountyOg: "0.1",
  dailyCapOg: "0.5",
  paidInWindowOg: "0.0",
  windowStart: Date.now() - 3_600_000,
  refereeAddress: "0x9fB13bD57b1b31d25E2d2b2B04cEea50e0B256C8",
  model: "qwen3.7-max",
  provider: "0xF203A388e9E70F09ece38046a6D40a89cf896309",
  effectiveSigner: "0xF203A388e9E70F09ece38046a6D40a89cf896309",
  verificationScheme: "router-teetls",
  attestationReady: true,
};

const FAKE_HASH = `0x${"f1".repeat(32)}`;

function humanPly(confirmed: boolean): PlyRecord {
  return {
    ply: 1,
    mover: "player",
    san: "e4",
    fenBefore: START_FEN,
    fenAfter: AFTER_E4,
    fenBeforeHash: FAKE_HASH,
    fenAfterHash: FAKE_HASH,
    receiptHash: null,
    chain: confirmed ? { status: "confirmed", txHash: FAKE_HASH, blockNumber: 12_345_678, moveNo: 1 } : { status: "pending", moveNo: 1 },
    at: Date.now() - 30_000,
  };
}

function modelPly(confirmed: boolean): PlyRecord {
  return {
    ply: 2,
    mover: "model",
    san: "c5",
    fenBefore: AFTER_E4,
    fenAfter: AFTER_E4_C5,
    fenBeforeHash: FAKE_HASH,
    fenAfterHash: FAKE_HASH,
    receiptHash: FAKE_HASH,
    chain: confirmed ? { status: "confirmed", txHash: FAKE_HASH, blockNumber: 12_345_680, moveNo: 2 } : { status: "pending", moveNo: 2 },
    at: Date.now() - 8_000,
  };
}

function base(): GameState {
  return {
    gameId: `0x${"preview0".repeat(8)}`,
    playerAddress: "0x1111111111111111111111111111111111111111",
    playerColor: "w",
    fen: START_FEN,
    sans: [],
    status: "awaiting_player",
    result: "ongoing",
    clock: { initialMs: 300_000, playerMs: 300_000, modelMs: 300_000, active: "player", activeSince: Date.now() - 12_000 },
    plies: [],
    chain,
    startTx: { status: "confirmed", txHash: FAKE_HASH, blockNumber: 12_345_600 },
    model: "qwen3.7-max",
    provider: pot.provider,
    effectiveSigner: pot.effectiveSigner,
    verificationScheme: "router-teetls",
    computeCostNeuron: "0",
    createdAt: Date.now() - 90_000,
    updatedAt: Date.now() - 1_000,
  };
}

function fixture(phase: string): { game: GameState; pendingAction: "move" | "resign" | null } {
  const game = base();
  switch (phase) {
    case "anchor": {
      // Your turn again while both earlier anchors are still confirming:
      // the board never waits for the chain.
      game.fen = AFTER_E4_C5;
      game.sans = ["e4", "c5"];
      game.plies = [humanPly(false), modelPly(false)];
      game.clock = { ...game.clock, playerMs: 277_000, modelMs: 288_000, active: "player", activeSince: Date.now() - 8_000 };
      return { game, pendingAction: null };
    }
    case "thinking": {
      game.status = "model_thinking";
      game.fen = AFTER_E4;
      game.sans = ["e4"];
      game.plies = [humanPly(false)];
      game.clock = { ...game.clock, playerMs: 277_000, modelMs: 300_000, active: "model", activeSince: Date.now() - 23_000 };
      return { game, pendingAction: null };
    }
    case "settling": {
      game.status = "ended";
      game.result = "player_win";
      game.endReason = "qwen3.7-max ran out of time";
      game.fen = AFTER_E4_C5;
      game.sans = ["e4", "c5"];
      game.plies = [humanPly(true), modelPly(true)];
      game.clock = { ...game.clock, playerMs: 61_000, modelMs: 0, active: null, activeSince: null };
      game.endTx = { status: "pending" };
      game.awardTx = { status: "pending" };
      return { game, pendingAction: null };
    }
    case "resigning": {
      game.fen = AFTER_E4;
      game.sans = ["e4"];
      game.plies = [humanPly(true)];
      game.clock = { ...game.clock, playerMs: 231_000, modelMs: 252_000, active: "player", activeSince: Date.now() - 4_000 };
      return { game, pendingAction: "resign" };
    }
    case "win": {
      game.status = "ended";
      game.result = "player_win";
      game.endReason = "qwen3.7-max ran out of time";
      game.clock = { ...game.clock, playerMs: 61_000, modelMs: 0, active: null, activeSince: null };
      game.endTx = { status: "confirmed", txHash: FAKE_HASH, blockNumber: 12_345_999 };
      game.awardTx = { status: "confirmed", txHash: FAKE_HASH, blockNumber: 12_346_000, amountOg: "0.1" };
      return { game, pendingAction: null };
    }
    case "loss": {
      game.status = "ended";
      game.result = "model_win";
      game.endReason = "checkmate";
      game.clock = { ...game.clock, playerMs: 44_000, modelMs: 173_000, active: null, activeSince: null };
      game.endTx = { status: "confirmed", txHash: FAKE_HASH, blockNumber: 12_345_999 };
      return { game, pendingAction: null };
    }
    default:
      return { game, pendingAction: null };
  }
}

export function GamePreview({ phase }: { phase: string }) {
  const { game, pendingAction } = fixture(phase);
  const noop = () => undefined;
  return (
    <div className="fm fm-challenge-lobby">
      <header className="cl-nav">
        <Brand />
        <nav aria-label="Primary"><a href="#challenge">Challenge</a><button type="button">How it stays fair</button><a href="#contracts">On-chain</a></nav>
        <span className="fm-network"><i />{chain.network} · {chain.chainId}</span>
      </header>
      <main>
        <GameView
          game={game}
          pot={pot}
          accessToken=""
          submitting={pendingAction !== null}
          pendingAction={pendingAction}
          error={null}
          onMove={noop}
          onResign={noop}
          onReplay={noop}
          onLobby={noop}
        />
      </main>
      <footer id="contracts"><Brand compact /><span>Verifiable chess, built on 0G.</span><a href={chain.explorer} target="_blank" rel="noreferrer">Open {chain.network} explorer <ExternalLink size={16} /></a></footer>
    </div>
  );
}
