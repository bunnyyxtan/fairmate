import type { GameResult, GameState } from "@shared/protocol";
import { Check, Download, ExternalLink, ShieldCheck, TriangleAlert, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { api, explorerUrl } from "./api";
import { ChessBoard } from "./ChessBoard";
import { Dialog } from "./Dialog";
import { PrizeMoment } from "./PrizeMoment";
import { ReceiptPanel } from "./ReceiptPanel";

const stages = ["Studying the position", "Evaluating tactical lines", "Verifying the move", "Committing on 0G"];

function formatClock(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function displayedClock(game: GameState, side: "player" | "model", now: number) {
  const base = side === "player" ? game.clock.playerMs : game.clock.modelMs;
  if (game.clock.active !== side || game.clock.activeSince === null) return base;
  return Math.max(0, base - Math.max(0, now - game.clock.activeSince));
}

function HonestResult({
  game,
  onReplay,
  onLobby,
  onDownload,
  downloadError,
}: {
  game: GameState;
  onReplay: () => void;
  onLobby: () => void;
  onDownload: () => void;
  downloadError: string | null;
}) {
  const titles: Record<Exclude<GameResult, "ongoing" | "player_win">, string> = {
    model_win: "THE BOT WON.",
    draw: "DRAW AGREED.",
    aborted: "GAME ABORTED.",
  };
  const result = game.result === "ongoing" || game.result === "player_win" ? "aborted" : game.result;
  return (
    <section className="result-screen honest-result">
      <span className="cl-kicker">{result === "aborted" ? <TriangleAlert /> : <ShieldCheck />} Final result</span>
      <h1>{titles[result]}</h1>
      <p>{game.faultReason ?? game.endReason ?? "The journal has recorded the final position."}</p>
      {game.endTx?.status === "failed" && <p className="api-error" role="alert">Chain transaction failed: {game.endTx.error}</p>}
      <button type="button" className="evidence-link" onClick={onDownload}><Download /> Download game evidence</button>
      {downloadError && <p className="api-error" role="alert">{downloadError}</p>}
      <div className="result-actions"><button type="button" onClick={onReplay}>Play again</button><button type="button" onClick={onLobby}>Return to lobby</button></div>
    </section>
  );
}

export function GameView({
  game,
  accessToken,
  submitting,
  error,
  onMove,
  onResign,
  onReplay,
  onLobby,
}: {
  game: GameState;
  accessToken: string;
  submitting: boolean;
  error: string | null;
  onMove: (san: string) => void;
  onResign: () => void;
  onReplay: () => void;
  onLobby: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [resignOpen, setResignOpen] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  useEffect(() => {
    if (!game.clock.active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [game.clock.active]);

  const downloadEvidence = () => {
    setDownloadError(null);
    void api.downloadEvidence(game.gameId, accessToken).catch((downloadFailure) => {
      setDownloadError(
        downloadFailure instanceof Error ? downloadFailure.message : "Evidence download failed.",
      );
    });
  };

  if (game.result === "player_win") return <PrizeMoment game={game} onReplay={onReplay} onLobby={onLobby} onDownload={downloadEvidence} downloadError={downloadError} />;
  if (game.result !== "ongoing") return <HonestResult game={game} onReplay={onReplay} onLobby={onLobby} onDownload={downloadEvidence} downloadError={downloadError} />;

  const thinking = game.status === "model_thinking";
  const playerTurn = game.status === "awaiting_player" && game.clock.active === "player";
  const latest = game.plies.at(-1);
  return (
    <section className="cl-match" aria-label="Live match">
      <div className="cl-match-top"><button type="button" onClick={onLobby}>← Challenge lobby</button><span>Game {game.gameId.slice(0, 12)}…</span></div>
      <div className="cl-match-grid">
        <div className={`cl-live-board ${thinking ? "is-ai-turn" : ""}`}>
          <div className={`cl-clock cl-ai-clock ${game.clock.active === "model" ? "is-active" : ""}`}>
            <span><img src={`${import.meta.env.BASE_URL}images/rival.webp`} width="1024" height="1024" alt="" /> {game.model} · Black</span>
            <b aria-label={`Model clock ${formatClock(displayedClock(game, "model", now))}`}>{formatClock(displayedClock(game, "model", now))}</b>
          </div>
          <div className={`cl-board-status ${thinking ? "is-thinking" : ""}`} role="status" aria-live="polite">
            <span className="cl-status-mark">{thinking ? <Zap /> : <Check />}</span>
            <div><strong>{thinking ? `${game.model} IS THINKING` : playerTurn ? "YOUR MOVE" : "SYNCING GAME"}</strong><span>{thinking ? stages[0] : playerTurn ? "Select a piece, then choose a legal destination" : "Waiting for the authoritative game state"}</span></div>
            <i className="cl-status-dots" aria-hidden="true"><b /><b /><b /></i>
          </div>
          <ChessBoard fen={game.fen} disabled={!playerTurn || submitting} lastMove={latest ? { from: fenMoveSquare(latest.fenBefore, latest.fenAfter, true), to: fenMoveSquare(latest.fenBefore, latest.fenAfter, false) } : undefined} onSan={onMove} />
          <div className={`cl-clock cl-human-clock ${game.clock.active === "player" ? "is-active" : ""}`}><span>You · White</span><b aria-label={`Player clock ${formatClock(displayedClock(game, "player", now))}`}>{formatClock(displayedClock(game, "player", now))}</b></div>
        </div>
        <aside>
          <div className={`cl-turn ${thinking ? "is-thinking" : ""}`}>
            <small>Move {String(game.plies.length + 1).padStart(2, "0")} · {thinking ? `${game.model}'s turn` : "your turn"}</small>
            <h2>{thinking ? "PROVABLE REPLY." : "MAKE IT COUNT."}</h2>
            <p>{thinking ? "Attested inference is in progress. The server remains the match authority." : "Your move is checked locally, then submitted as canonical SAN."}</p>
          </div>
          {thinking ? <ol className="cl-ai-pipeline" aria-label="Verified model move process">{stages.map((stage, index) => <li key={stage} className={index === 0 ? "is-active" : ""}><span>0{index + 1}</span><strong>{stage}</strong></li>)}</ol> : <ReceiptPanel game={game} />}
          {game.startTx.status === "failed" && <p className="api-error" role="alert">Chain transaction failed: {game.startTx.error}</p>}
          {error && <p className="api-error" role="alert">{error}</p>}
          <button type="button" className="evidence-link" onClick={downloadEvidence}><Download /> Evidence</button>
          {downloadError && <p className="api-error" role="alert">{downloadError}</p>}
          {game.startTx.txHash && <a className="evidence-link" href={explorerUrl(game.chain.explorer, "tx", game.startTx.txHash)} target="_blank" rel="noreferrer">Opening transaction <ExternalLink /></a>}
          <button className="cl-resign" type="button" disabled={submitting} onClick={() => setResignOpen(true)}>Resign game</button>
        </aside>
      </div>
      {resignOpen && (
        <Dialog titleId="resign-title" onClose={() => setResignOpen(false)} className="cl-resign-overlay">
          <span>Leave the table</span><h2 id="resign-title">CALL IT A<br />ROUND?</h2>
          <p>Your game will be closed without a prize and the result recorded honestly.</p>
          <div className="cl-resign-actions"><button type="button" onClick={() => setResignOpen(false)}>Keep playing</button><button type="button" disabled={submitting} onClick={() => { setResignOpen(false); onResign(); }}>Resign game</button></div>
        </Dialog>
      )}
    </section>
  );
}

function fenMoveSquare(before: string, after: string, from: boolean): string | undefined {
  const board = (fen: string) => {
    const map = new Map<string, string>();
    fen.split(" ")[0].split("/").forEach((rank, row) => {
      let file = 0;
      for (const token of rank) {
        if (/\d/.test(token)) file += Number(token);
        else { map.set(`${String.fromCharCode(97 + file)}${8 - row}`, token); file += 1; }
      }
    });
    return map;
  };
  const a = board(before), b = board(after);
  const candidates = [...new Set([...a.keys(), ...b.keys()])];
  return from ? candidates.find((square) => a.has(square) && a.get(square) !== b.get(square)) : candidates.find((square) => b.has(square) && a.get(square) !== b.get(square));
}