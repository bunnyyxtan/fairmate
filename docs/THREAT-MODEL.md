# FairMate threat model

Adversarial review of every surface where money, game results or proof can be
attacked. Each row maps an attack to its defense and to the artifact that
proves the defense is real (code, test, live drill or on-chain event). The
verifier (`pnpm run verify -- --network=mainnet`) re-derives the proof set
from raw material on every run.

## Assets

| Asset | Where it lives | Why an attacker wants it |
|---|---|---|
| ChallengePot balance | `ChallengePot` contract, Aristotle Mainnet | direct theft target |
| Player entry stakes | 0.1 OG transfers into the pot | steal, replay or strand them |
| Win bounties | `award()` payouts, 0.2 OG per journal win | trigger without winning |
| Game results | `MoveJournal` + referee Postgres | forge a win, erase a loss |
| Inference receipts | Router TeeTLS receipts in evidence bundles | fake the model, fabricate moves |
| Referee wallet key | server secret | sign anything (custody boundary) |

## Money-moving attacks

| Attack | Defense | Proof |
|---|---|---|
| Stake overpay/underpay to game a fixed 0.2 OG award | exact-amount check: `valueWei === requiredWei`, not a minimum | `stake-rules.test.ts`, admission 402/400 paths |
| Stake sent from a wallet other than the payout address | `tx.from` must equal the payout address, so the refundee and payee are the staker | `stake-rules.ts`, negative admission tests |
| Stake hash replayed for a second game | burn table insert is atomic with game insert in one transaction, second use hits the unique key and admission fails 409 | `fairmate-store.test.ts` replay tests, live UI refusal |
| Unconfirmed or reverted stake tx pasted at admission | receipt must exist with `status === 1` before a game starts, retryable 409 while unmined | `verifyStakeDeposit`, admission negatives |
| Award triggered without a journal win | `award(gameId)` pays only a journal-recorded `PlayerWin`, only once, only to the journal-recorded player | live mainnet drill: double-award, model-win, stranger-write and post-end-commit all revert (`evidence/pot-drill.mainnet.json`) |
| Pot drained via many wins | on-chain rolling 24h award cap (0.6 OG) plus per-IP, global-daily and concurrency admission caps | `BountyConfigured` event, config tx in README |
| Refund never arrives after a draw/abort | refunds ride the durable outbox, retried up to 3 times with backoff, terminal failures stay in the pot and are operator-recoverable, never burned | `durable-outbox.test.ts` retry/exhaustion tests |
| Walk away mid-game, then demand the stake back | disclosed rule: after the first move the 5+0 clock is binding, a flag fall is a loss (refunding abandonment would let losing players yank stakes) | fairness dialog copy, `referee-state.test.ts` |
| Stake lost without playing at all | zero-move carve-out (lichess rule): a flag fall or resign with no moves played aborts the game and refunds the stake | `flagFallOutcome`, `referee-state.test.ts` |
| Free win from a model outage | inference failures fault the game as `aborted` (stake refunded, never a fabricated move); only a genuine model clock expiry pays, bounded by the 24h award cap | `faultGame` path, fail-closed tests |

## Result-integrity attacks

| Attack | Defense | Proof |
|---|---|---|
| Fabricated model move | every model ply carries a Router TeeTLS receipt; the signed response must contain the SAN that was played for the signed position | `shared/receipt.ts`, 581/581 verifier checks |
| Model or provider swapped mid-match | model + provider pinned at attestation, recorded per game, receipts bind to the attested TEE signer | `router-policy.ts`, receipt recovery checks |
| Server rewrites history after the fact | every ply is anchored to `MoveJournal` with FEN hashes; the verifier replays the SAN line and compares chain events to recomputed values | `journal-verifier.ts`, `pnpm run verify` |
| Optimistic state diverges from chain | reconcile-on-read verifies journal state; a definitive anchor revert rolls local state back to the anchored prefix, fail-closed | `rollbackToAnchored`, recovery tests |
| Lost response / instance swap freezes a game | authoritative state re-synced by client polling, moves are idempotent server-side, recovery aborts in-flight inference fail-closed and voids pending payouts | recovery + two-replica tests |

## Liveness and settlement

| Concern | Mechanism |
|---|---|
| Games left mid-air on serverless | every request runs a throttled sweep (60s) via `waitUntil`; flag falls also settle synchronously on any read of the game |
| Zero traffic for a long period | daily Vercel cron pings `/api/health`, which rides the same sweep path, bounding unattended settlement |
| Stuck anchors | each sweep re-drains the durable outbox; Postgres advisory locks serialize the wallet so concurrent instances never race a nonce |
| Abandoned mid-inference games | sweep resumes owned model turns via the inference lease, or recovery aborts them fail-closed with refund |

## Accepted risks, stated honestly

- **Referee custody.** The referee wallet funds anchors and holds admission
  authority. It cannot redirect or double-pay a recorded win (contract-bound),
  but it could refuse to submit one. That refusal is externally auditable from
  the journal plus downloaded evidence.
- **Router trust boundary.** The Router asserts TeeTLS verification; it does
  not expose a raw TEE signature FairMate can recover independently. Stated in
  the UI attestation dialog and README trust model.
- **Replay scope.** Stake burns live in the referee's database, scoped to the
  single production referee instance bound to this pot. A second referee
  sharing the same pot would need a shared burn store; none exists or is
  planned for this deployment.
- **Chain finality.** Stakes are accepted at receipt status 1. Aristotle
  finality is fast; a deep reorg after admission is treated as an operator
  incident (games are auditable against the journal either way).
