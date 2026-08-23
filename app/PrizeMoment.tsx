import type { GameState } from "@shared/protocol";
import { Check, Download, ExternalLink, ShieldCheck, Trophy } from "lucide-react";
import { explorerUrl } from "./api";

export function PrizeMoment({
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
  const award = game.awardTx;
  const payable = Boolean(game.playerAddress);
  const recorded = game.endTx?.status === "confirmed";
  const endFailed = game.endTx?.status === "failed";
  return (
    <section className="result-screen win-screen" aria-labelledby="prize-title">
      <div className="prize-art"><img src={`${import.meta.env.BASE_URL}images/trophy.webp`} width="1024" height="1024" alt="Gold prize trophy with confetti" /></div>
      <div className="prize-copy">
        <span className="cl-demo-label">{recorded ? "Journal-recorded victory" : endFailed ? "Chess victory · journal not confirmed" : "Chess victory · journal settling"}</span>
        <h1 id="prize-title">YOU BEAT<br />{game.model}.</h1>
        <p>{game.endReason ?? "Your win is recorded in the match journal."}</p>
        <div className="cl-prize-value"><small>{game.stake ? "Prize · includes your stake back" : "Prize"}</small><strong>{award?.amountOg ? `${award.amountOg} OG` : "Awaiting award amount"}</strong></div>
        <ul className="cl-prize-proof">
          <li className={endFailed ? "failed" : ""}><ShieldCheck /><span><b>
            {recorded ? "Game result recorded" : endFailed ? "Game result not recorded" : "Game result anchoring on-chain"}
          </b><small>
            {recorded ? game.endTx?.txHash ?? game.gameId : endFailed ? game.endTx?.error ?? "The end-game transaction failed." : "Settling in the background, the payout unlocks after this confirms."}
          </small></span>{recorded && <Check />}</li>
          <li className={award?.status === "failed" ? "failed" : ""}><Trophy /><span><b>
            {!payable ? "Win cannot be paid" : award?.status === "confirmed" ? "Award confirmed" : award?.status === "failed" ? "Award transaction failed" : "Award transaction pending"}
          </b><small>{!payable ? "No payout address was supplied when this game began." : award?.error ?? award?.txHash ?? "Waiting for chain confirmation…"}</small></span></li>
        </ul>
        {award?.txHash && <a className="cl-claim claimed" href={explorerUrl(game.chain.explorer, "tx", award.txHash)} target="_blank" rel="noreferrer">View award transaction <ExternalLink /></a>}
        <button type="button" className="evidence-link" onClick={onDownload}><Download /> Download game evidence</button>
        {downloadError && <p className="api-error" role="alert">{downloadError}</p>}
        <div className="cl-prize-actions"><button type="button" onClick={onReplay}>Play again</button><button type="button" onClick={onLobby}>Return to lobby</button></div>
      </div>
    </section>
  );
}
