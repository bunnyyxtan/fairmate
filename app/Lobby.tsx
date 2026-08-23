import type { PotInfo } from "@shared/protocol";
import { CheckCircle2, ChevronRight, Clock3, Crown, ShieldCheck, Trophy } from "lucide-react";
import { useState, type FormEvent } from "react";
import { isAddress } from "ethers";
import { explorerUrl } from "./api";

export function Brand() {
  return <a className="fm-brand" href="#"><ShieldCheck aria-hidden="true" /><span>FairMate</span></a>;
}

function addressLink(pot: PotInfo, label: string, address: string) {
  return <a href={explorerUrl(pot.chain.explorer, "address", address)} target="_blank" rel="noreferrer"><span>{label}</span><code>{address.slice(0, 10)}…</code><span>↗</span></a>;
}

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
  const [address, setAddress] = useState("");
  const [validation, setValidation] = useState("");
  const model = pot.model || "Attested model";
  const trimmedAddress = address.trim();
  const invalidAddress = Boolean(trimmedAddress) && !isAddress(trimmedAddress);
  const validationMessage = "Enter a valid EVM payout address, or leave this blank.";

  function changeAddress(value: string) {
    setAddress(value);
    const trimmed = value.trim();
    setValidation(trimmed && !isAddress(trimmed) ? validationMessage : "");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invalidAddress) return setValidation(validationMessage);
    setValidation("");
    onStart(trimmedAddress || undefined);
  }
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
          <div className="lobby-board" aria-hidden="true">{Array.from({ length: 64 }, (_, i) => <i key={i} />)}</div>
        </article>
        <article className="cl-entry">
          <div><span className="cl-step">Challenger slot</span><h2>Ready up.</h2><p>Take white and make the first move. A wallet is only needed if you want the prize.</p></div>
          <form className="fm-address-form is-compact" onSubmit={submit}>
            <label htmlFor="payout">Payout address <span>Optional</span></label>
            <div className="fm-address-row"><input id="payout" name="payoutAddress" value={address} onChange={(event) => changeAddress(event.target.value)} placeholder="0x…" inputMode="text" autoComplete="off" spellCheck={false} aria-describedby="address-hint" aria-invalid={invalidAddress} aria-errormessage={validation ? "address-hint" : undefined} /><button type="submit" disabled={busy || disabled || invalidAddress}>{busy ? "Starting…" : "Lock in & play"} <ChevronRight /></button></div>
            <p id="address-hint" className={validation ? "field-error" : ""} role={validation ? "alert" : undefined}>{validation || "Add an EVM address only if you want an on-chain prize."}</p>
          </form>
          {error && <p className="api-error" role="alert">{error}</p>}
          <ul><li><ShieldCheck /> {pot.verificationScheme === "router-teetls" ? "Router-verified TeeTLS moves" : "Browser-verified TeeML moves"}</li><li><Clock3 /> 5+0 blitz clocks</li><li><Trophy /> Automatic prize settlement</li></ul>
        </article>
      </section>
    </>
  );
}