import type { PotInfo } from "@shared/protocol";
import { CheckCircle2, ChevronRight, Clock3, Crown, ShieldCheck, Trophy, ExternalLink } from "lucide-react";
import { useState, type FormEvent } from "react";
import { isAddress } from "ethers";
import { explorerUrl } from "./api";
import { ChessBoard } from "./ChessBoard";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function Brand({ compact = false }: { compact?: boolean }) {
  return <a className={`fm-brand ${compact ? "is-compact" : ""}`} href="#" aria-label="FairMate"><img src={`${import.meta.env.BASE_URL}brand/fairmate-lockup.svg`} alt="FairMate" className="fm-brand-lockup" /></a>;
}

function addressLink(pot: PotInfo, label: string, address: string) {
  return <a href={explorerUrl(pot.chain.explorer, "address", address)} target="_blank" rel="noreferrer"><span>{label}</span><code>{address.slice(0, 10)}…</code><ExternalLink size={14} /></a>;
}

type EntryMode = "prize" | "practice";

export function Lobby({
  pot,
  busy,
  disabled,
  error,
  onStart,
  onRules,
}: {
  pot: PotInfo;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onStart: (address?: string) => void;
  onRules: () => void;
}) {
  const [mode, setMode] = useState<EntryMode>("prize");
  const [address, setAddress] = useState("");
  const [validation, setValidation] = useState("");
  const model = pot.model || "Attested model";
  const trimmedAddress = address.trim();
  const prizeMode = mode === "prize";
  const invalidAddress = Boolean(trimmedAddress) && !isAddress(trimmedAddress);
  const missingAddress = prizeMode && !trimmedAddress;
  const validationMessage = prizeMode
    ? "A valid EVM address is required to receive the prize."
    : "Enter a valid EVM payout address, or leave this blank.";

  function changeAddress(value: string) {
    setAddress(value);
    const trimmed = value.trim();
    setValidation(trimmed && !isAddress(trimmed) ? validationMessage : "");
  }

  function pickMode(next: EntryMode) {
    setMode(next);
    setValidation("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (prizeMode && (invalidAddress || missingAddress)) return setValidation(validationMessage);
    if (!prizeMode) return onStart(undefined);
    setValidation("");
    onStart(trimmedAddress);
  }

  const hint = prizeMode
    ? `A journal-recorded win auto-pays ${pot.perWinBountyOg} OG to this address.`
    : `No wallet needed. Wins are recorded on-chain for the record, but the ${pot.perWinBountyOg} OG bounty is only paid to a payout address.`;

  return (
    <>
      <section className="cl-intro">
        <div><span className="cl-kicker"><Crown /> Prize round · {pot.chain.network}</span><h1>BEAT THE BOT.<br /><em>CLAIM THE POT.</em></h1></div>
        <div className="cl-intro-side">
          <p>One board. Five minutes each. Beat {model} for a journal-recorded chance at {pot.perWinBountyOg} OG.</p>
          <button type="button" className="cl-proof-toggle" onClick={onRules}><ShieldCheck /> Why this match is fair <ChevronRight /></button>
        </div>
      </section>
      <section className="cl-lobby" id="challenge">
        <article className="cl-pot">
          <header><span>Builder-funded prize pool</span><Trophy /></header>
          <div className="cl-pot-value"><small>Available now</small><strong>{pot.potBalanceOg} OG</strong></div>
          <div className="cl-payout"><span>Each journal-recorded human win</span><b>{pot.perWinBountyOg} OG</b></div>
          <div className="cl-pot-note"><CheckCircle2 /><p>Payouts are bound to the on-chain game journal, not a private server result.</p></div>
          <div className="fm-contract-links">{addressLink(pot, "ChallengePot", pot.chain.potAddress)}{addressLink(pot, "MoveJournal", pot.chain.journalAddress)}</div>
        </article>
        <article className="cl-preview" aria-label={`Your opponent, ${model}`}>
          <div className="cl-preview-head"><div><small>Prize table 01</small><strong>YOU vs {model}</strong></div><span>White to move</span></div>
          <div className="cl-rival-card"><div><small>Defending the pot</small><b>{model}</b><span>{pot.provider}</span></div><img src={`${import.meta.env.BASE_URL}images/rival.webp`} width="1024" height="1024" alt="Playful orange and black chess robot holding a knight" /></div>
          <div className="lobby-board-live" aria-hidden="true"><ChessBoard fen={START_FEN} disabled onSan={() => undefined} /></div>
        </article>
        <article className="cl-entry">
          <div><span className="cl-step">Challenger slot</span><h2>Ready up.</h2><p>Take white and make the first move. Pick how you want to play this one.</p></div>
          <form className="fm-address-form is-compact" onSubmit={submit}>
            <div className="cl-mode-switch" role="radiogroup" aria-label="Game mode">
              <button type="button" role="radio" aria-checked={prizeMode} className={prizeMode ? "is-selected" : ""} disabled={busy} onClick={() => pickMode("prize")}>
                <strong>Play for the prize</strong><span>{pot.perWinBountyOg} OG on a win</span>
              </button>
              <button type="button" role="radio" aria-checked={!prizeMode} className={!prizeMode ? "is-selected" : ""} disabled={busy} onClick={() => pickMode("practice")}>
                <strong>Practice game</strong><span>No payout, same proof</span>
              </button>
            </div>
            {prizeMode && (
              <>
                <label htmlFor="payout">Payout address <span>Required for the prize</span></label>
                <div className="fm-address-row">
                  <input id="payout" name="payoutAddress" value={address} onChange={(event) => changeAddress(event.target.value)} placeholder="0x…" inputMode="text" autoComplete="off" spellCheck={false} aria-describedby="address-hint" aria-invalid={invalidAddress} aria-errormessage={validation ? "address-hint" : undefined} disabled={busy} />
                </div>
              </>
            )}
            <button type="submit" className="cl-start-cta" disabled={busy || disabled || (prizeMode && (invalidAddress || missingAddress))}>
              {busy ? "Opening your board…" : prizeMode ? "Lock in & play for the prize" : "Start practice game"} <ChevronRight />
            </button>
            <p id="address-hint" className={validation ? "field-error" : ""} role={validation ? "alert" : undefined}>{validation || hint}</p>
            {busy && (
              <div className="cl-start-status" role="status" aria-live="polite">
                <span className="loader" aria-hidden="true" />
                <div>
                  <strong>Opening your board</strong>
                  <span>Starts right away — the opening anchor settles on {pot.chain.network} behind the game</span>
                </div>
              </div>
            )}
          </form>
          {error && <p className="api-error" role="alert">{error}</p>}
          <ul><li><ShieldCheck /> {pot.verificationScheme === "router-teetls" ? "Router-verified TeeTLS moves" : "Browser-verified TeeML moves"}</li><li><Clock3 /> 5+0 blitz clocks</li><li><Trophy /> Automatic prize settlement</li></ul>
        </article>
      </section>
    </>
  );
}
