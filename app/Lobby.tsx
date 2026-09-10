import type { PotInfo } from "@shared/protocol";
import { CheckCircle2, ChevronRight, Clock3, Copy, Crown, ShieldCheck, Trophy, Wallet, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAddress, parseEther } from "ethers";
import { api, explorerUrl } from "./api";
import { ChessBoard } from "./ChessBoard";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Minimal EIP-1193 surface; no wallet SDK dependency. */
interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

function browserWallet(): Eip1193 | undefined {
  return (window as { ethereum?: Eip1193 }).ethereum;
}

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
  onStart: (address?: string, stakeTxHash?: string) => void;
  onRules: () => void;
}) {
  const practiceOnly = pot.practiceOnly !== false;
  const [mode, setMode] = useState<EntryMode>(practiceOnly ? "practice" : "prize");
  const [address, setAddress] = useState("");
  const [stakeTx, setStakeTx] = useState("");
  const [validation, setValidation] = useState("");
  const [walletNote, setWalletNote] = useState("");
  const [staking, setStaking] = useState(false);
  const [copiedPot, setCopiedPot] = useState(false);
  const model = pot.model || "Attested model";
  const fee = pot.practiceOnly === false ? pot.entryFeeOg : "";
  const bounty = pot.practiceOnly === false ? pot.perWinBountyOg : "";
  const trimmedAddress = address.trim();
  const trimmedStakeTx = stakeTx.trim();
  // Re-evaluate the policy on every render so a stale prize selection cannot
  // survive a recovery-mode update.
  const prizeMode = !practiceOnly && mode === "prize";
  const invalidAddress = Boolean(trimmedAddress) && !isAddress(trimmedAddress);
  const missingAddress = prizeMode && !trimmedAddress;
  const invalidStakeTx = Boolean(trimmedStakeTx) && !TX_HASH_RE.test(trimmedStakeTx);
  const missingStakeTx = prizeMode && !trimmedStakeTx;
  const addressReady = Boolean(trimmedAddress) && !invalidAddress;
  const wallet = browserWallet();
  const mounted = useRef(true);
  const practiceOnlyRef = useRef(practiceOnly);
  const disabledRef = useRef(disabled);
  practiceOnlyRef.current = practiceOnly;
  disabledRef.current = disabled;
  useEffect(() => () => {
    mounted.current = false;
  }, []);
  const validationMessage = prizeMode
    ? "A valid EVM address is required to receive the prize and any refund."
    : "Enter a valid EVM payout address, or leave this blank.";

  function changeAddress(value: string) {
    setAddress(value);
    const trimmed = value.trim();
    setValidation(trimmed && !isAddress(trimmed) ? validationMessage : "");
  }

  function changeStakeTx(value: string) {
    setStakeTx(value);
    const trimmed = value.trim();
    setValidation(trimmed && !TX_HASH_RE.test(trimmed) ? "That does not look like a transaction hash, expected 0x followed by 64 hex characters." : "");
  }

  function pickMode(next: EntryMode) {
    setMode(next);
    setValidation("");
    setWalletNote("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!prizeMode) return onStart(undefined);
    if (invalidAddress || missingAddress) return setValidation(validationMessage);
    if (invalidStakeTx || missingStakeTx) {
      return setValidation(`Paste the transaction hash of your ${fee} 0G stake to the ChallengePot.`);
    }
    setValidation("");
    onStart(trimmedAddress, trimmedStakeTx);
  }

  async function copyPotAddress() {
    if (disabled || practiceOnly) return;
    try {
      await navigator.clipboard.writeText(pot.chain.potAddress);
      if (!mounted.current || disabledRef.current || practiceOnlyRef.current) return;
      setWalletNote("ChallengePot address copied.");
      setCopiedPot(true);
      window.setTimeout(() => {
        if (mounted.current) setCopiedPot(false);
      }, 1800);
    } catch {
      if (mounted.current) setWalletNote("Copy failed, use the explorer link instead.");
    }
  }

  async function stakeWithWallet() {
    const eth = browserWallet();
    if (!eth || staking || disabled || practiceOnly) return;
    setStaking(true);
    setWalletNote("");
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (!mounted.current || disabledRef.current || practiceOnlyRef.current) {
        throw new Error("Paid games are not currently enabled. No transaction was sent.");
      }
      const account = accounts[0];
      if (!account) throw new Error("The wallet returned no account.");
      if (!trimmedAddress || account.toLowerCase() !== trimmedAddress.toLowerCase()) {
        setAddress(account);
        setValidation("");
      }
      const chainHex = `0x${pot.chain.chainId.toString(16)}`;
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
      } catch {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: chainHex,
            chainName: pot.chain.network,
            rpcUrls: [pot.chain.chainId === 16661 ? "https://evmrpc.0g.ai" : "https://evmrpc-testnet.0g.ai"],
            nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
            blockExplorerUrls: [pot.chain.explorer],
          }],
        });
      }
      let livePot: PotInfo;
      try {
        livePot = await api.pot();
      } catch {
        throw new Error("Could not confirm that paid games are enabled. No transaction was sent.");
      }
      if (
        !mounted.current ||
        disabledRef.current ||
        practiceOnlyRef.current ||
        livePot.practiceOnly !== false
      ) {
        throw new Error("Paid games are not currently enabled. No transaction was sent.");
      }
      const hash = (await eth.request({
        method: "eth_sendTransaction",
        params: [{
          from: account,
          to: livePot.chain.potAddress,
          value: `0x${parseEther(livePot.entryFeeOg).toString(16)}`,
        }],
      })) as string;
      if (mounted.current) {
        setStakeTx(hash);
        setWalletNote("Stake sent from your wallet. It confirms in a few seconds, then lock in your game.");
      }
    } catch (walletError) {
      const message = walletError instanceof Error && walletError.message ? walletError.message : "";
      if (mounted.current) {
        setWalletNote(message && !/user (denied|rejected)/i.test(message) ? `Wallet staking failed: ${message}` : "Wallet staking was cancelled.");
      }
    } finally {
      if (mounted.current) setStaking(false);
    }
  }

  const hint = prizeMode
    ? `Win and ${bounty} 0G lands on this address: your ${fee} 0G stake back plus the bounty. Draws and aborted games refund the stake automatically. No move made? It aborts and refunds. After your first move the clock binds, a flag fall keeps the stake in the pot.`
    : `No wallet needed. Wins are recorded on-chain for the record, prize games stake ${fee} 0G and pay ${bounty} 0G on a win.`;

  return (
    <>
      <section className="cl-intro">
        <div><span className="cl-kicker"><Crown /> {practiceOnly ? "Practice-only recovery" : "Prize round"} · {pot.chain.network}</span><h1>{practiceOnly ? <><em>PLAY FOR PRACTICE.</em><br />KEEP FUNDS SAFE.</> : <>BEAT THE BOT.<br /><em>CLAIM THE POT.</em></>}</h1></div>
        <div className="cl-intro-side">
          <p>{practiceOnly
            ? `Recovery mode is active. Play ${model} for free; do not send funds or connect a payout wallet.`
            : `One board. Five minutes each. Stake ${fee} 0G, beat ${model}, and a journal-recorded win pays ${bounty} 0G.`}</p>
          <button type="button" className="cl-proof-toggle" onClick={onRules}><ShieldCheck /> Why this match is fair <ChevronRight /></button>
        </div>
      </section>
      {practiceOnly && <section className="attestation-warning" role="status"><ShieldCheck /><div><strong>Practice-only recovery mode</strong><p>No deposits, stakes, payout addresses, or prize claims are accepted. Start a free practice game below.</p></div></section>}
      <section className="cl-lobby" id="challenge">
        <article className="cl-pot">
          <header><span>{practiceOnly ? "Recovery status" : "Live prize pool"}</span><Trophy /></header>
          {practiceOnly ? (
            <>
              <div className="cl-pot-value"><small>Available mode</small><strong>Practice only</strong></div>
              <div className="cl-pot-note"><CheckCircle2 /><p>Free games use the same verified chess path. Financial admission is locked before any deposit validation or chain access.</p></div>
            </>
          ) : (
            <>
              <div className="cl-pot-value"><small>Available now</small><strong>{pot.potBalanceOg} 0G</strong></div>
              <div className="cl-payout"><span>Entry stake per prize game</span><b>{fee} 0G</b></div>
              <div className="cl-payout"><span>Each journal-recorded human win</span><b>{bounty} 0G</b></div>
              <div className="cl-pot-note"><CheckCircle2 /><p>Payouts are bound to the on-chain game journal, not a private server result. Draws and aborted games refund the stake.</p></div>
            </>
          )}
          <div className="fm-contract-links">{!practiceOnly && addressLink(pot, "ChallengePot", pot.chain.potAddress)}{addressLink(pot, "MoveJournal", pot.chain.journalAddress)}</div>
        </article>
        <article className="cl-preview" aria-label={`Your opponent, ${model}`}>
          <div className="cl-preview-head"><div><small>{practiceOnly ? "Practice board 01" : "Prize table 01"}</small><strong>YOU vs {model}</strong></div><span>White to move</span></div>
          <div className="cl-rival-card"><div><small>{practiceOnly ? "Verified opponent" : "Defending the pot"}</small><b>{model}</b><span>{pot.provider}</span></div><img src={`${import.meta.env.BASE_URL}images/rival.webp`} width="1024" height="1024" alt="Playful orange and black chess robot holding a knight" /></div>
          <div className="lobby-board-live" aria-hidden="true"><ChessBoard fen={START_FEN} disabled onSan={() => undefined} /></div>
        </article>
        <article className="cl-entry">
          <div><span className="cl-step">Challenger slot</span><h2>Ready up.</h2><p>{practiceOnly ? "Take white and start a free practice game. No wallet is needed." : "Take white and make the first move. Pick how you want to play this one."}</p></div>
          <form className="fm-address-form is-compact" onSubmit={submit}>
            {!practiceOnly && (
              <div className="cl-mode-switch" role="radiogroup" aria-label="Game mode">
                <button type="button" role="radio" aria-checked={prizeMode} className={prizeMode ? "is-selected" : ""} disabled={busy || disabled} onClick={() => pickMode("prize")}>
                  <strong>Play for the prize</strong><span>Stake {fee} 0G · win {bounty} 0G</span>
                </button>
                <button type="button" role="radio" aria-checked={!prizeMode} className={!prizeMode ? "is-selected" : ""} disabled={busy || disabled} onClick={() => pickMode("practice")}>
                  <strong>Practice game</strong><span>Free · no payout, same proof</span>
                </button>
              </div>
            )}
            {prizeMode && (
              <>
                <label htmlFor="payout">Payout address <span>Prize and refunds land here</span></label>
                <div className="fm-address-row">
                  <input id="payout" name="payoutAddress" value={address} onChange={(event) => changeAddress(event.target.value)} placeholder="0x…" inputMode="text" autoComplete="off" spellCheck={false} aria-describedby="address-hint" aria-invalid={invalidAddress} aria-errormessage={validation ? "address-hint" : undefined} disabled={busy || disabled} />
                </div>
                <div className={`cl-stake-panel ${addressReady ? "" : "is-waiting"}`}>
                  <label htmlFor="staketx">Entry stake <span>{fee} 0G from that address</span></label>
                  <p className="cl-stake-how">
                    Send exactly {fee} 0G from your payout wallet to the ChallengePot, then paste the transaction hash.
                  </p>
                  <div className="cl-stake-actions">
                    <button type="button" className={copiedPot ? "is-copied" : ""} onClick={() => void copyPotAddress()} disabled={busy || disabled || practiceOnly}>
                      {copiedPot ? <><CheckCircle2 size={14} /> Copied</> : <><Copy size={14} /> Copy pot address</>}
                    </button>
                    {wallet && (
                      <button type="button" className="is-wallet" onClick={() => void stakeWithWallet()} disabled={busy || staking || disabled || practiceOnly}>
                        <Wallet size={14} /> {staking ? "Waiting for your wallet…" : `Stake ${fee} 0G with browser wallet`}
                      </button>
                    )}
                  </div>
                  <div className="fm-address-row">
                    <input id="staketx" name="stakeTxHash" value={stakeTx} onChange={(event) => changeStakeTx(event.target.value)} placeholder="Stake transaction hash 0x…" inputMode="text" autoComplete="off" spellCheck={false} aria-invalid={invalidStakeTx} disabled={busy || disabled} />
                  </div>
                  {walletNote && <p className="cl-wallet-note" role="status">{walletNote}</p>}
                </div>
              </>
            )}
            <button type="submit" className="cl-start-cta" disabled={busy || disabled || (prizeMode && (invalidAddress || missingAddress || invalidStakeTx || missingStakeTx))}>
              {busy ? "Opening your board…" : prizeMode ? "Lock in & play for the prize" : "Start practice game"} <ChevronRight />
            </button>
            <p id="address-hint" className={validation ? "field-error" : ""} role={validation ? "alert" : undefined}>{validation || (practiceOnly ? "Practice is free. FairMate will not ask for a wallet, deposit, or transaction hash." : hint)}</p>
            {busy && (
              <div className="cl-start-status" role="status" aria-live="polite">
                <span className="loader" aria-hidden="true" />
                <div>
                  <strong>Opening your board</strong>
                  <span>Starts right away, the opening anchor settles on {pot.chain.network} behind the game</span>
                </div>
              </div>
            )}
          </form>
          {error && <p className="api-error" role="alert">{error}</p>}
          <ul><li><ShieldCheck /> {pot.verificationScheme === "router-teetls" ? "Router-verified TeeTLS moves" : "Browser-verified TeeML moves"}</li><li><Clock3 /> 5+0 blitz clocks, binding after your first move</li><li><Trophy /> {practiceOnly ? "Practice result recorded with no financial claim" : `Win pays ${bounty} 0G, draws refund the stake`}</li></ul>
        </article>
      </section>
    </>
  );
}
