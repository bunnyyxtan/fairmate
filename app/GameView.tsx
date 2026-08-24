import type { GameResult, GameState, PotInfo } from "@shared/protocol";
import { Check, Download, ExternalLink, ShieldCheck, Trophy, TriangleAlert, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, explorerUrl } from "./api";
import { ChessBoard } from "./ChessBoard";
import { Dialog } from "./Dialog";
import { PrizeMoment } from "./PrizeMoment";
import { ReceiptPanel } from "./ReceiptPanel";

/**
 * Real match phases, derived from authoritative server state.
 * Moves apply to the board the moment they are decided; journal anchoring
 * trails in the background and never pauses either clock. The only wait the
 * player ever sees is verified inference burning Qwen's clock.
 */
type Phase = "player_turn" | "model_thinking" | "finalizing" | "sync";

function matchPhase(game: GameState, pendingAction: "move" | "resign" | null): Phase {
  if (pendingAction === "resign") return "finalizing";
  if (game.status === "model_thinking") return "model_thinking";
  if (game.status === "awaiting_player") {
    return game.clock.active === "player" ? "player_turn" : "sync";
  }
  return "sync";
}

function formatClock(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A side's clock burns exactly while the authoritative clock says it does. */
function displayedClock(game: GameState, side: "player" | "model", now: number) {
  const base = side === "player" ? game.clock.playerMs : game.clock.modelMs;
  if (game.clock.active !== side || game.clock.activeSince === null) return base;
  return Math.max(0, base - Math.max(0, now - game.clock.activeSince));
}

function pendingAnchorCount(game: GameState): number {
  return (
    (game.startTx.status === "pending" ? 1 : 0) +
    game.plies.filter((ply) => ply.chain.status === "pending").length +
    (game.endTx?.status === "pending" ? 1 : 0) +
    (game.awardTx?.status === "pending" ? 1 : 0) +
    (game.refundTx?.status === "pending" ? 1 : 0)
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
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
  const anchorsLeft = pendingAnchorCount(game);
  return (
    <section className="result-screen honest-result">
      <span className="cl-kicker">{result === "aborted" ? <TriangleAlert /> : <ShieldCheck />} Final result</span>
      <h1>{titles[result]}</h1>
      <p>{game.faultReason ?? game.endReason ?? "The journal has recorded the final position."}</p>
      {game.endTx?.status === "pending" && (
        <p>Final result anchoring on {game.chain.network}, evidence unlocks once it confirms.</p>
      )}
      {game.endTx?.status === "failed" && <p className="api-error" role="alert">Chain transaction failed: {game.endTx.error}</p>}
      {game.endTx?.status === "confirmed" && game.endTx.txHash && (
        <a className="evidence-link" href={explorerUrl(game.chain.explorer, "tx", game.endTx.txHash)} target="_blank" rel="noreferrer">
          Final journal entry <ExternalLink size={14} />
        </a>
      )}
      {game.stake && (game.result === "draw" || game.result === "aborted") && (
        game.refundTx?.status === "confirmed" ? (
          <p className="cl-refund-note">
            Your {game.refundTx.amountOg ?? game.stake.amountOg} 0G stake was refunded.{" "}
            {game.refundTx.txHash && (
              <a href={explorerUrl(game.chain.explorer, "tx", game.refundTx.txHash)} target="_blank" rel="noreferrer">
                Refund transaction <ExternalLink size={14} />
              </a>
            )}
          </p>
        ) : game.refundTx?.status === "failed" ? (
          <p className="api-error" role="alert">Stake refund failed: {game.refundTx.error}. The pot owner can still return it manually.</p>
        ) : (
          <p>Your {game.stake.amountOg} 0G stake refund is queued and settles in the background.</p>
        )
      )}
      {game.stake && game.result === "model_win" && (
        <p>Your {game.stake.amountOg} 0G entry stake stays in the pot, as per the prize rules.</p>
      )}
      <button type="button" className="evidence-link" onClick={onDownload} disabled={anchorsLeft > 0}>
        <Download /> {anchorsLeft > 0 ? `Evidence unlocks after chain sync · ${anchorsLeft} tx left` : "Download game evidence"}
      </button>
      {downloadError && <p className="api-error" role="alert">{downloadError}</p>}
      <div className="result-actions"><button type="button" onClick={onReplay}>Play again</button><button type="button" onClick={onLobby}>Return to lobby</button></div>
    </section>
  );
}

export function GameView({
  game,
  pot,
  accessToken,
  submitting,
  pendingAction,
  error,
  onMove,
  onResign,
  onReplay,
  onLobby,
}: {
  game: GameState;
  pot: PotInfo | null;
  accessToken: string;
  submitting: boolean;
  pendingAction: "move" | "resign" | null;
  error: string | null;
  onMove: (san: string) => void;
  onResign: () => void;
  onReplay: () => void;
  onLobby: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [resignOpen, setResignOpen] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const ongoing = game.result === "ongoing";
  useEffect(() => {
    if (!ongoing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [ongoing]);

  // A staked game keeps running if the tab closes — the clock is binding once
  // the first move is played (zero-move games abort with a refund instead).
  // Warn before the player walks away from live money.
  const unloadGuard = ongoing && Boolean(game.stake) && game.sans.length > 0;
  useEffect(() => {
    if (!unloadGuard) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unloadGuard]);

  const phase = matchPhase(game, pendingAction);
  const phaseStartedAt = useRef(Date.now());
  const lastPhase = useRef<Phase | null>(null);
  if (lastPhase.current !== phase) {
    lastPhase.current = phase;
    phaseStartedAt.current = Date.now();
  }
  const phaseElapsedMs =
    phase === "model_thinking" && game.clock.activeSince !== null
      ? Math.max(0, now - game.clock.activeSince)
      : Math.max(0, now - phaseStartedAt.current);
  const phaseSeconds = Math.floor(phaseElapsedMs / 1000);

  const downloadEvidence = () => {
    setDownloadError(null);
    void api.downloadEvidence(game.gameId, accessToken).catch((downloadFailure) => {
      setDownloadError(
        downloadFailure instanceof Error ? downloadFailure.message : "Evidence download failed.",
      );
    });
  };

  if (game.result === "player_win") return <PrizeMoment game={game} anchorsPending={pendingAnchorCount(game)} onReplay={onReplay} onLobby={onLobby} onDownload={downloadEvidence} downloadError={downloadError} />;
  if (game.result !== "ongoing") return <HonestResult game={game} onReplay={onReplay} onLobby={onLobby} onDownload={downloadEvidence} downloadError={downloadError} />;

  const busy = phase !== "player_turn";
  const playerTurn = phase === "player_turn";
  const latest = game.plies.at(-1);
  const bounty = pot?.perWinBountyOg;
  const pendingAnchors = pendingAnchorCount(game);

  const statusCopy: Record<Phase, { title: string; detail: string }> = {
    player_turn: { title: "YOUR MOVE", detail: "Select a piece, then choose a legal destination" },
    model_thinking: {
      title: `${game.model} IS THINKING`,
      detail: `Verified inference burns Qwen's clock · ${phaseSeconds}s`,
    },
    finalizing: {
      title: "RECORDING RESIGNATION",
      detail: "Closing the game with the referee",
    },
    sync: { title: "SYNCING GAME", detail: "Waiting for the authoritative game state" },
  };

  const turnCopy: Record<Phase, { small: string; title: string; body: string }> = {
    player_turn: {
      small: `Move ${String(game.plies.length + 1).padStart(2, "0")} · your turn`,
      title: "MAKE IT COUNT.",
      body: "Legal moves hit the board the instant you play them. Journal anchoring runs behind the game and never touches your clock.",
    },
    model_thinking: {
      small: `Move ${String(game.plies.length + 1).padStart(2, "0")} · ${game.model}'s turn`,
      title: "PROVABLE REPLY.",
      body: "Attested inference is in progress and burning Qwen's clock. Verified replies typically land in a few seconds, occasionally up to 30 s.",
    },
    finalizing: {
      small: "Final record · closing",
      title: "SIGNING OFF.",
      body: "Your resignation is being recorded. The final journal entry settles on-chain in the background.",
    },
    sync: {
      small: "Reconnecting",
      title: "SYNCING.",
      body: "Restoring the authoritative game state from the referee.",
    },
  };

  const pipeline = [
    {
      label: "Your move hit the board instantly",
      hint: "journal anchor queued · confirms in background",
      state: "done",
    },
    {
      label: `${game.model} thinking on 0G`,
      hint: "TeeTLS-verified · typically 2-10 s, up to 30 s",
      state: phase === "model_thinking" ? "active" : "todo",
    },
    {
      label: "Reply verified before it hits the board",
      hint: "TEE receipt gate · payout unlocks after the journal confirms",
      state: "todo",
    },
  ] as const;

  return (
    <section className="cl-match" aria-label="Live match">
      <div className="cl-match-top">
        <button type="button" onClick={onLobby}>← Challenge lobby</button>
        <span>
          Game {game.gameId.slice(0, 12)}…
          {pendingAnchors > 0 ? ` · anchoring ${pendingAnchors} tx` : ""}
        </span>
      </div>
      <div className="cl-match-grid">
        <div className={`cl-live-board ${phase === "model_thinking" ? "is-ai-turn" : ""}`}>
          <div className={`cl-clock cl-ai-clock ${game.clock.active === "model" ? "is-active" : ""}`}>
            <span><img src={`${import.meta.env.BASE_URL}images/rival.webp`} width="1024" height="1024" alt="" /> {game.model} · Black</span>
            <b aria-label={`Model clock ${formatClock(displayedClock(game, "model", now))}`}>{formatClock(displayedClock(game, "model", now))}</b>
          </div>
          <div className={`cl-board-status ${busy ? "is-thinking" : ""}`} role="status" aria-live="polite">
            <span className="cl-status-mark">{busy ? <Zap /> : <Check />}</span>
            <div><strong>{statusCopy[phase].title}</strong><span>{statusCopy[phase].detail}</span></div>
            <i className="cl-status-dots" aria-hidden="true"><b /><b /><b /></i>
          </div>
          <ChessBoard fen={game.fen} disabled={!playerTurn || submitting} lastMove={latest ? { from: fenMoveSquare(latest.fenBefore, latest.fenAfter, true), to: fenMoveSquare(latest.fenBefore, latest.fenAfter, false) } : undefined} onSan={onMove} />
          <div className={`cl-clock cl-human-clock ${game.clock.active === "player" ? "is-active" : ""}`}>
            <span>You · White</span>
            <b aria-label={`Player clock ${formatClock(displayedClock(game, "player", now))}`}>{formatClock(displayedClock(game, "player", now))}</b>
          </div>
        </div>
        <aside>
          <div className={`cl-stake-strip ${game.playerAddress ? "" : "is-practice"}`}>
            <Trophy />
            {game.playerAddress ? (
              <p>
                {game.stake ? <>Staked <b>{game.stake.amountOg} 0G</b> · a win pays <b>{bounty ?? "0.2"} 0G</b> to{" "}</> : <>Playing for <b>{bounty ?? "0.2"} 0G</b> · a journal-recorded win pays{" "}</>}
                <code>{shortAddress(game.playerAddress)}</code> automatically.
                {game.stake && <> Leaving does not pause your clock.</>}
              </p>
            ) : (
              <p>
                Practice run, no stake and no payout. Wins still go on-chain for the record, prize
                games pay <b>{bounty ?? "0.2"} 0G</b>.
              </p>
            )}
          </div>
          <div className={`cl-turn ${busy ? "is-thinking" : ""}`}>
            <small>{turnCopy[phase].small}</small>
            <h2>{turnCopy[phase].title}</h2>
            <p>{turnCopy[phase].body}</p>
          </div>
          {busy ? (
            <ol className="cl-ai-pipeline" aria-label="Verified move pipeline">
              {pipeline.map((step, index) => (
                <li key={step.label} className={step.state === "active" ? "is-active" : step.state === "done" ? "is-done" : ""}>
                  <span>{step.state === "done" ? <Check /> : `0${index + 1}`}</span>
                  <div><strong>{step.label}</strong><small>{step.hint}</small></div>
                </li>
              ))}
            </ol>
          ) : (
            <ReceiptPanel game={game} />
          )}
          {game.startTx.status === "failed" && <p className="api-error" role="alert">Chain transaction failed: {game.startTx.error}</p>}
          {error && <p className="api-error" role="alert">{error}</p>}
          <button type="button" className="evidence-link" onClick={downloadEvidence}><Download /> Evidence</button>
          {downloadError && <p className="api-error" role="alert">{downloadError}</p>}
          {game.startTx.txHash && <a className="evidence-link" href={explorerUrl(game.chain.explorer, "tx", game.startTx.txHash)} target="_blank" rel="noreferrer">Opening transaction <ExternalLink size={14} /></a>}
          <button className="cl-resign" type="button" disabled={submitting} onClick={() => setResignOpen(true)}>Resign game</button>
        </aside>
      </div>
      {resignOpen && (
        <Dialog titleId="resign-title" onClose={() => setResignOpen(false)} className="cl-resign-overlay">
          <span>Leave the table</span><h2 id="resign-title">CALL IT A<br />ROUND?</h2>
          <p>
            {game.sans.length === 0
              ? game.stake
                ? "No moves yet, so the game aborts and your stake is refunded automatically."
                : "No moves yet, so the game simply aborts."
              : "Your game will be closed without a prize and the result recorded honestly."}
          </p>
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
