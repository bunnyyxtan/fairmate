import { useEffect, useMemo, useState } from "react";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import { Dialog } from "./Dialog";

const glyphs: Record<Color, Record<PieceSymbol, string>> = {
  w: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" },
  b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" },
};
const names: Record<PieceSymbol, string> = {
  p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king",
};
const squares = Array.from({ length: 64 }, (_, index) => {
  const rank = 8 - Math.floor(index / 8);
  const file = String.fromCharCode(97 + (index % 8));
  return `${file}${rank}` as Square;
});

export function ChessBoard({
  fen,
  disabled,
  lastMove,
  onSan,
}: {
  fen: string;
  disabled: boolean;
  lastMove?: { from?: string; to?: string };
  onSan: (san: string) => void;
}) {
  const chess = useMemo(() => new Chess(fen), [fen]);
  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square } | null>(null);
  useEffect(() => setSelected(null), [fen]);

  const legal = selected
    ? chess.moves({ square: selected, verbose: true }).map((move) => move.to)
    : [];

  function commit(from: Square, to: Square, promote?: "q" | "r" | "b" | "n") {
    const copy = new Chess(fen);
    try {
      const move = copy.move({ from, to, promotion: promote });
      onSan(move.san);
    } catch {
      setSelected(null);
    }
  }

  function choose(square: Square) {
    if (disabled) return;
    const piece = chess.get(square);
    if (!selected) {
      if (piece?.color === "w" && chess.turn() === "w") setSelected(square);
      return;
    }
    if (square === selected) return setSelected(null);
    if (piece?.color === "w") {
      setSelected(square);
      return;
    }
    const moves = chess.moves({ square: selected, verbose: true }).filter((move) => move.to === square);
    if (!moves.length) return;
    if (moves.some((move) => move.promotion)) setPromotion({ from: selected, to: square });
    else commit(selected, square);
  }

  return (
    <>
      <div className="fm-board-shell fm-board-sand">
        <div className="fm-board" role="grid" aria-label="Chess board, White at the bottom">
          {squares.map((square, index) => {
            const piece = chess.get(square);
            const isLegal = legal.includes(square);
            return (
              <button
                key={square}
                type="button"
                role="gridcell"
                className={`fm-square ${(Math.floor(index / 8) + index) % 2 ? "is-dark" : "is-light"} ${selected === square ? "is-selected" : ""} ${lastMove?.from === square || lastMove?.to === square ? "is-last" : ""} ${isLegal ? "is-legal" : ""}`}
                onClick={() => choose(square)}
                disabled={disabled}
                aria-label={`${square}, ${piece ? `${piece.color === "w" ? "white" : "black"} ${names[piece.type]}` : "empty"}${isLegal ? ", legal destination" : ""}`}
              >
                {piece && (
                  <span className={`fm-piece is-${piece.color === "w" ? "white" : "black"} is-${names[piece.type]}`} aria-hidden="true">
                    {glyphs[piece.color][piece.type]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="fm-board-meta"><span>You play white</span><span>{selected ? `Selected ${selected}` : "Select a piece"}</span></div>
      </div>
      {promotion && (
        <Dialog titleId="promotion-title" onClose={() => setPromotion(null)} className="cl-promotion">
          <span>Pawn promotion</span>
          <h2 id="promotion-title">CHOOSE A PIECE.</h2>
          <div className="promotion-options">
            {(["q", "r", "b", "n"] as const).map((piece) => (
              <button key={piece} type="button" onClick={() => { commit(promotion.from, promotion.to, piece); setPromotion(null); }}>
                <span aria-hidden="true">{glyphs.w[piece]}</span>{names[piece]}
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </>
  );
}