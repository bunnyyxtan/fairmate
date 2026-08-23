/**
 * Wire types shared by the FairMate server and web client.
 * The server is the only writer of these structures; the client treats the
 * receipt fields as UNTRUSTED input and re-verifies them locally
 * (see shared/receipt.ts).
 */

export type Mover = "player" | "model";

export type GameStatus =
  | "awaiting_player" // player (White) to move
  | "model_thinking" // AI move requested from 0G Compute, receipt pending
  | "ended" // result recorded (see result field)
  | "fault"; // model produced no legal move / infra fault — game aborted

export type GameResult = "ongoing" | "player_win" | "model_win" | "draw" | "aborted";

export type TxStatus = "pending" | "confirmed" | "failed";
export type VerificationScheme = "direct-teeml" | "router-teetls";

export interface ClockState {
  /** Starting time per side. FairMate uses 5+0 blitz by default. */
  initialMs: number;
  /** Authoritative remaining time, updated by the server. */
  playerMs: number;
  modelMs: number;
  /** Side whose time is currently running. Null once the game ends. */
  active: Mover | null;
  /** Server epoch milliseconds at which the active side's displayed balance began running. */
  activeSince: number | null;
}

export interface TxRef {
  status: TxStatus;
  txHash?: string;
  blockNumber?: number;
  error?: string;
}

export interface DirectReceiptBundle {
  /** Legacy/direct-provider path retained only for explicitly labelled development. */
  scheme: "direct-teeml";
  chatID: string;
  model: string;
  provider: string;
  sigText: string;
  signature: string;
  effectiveSigner: string;
  rawBody: string;
  rawBodySha256: string;
  /** exact JSON string of the request body sent to the provider */
  requestBodyJson: string;
  receipt: {
    requestHash: string;
    responseHash: string;
    providerType: string;
    providerIdentity: string;
    tlsCertFingerprint: string;
  };
  /** canonicalHash({ sigText, signature, rawBodySha256 }) — committed on-chain */
  receiptHash: string;
  latencyMs: number;
}

export interface RouterTrace {
  requestId: string;
  provider: string;
  teeVerified: true;
  billing: {
    inputCostNeuron: string;
    outputCostNeuron: string;
    totalCostNeuron: string;
  };
}

export interface RouterRequestConstraints {
  /** Non-secret Router header that pins the selected provider. */
  providerAddress: string;
  /** Router price-ceiling header values, committed exactly as sent. */
  maxPromptPriceUsd: string;
  maxCompletionPriceUsd: string;
}

export interface RouterReceiptBundle {
  scheme: "router-teetls";
  chatID: string;
  model: string;
  provider: string;
  /**
   * For Router TeeTLS this is the on-chain provider identity returned in
   * x_0g_trace, not a raw-signature recovery address.
   */
  effectiveSigner: string;
  rawBody: string;
  rawBodySha256: string;
  requestBodyJson: string;
  requestBodySha256: string;
  requestConstraints: RouterRequestConstraints;
  trace: RouterTrace;
  /** Commitment to request bytes, response bytes, model, provider and verified trace. */
  receiptHash: string;
  latencyMs: number;
}

export type ReceiptBundle = DirectReceiptBundle | RouterReceiptBundle;

export interface PlyRecord {
  ply: number; // 1-based half-move number
  mover: Mover;
  san: string;
  fenBefore: string;
  fenAfter: string;
  fenBeforeHash: string;
  fenAfterHash: string;
  /** model plies only */
  receipt?: ReceiptBundle;
  receiptHash: string | null;
  /** Exact Router charge for this model ply, when Router billing metadata is available. */
  computeCostNeuron?: string;
  /** model's stated reasoning line, if it offered one */
  why?: string;
  /** on-chain commitMove tx for this ply */
  chain: TxRef & { moveNo?: number };
  at: number; // unix ms
}

export interface ChainInfo {
  network: string;
  chainId: number;
  explorer: string;
  journalAddress: string;
  potAddress: string;
}

/** On-chain entry stake that admitted a prize game. */
export interface StakeInfo {
  txHash: string;
  /** staking wallet; always equals the payout address */
  from: string;
  amountOg: string;
  blockNumber: number;
  verifiedAt: number;
}

export interface GameState {
  gameId: string; // bytes32
  playerAddress: string | null;
  playerColor: "w";
  fen: string;
  sans: string[]; // full SAN line from start
  status: GameStatus;
  result: GameResult;
  clock: ClockState;
  /** why the game ended the way it did (checkmate/resignation/stalemate/…) */
  endReason?: string;
  plies: PlyRecord[];
  chain: ChainInfo;
  startTx: TxRef;
  endTx?: TxRef;
  awardTx?: TxRef & { amountOg?: string };
  /** entry stake for prize games; practice games have none */
  stake?: StakeInfo;
  /** stake refund for staked games that end in a draw or abort */
  refundTx?: TxRef & { amountOg?: string };
  model: string;
  provider: string;
  effectiveSigner: string;
  verificationScheme: VerificationScheme;
  /** Sum of exact Router x_0g_trace billing.total_cost values for this game. */
  computeCostNeuron: string;
  /** set when the model faulted; game is aborted, no fake move is ever played */
  faultReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PotInfo {
  chain: ChainInfo;
  potBalanceOg: string;
  perWinBountyOg: string;
  /** OG a player must stake into the pot to start a prize game */
  entryFeeOg: string;
  dailyCapOg: string;
  paidInWindowOg: string;
  windowStart: number;
  refereeAddress: string;
  model: string;
  provider: string;
  effectiveSigner: string;
  verificationScheme: VerificationScheme;
  /** true once boot-time attestService + signer resolution completed */
  attestationReady: boolean;
}

export interface AttestationInfo {
  provider: string;
  model: string;
  effectiveSigner: string;
  verificationScheme: VerificationScheme;
  /** NVIDIA / intel quote material as returned by the provider, pass-through */
  quote: unknown;
  verifiedAt: number;
  notes: string[];
  /** Exact trust boundary shown to players and copied into evidence. */
  trustBoundary: string;
}

export interface CreateGameRequest {
  /** payout address; required for prize games, omitted for practice */
  playerAddress?: string;
  /** hash of the entry-stake transfer to the ChallengePot; required with playerAddress */
  stakeTxHash?: string;
}

export interface PlayerMoveRequest {
  san: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}
