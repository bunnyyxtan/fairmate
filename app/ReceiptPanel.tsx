import { allChecksPass, verifyReceiptBundle, type ReceiptCheck } from "@shared/receipt";
import type { GameState, PlyRecord } from "@shared/protocol";
import { Check, Copy, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useMemo, useState } from "react";
import { explorerUrl } from "./api";

export function ReceiptPanel({ game }: { game: GameState }) {
  const [copied, setCopied] = useState(false);
  const ply = [...game.plies].reverse().find((item) => item.mover === "model" && item.receipt);
  const result = useMemo<{ checks: ReceiptCheck[]; verified: boolean } | null>(() => {
    if (!ply?.receipt) return null;
    try {
      const checks = verifyReceiptBundle(ply.receipt);
      return { checks, verified: allChecksPass(checks) };
    } catch (error) {
      return {
        verified: false,
        checks: [{ name: "client verification", pass: false, detail: error instanceof Error ? error.message : "Malformed receipt" }],
      };
    }
  }, [ply]);
  const routerReceipt = ply?.receipt?.scheme === "router-teetls";

  if (!ply || !result) {
    return <article className="fm-receipt receipt-empty"><p>No model receipt yet. The first reply will be checked and bound to its 0G evidence in this browser.</p></article>;
  }
  return (
    <article className={`fm-receipt ${result.verified ? "receipt-ok" : "receipt-failed"}`}>
      <header>
        <span>
          {result.verified ? <ShieldCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
          {result.verified
            ? routerReceipt
              ? "Router TEE verified · evidence bound"
              : "TEE signature verified in browser"
            : "Receipt verification failed"}
        </span>
        <time>MOVE {String(ply.ply).padStart(2, "0")}</time>
      </header>
      <div className="receipt-body">
        <div className="receipt-summary">
          <span><small>Move</small><strong>{ply.san}</strong></span>
          <span><small>Model</small><strong>{game.model}</strong></span>
        </div>
        <ul className="receipt-checks">
          {result.checks.map((check) => (
            <li key={check.name} title={check.detail}>
              {check.pass ? <Check aria-label="Passed" /> : <X aria-label="Failed" />}
              <span>{check.name}</span>
            </li>
          ))}
        </ul>
        {routerReceipt && (
          <p className="receipt-trust">
            This browser recomputed the request, response, trace and commitment. 0G Router is the stated trust boundary for the TeeTLS signature and returned <code>tee_verified=true</code>.
          </p>
        )}
        {ply.receiptHash && (
          <div className="receipt-hash">
            <code>{ply.receiptHash}</code>
            <button type="button" aria-label="Copy receipt hash" onClick={() => {
              void navigator.clipboard.writeText(ply.receiptHash ?? "");
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}>{copied ? <Check /> : <Copy />}</button>
          </div>
        )}
        {ply.chain.txHash && (
          <a className="text-link" href={explorerUrl(game.chain.explorer, "tx", ply.chain.txHash)} target="_blank" rel="noreferrer">
            Inspect move transaction ↗
          </a>
        )}
      </div>
    </article>
  );
}