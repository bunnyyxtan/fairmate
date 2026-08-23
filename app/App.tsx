import type { AttestationInfo, GameState, PotInfo } from "@shared/protocol";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Dialog } from "./Dialog";
import { GameView } from "./GameView";
import { Brand, Lobby } from "./Lobby";

const ACTIVE_GAME_KEY = "fairmate.activeGame.v1";

export default function App() {
  const [pot, setPot] = useState<PotInfo | null>(null);
  const [attestation, setAttestation] = useState<AttestationInfo | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [gameToken, setGameToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingAction, setPendingAction] = useState<"move" | "resign" | null>(null);
  const [rules, setRules] = useState(false);

  const boot = useCallback(async () => {
    setLoading(true);
    setBootError(null);
    try {
      const [health, nextPot] = await Promise.all([api.health(), api.pot()]);
      setPot(nextPot);
      if (health.bootError) setBootError(health.bootError);
      try { setAttestation(await api.attestation()); } catch { setAttestation(null); }
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "FairMate could not reach its API.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void boot(); }, [boot]);
  useEffect(() => {
    const saved = window.sessionStorage.getItem(ACTIVE_GAME_KEY);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as { gameId?: unknown; accessToken?: unknown };
      if (typeof parsed.gameId !== "string" || typeof parsed.accessToken !== "string") {
        window.sessionStorage.removeItem(ACTIVE_GAME_KEY);
        return;
      }
      void api.game(parsed.gameId, parsed.accessToken)
        .then((restored) => {
          setGameToken(parsed.accessToken as string);
          setGame(restored);
        })
        .catch(() => window.sessionStorage.removeItem(ACTIVE_GAME_KEY));
    } catch {
      window.sessionStorage.removeItem(ACTIVE_GAME_KEY);
    }
  }, []);

  // Poll while an action is in flight too: if a move/resign response is lost
  // (timeout, instance swap), the authoritative state still reaches the UI.
  const shouldPoll = Boolean(game) && (submitting ||
    game!.status === "model_thinking" ||
    (game!.result === "ongoing" && game!.clock.active === null) ||
    game!.startTx.status === "pending" ||
    game!.endTx?.status === "pending" ||
    game!.awardTx?.status === "pending" ||
    game!.plies.some((ply) => ply.chain.status === "pending")
  );
  useEffect(() => {
    if (!game || !gameToken || !shouldPoll) return;
    const id = game.gameId;
    let active = true;
    const poll = async () => {
      try {
        const next = await api.game(id, gameToken);
        // Never let a slow poll overwrite fresher state from a POST response.
        if (active) {
          setGame((current) => (current && current.gameId === next.gameId && current.updatedAt > next.updatedAt ? current : next));
          setApiError(null);
        }
      } catch (error) {
        if (active) setApiError(error instanceof Error ? error.message : "Game polling failed.");
      }
    };
    const timer = window.setInterval(() => void poll(), 1000);
    void poll();
    return () => { active = false; window.clearInterval(timer); };
  }, [game?.gameId, gameToken, shouldPoll]);

  async function action(kind: "move" | "resign", work: () => Promise<GameState>) {
    if (submitting) return;
    setSubmitting(true);
    setPendingAction(kind);
    setApiError(null);
    try { setGame(await work()); }
    catch (error) {
      setApiError(error instanceof Error ? error.message : "The request failed.");
      // The request may have landed server-side even though the response was
      // lost. Re-sync the authoritative state a few times so the UI never
      // stays frozen on a stale phase after a timeout.
      const id = game?.gameId;
      const token = gameToken;
      if (id && token) {
        for (const delayMs of [2_000, 10_000, 30_000]) {
          window.setTimeout(() => {
            void api.game(id, token)
              .then((next) => setGame((current) => (current && current.gameId === next.gameId && current.updatedAt > next.updatedAt ? current : next)))
              .catch(() => undefined);
          }, delayMs);
        }
      }
    }
    finally { setSubmitting(false); setPendingAction(null); }
  }
  const start = (address?: string) => {
    if (submitting) return;
    setSubmitting(true);
    setApiError(null);
    void api.createGame(address)
      .then((created) => {
        window.sessionStorage.setItem(
          ACTIVE_GAME_KEY,
          JSON.stringify({ gameId: created.game.gameId, accessToken: created.accessToken }),
        );
        setGameToken(created.accessToken);
        setGame(created.game);
      })
      .catch((error) => setApiError(error instanceof Error ? error.message : "The game could not start."))
      .finally(() => setSubmitting(false));
  };
  const lobby = () => { if (!submitting) { window.sessionStorage.removeItem(ACTIVE_GAME_KEY); setGame(null); setGameToken(null); setApiError(null); } };
  const replay = () => { window.sessionStorage.removeItem(ACTIVE_GAME_KEY); setGame(null); setGameToken(null); setApiError(null); window.scrollTo({ top: 0, behavior: "auto" }); };

  if (loading) return <main className="boot-state" aria-live="polite"><span className="loader" /><h1>Preparing the prize table…</h1><p>Loading live pot and attestation data.</p></main>;
  if (!pot) return <main className="boot-state error-state" role="alert"><ShieldCheck /><h1>FairMate is unavailable.</h1><p>{bootError}</p><button type="button" onClick={() => void boot()}>Try again</button></main>;

  return (
    <div className="fm fm-challenge-lobby">
      <header className="cl-nav"><Brand /><nav aria-label="Primary"><a href="#challenge">Challenge</a><button type="button" onClick={() => setRules(true)}>How it stays fair</button><a href="#contracts">On-chain</a></nav><span className="fm-network"><i />{pot.chain.network} · {pot.chain.chainId}</span></header>
      <main>
        {!game ? <Lobby pot={pot} busy={submitting} disabled={!pot.attestationReady || Boolean(bootError)} error={apiError} onStart={start} onRules={() => setRules(true)} /> :
          <GameView game={game} pot={pot} accessToken={gameToken ?? ""} submitting={submitting} pendingAction={pendingAction} error={apiError} onMove={(san) => void action("move", () => api.move(game.gameId, san, gameToken ?? ""))} onResign={() => void action("resign", () => api.resign(game.gameId, gameToken ?? ""))} onReplay={replay} onLobby={lobby} />}
        {!game && (!pot.attestationReady || bootError) && <section className="attestation-warning" role="alert"><ShieldCheck /><div><strong>Attestation unavailable</strong><p>{bootError ?? "The secure model attestation is still being prepared. New games are disabled until it is ready."}</p></div><button type="button" onClick={() => void boot()}>Check again</button></section>}
      </main>
      <footer id="contracts"><Brand compact /><span>Verifiable chess, built on 0G.</span><a href={pot.chain.explorer} target="_blank" rel="noreferrer">Open {pot.chain.network} explorer <ExternalLink size={16} /></a></footer>
      {rules && <Dialog titleId="rules-title" onClose={() => setRules(false)}>
        <span>Fair-play rules</span><h2 id="rules-title">THE MODEL CAN'T<br />SWITCH THE GAME.</h2>
        <p>The model, provider identity, verification scheme and move journal come from the live service configuration. FairMate recomputes every evidence property available to the browser and states the Router trust boundary explicitly.</p>
        <dl className="rules-data"><div><dt>Model</dt><dd>{pot.model}</dd></div><div><dt>Provider</dt><dd>{pot.provider}</dd></div><div><dt>Proof mode</dt><dd>{pot.verificationScheme}</dd></div><div><dt>Checked</dt><dd>{attestation ? new Date(attestation.verifiedAt).toLocaleString() : "Unavailable"}</dd></div></dl>
        {attestation?.trustBoundary && <p className="rules-trust">{attestation.trustBoundary}</p>}
        <a href={pot.chain.explorer} target="_blank" rel="noreferrer">Inspect live contracts <ExternalLink /></a>
      </Dialog>}
    </div>
  );
}