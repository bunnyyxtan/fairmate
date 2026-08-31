# FairMate

**Beat a TEE-verified chess rival. Win real 0G from a builder-funded pot.**

FairMate is human-versus-AI 5+0 chess for the 0G Bridge Wave 3 hackathon. You play White against **Qwen 3.7 Max** through 0G Mainnet Router. Every Black move is legal-gated by `chess.js`, bound to exact Router request/response evidence, and committed to a public journal on Aristotle Mainnet. A journal-recorded human win unlocks a permissionless contract payout.

Entry to a prize game is a `0.1 0G` stake into the ChallengePot. A journal-recorded win pays `0.2 0G` back, your stake plus a `0.1 0G` bounty. A draw or aborted game refunds the stake automatically. A loss leaves it in the pot. Practice games are free.

<img src="screenshots/lobby.jpg" width="100%" alt="FairMate prize lobby: live 3.1 0G pot, 0.1 0G entry stake, 0.2 0G win payout, qwen3.7-max defending the pot">

## The claim, decomposed exactly

| Claim | Mechanism | Who checks it |
|---|---|---|
| *0G accepted this as a TEE-verified model response* | Router request sets `verify_tee: true`; response must contain `x_0g_trace.tee_verified=true`, the pinned model and pinned provider | **0G Router** is the TeeTLS verification trust boundary |
| *This move is bound to this exact position and response* | FairMate stores exact request/response bytes, recomputes their SHA-256 values, validates model/provider/billing trace fields, and hashes the complete evidence bundle | **Your browser** (`shared/receipt.ts`) and anyone offline (`pnpm run verify`) |
| *The game record can't be quietly rewritten* | Every ply commits `(fenBeforeHash, fenAfterHash, san, receiptHash)` to the `MoveJournal` contract; move numbers are strictly sequential; commits after game end revert | Anyone, from public chain state |
| *A recorded human win pays* | `ChallengePot.award(gameId)` is **permissionless** and reads the winner from the journal; it cannot redirect, double-pay, or exceed caps | Anyone can call `award`; the verifier rechecks contract events and state |
| *What remains trusted* | The referee server controls the clock, determines the result with `chess.js`, and submits transactions | The full SAN/FEN line and timestamps are downloadable; a conflicting record is auditable |

> **Verification boundary:** 0G Router does not expose the raw provider signature for its TeeTLS path. FairMate therefore never claims browser-side signature recovery in Router mode. The browser verifies every exposed byte/hash/trace/commitment property and displays 0G Router as the explicit TeeTLS trust boundary.

<img src="screenshots/verified-move.jpg" width="100%" alt="FairMate match screen: qwen3.7-max thinking with TeeTLS-verified inference burning its clock and journal anchoring in the background">

## Verify before you trust

```bash
pnpm install
pnpm run verify -- --network=mainnet
```

The verifier chooses the RPC from the evidence `chainId`, recomputes request/response/trace commitments, replays the SAN line with `chess.js`, fetches each transaction receipt, compares decoded event arguments, and checks the pot/journal binding. Direct TeeML development evidence additionally recovers the raw ECDSA signer.

Verify a game you played yourself (downloadable from the app):

```bash
pnpm run verify -- --file=my-game.json
```

## Run it

```bash
pnpm install
pnpm run dev        # http://localhost:3000
```

Development defaults deliberately use Galileo + direct TeeML and may use `.wallet/dev-testnet.key`. Production has no such fallback and refuses to boot unless all of the following are present:

- `NODE_ENV=production`
- `OG_CHAIN_NETWORK=mainnet`
- `OG_COMPUTE_TRANSPORT=router`
- `OG_ROUTER_API_KEY` (secret)
- `OG_WALLET_PRIVATE_KEY` (secret)
- `OG_JOURNAL_ADDRESS` and `OG_POT_ADDRESS`

Production also fails closed unless Router reports the exact pinned model/provider, healthy status, TeeTLS, verified trust mode, Intel TDX and dstack metadata.

## Mainnet production configuration

| Component | Pinned value |
|---|---|
| Chain | 0G Aristotle Mainnet, chain ID `16661` |
| Compute | 0G Mainnet Router |
| Model | `qwen3.7-max` |
| Provider identity | `0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0` (active pin, audited 2026-08-31) |
| Prior audited provider | `0xF203A388e9E70F09ece38046a6D40a89cf896309` (delisted by the Router on 2026-08-31; historical evidence recorded under it verifies against the audited set) |
| Game | Standard chess, White vs Black, 5+0 blitz |
| Entry | exactly `0.1 0G` staked to the ChallengePot before a prize game (verified + replay-locked at admission) |
| Prize | `0.2 0G` per player win: the `0.1 0G` stake back plus a `0.1 0G` bounty |
| Refund | draws and aborted games return the stake via `defund`, visible as `Defunded` events |
| Verification | **604/604 checks passed** against the mainnet evidence set |

### Live contracts and funding

| Public record | Address or transaction |
|---|---|
| `MoveJournal` | [`0x78718E892705129417636F70ceE11A97ca5AD726`](https://chainscan.0g.ai/address/0x78718E892705129417636F70ceE11A97ca5AD726) |
| `ChallengePot` | [`0x9BD5f06Ce7aB22dfF739Ed2b2886BfB49acc69Ef`](https://chainscan.0g.ai/address/0x9BD5f06Ce7aB22dfF739Ed2b2886BfB49acc69Ef) |
| Journal deployment | [`0x1d37d6…e3b9b`](https://chainscan.0g.ai/tx/0x1d37d6b2147906618a858caf968fb34ab7a0979636945273d992cc7ed42e3b9b) |
| Pot deployment | [`0x89cc3b…258b8`](https://chainscan.0g.ai/tx/0x89cc3b5a597f87aa9c23a3039fafe2d4841b29196c4c8745a2fe409cd62258b8) |
| Configure `0.1 0G` bounty / `0.3 0G` daily cap | [`0x6aa302…5c56c`](https://chainscan.0g.ai/tx/0x6aa3022503979c9804ed2931a0eeddd1ac9d44f9b31109f30a68c048afd5c56c) |
| Configure `0.2 0G` win payout / `0.6 0G` daily cap (entry-stake era) | [`0xb00326…3d0226`](https://chainscan.0g.ai/tx/0xb003262c859843271b44581dbbe6b140b4045778f7dbaf1353604a244d3d0226) |
| Fund production pot with `3 0G` | [`0x421080…c558`](https://chainscan.0g.ai/tx/0x42108033ebc8f6a0a38176c890a126528952f6253d38eaed88ca0fed42ffc558) |
| Deposit `23 0G` to 0G Router Payment Vault | [`0xc9027a…7e75a`](https://chainscan.0g.ai/tx/0xc9027ae6332d6ea5a9a1f4108f101076a691c8942bab15d9d3d039936457e75a) |

### Real paid sample

| Field | Mainnet evidence |
|---|---|
| Game ID | `0x4c14dc1c4d80a261419d0014f9a7866b799b1b99e38e7c6c94440f60ad48d1e6` |
| Player | [`0x92865D10efbBb4e72A6ed16Ec5FD02Cf9A296eB6`](https://chainscan.0g.ai/address/0x92865D10efbBb4e72A6ed16Ec5FD02Cf9A296eB6) |
| Start | [`0xb0fb7c…58cff`](https://chainscan.0g.ai/tx/0xb0fb7c2040469b31e8eb02b012f15662f11fcfd96df903c0e102dba58db58cff) |
| End | [`0x421d7e…7f07f`](https://chainscan.0g.ai/tx/0x421d7e2a19000d58d220e41e8df8e2a3d716cf0429ab46c114e6195fef27f07f) — player win, Qwen's 5+0 clock expired |
| Award | [`0xac8277…fff8`](https://chainscan.0g.ai/tx/0xac8277b8f730ea565884aaac3829c2b96049f5af831c2e6de64f0a5f51b8fff8) — **0.1 0G** |
| Production pot after payout | **2.9 0G** |

The full game contains 31 plies with exact Router evidence for every Qwen move. `pnpm run verify -- --network=mainnet` completed with **604/604 checks passed** (including the live refund drill).

<img src="screenshots/payout.jpg" width="100%" alt="FairMate victory screen: confirmed 0.2 0G award with journal-recorded result and award transactions">

### Evidence-derived budget reconciliation

| Evidence or observed balance | Amount |
|---|---:|
| Six-ply Router proof signed-response charges | `0.04276914` Neuron/0G-equivalent |
| Full-game signed-response charges | `0.19882763` Neuron/0G-equivalent |
| Total signed Router response charges | **`0.24159677` Neuron/0G-equivalent** |
| Router Payment Vault balance observed 2026-08-23 | `22.5 0G` |
| Operator wallet reserve observed 2026-08-23 | `7.636350473056340054 0G` |
| Production pot observed after payout 2026-08-23 | `2.9 0G` |
| Player recipient observed 2026-08-23 | `0.1 0G` |

Signed-response charges are derived from the Router evidence and represent the verified usage total. Funding and internal vault transfers are separate on-chain or ledger movements. In particular, the difference between the `23 0G` Router Payment Vault deposit transaction and the `22.5 0G` observed vault balance is **not** labeled as spend.

### Archived development deployment (0G Galileo, chain ID 16602)

| Contract | Address |
|---|---|
| `MoveJournal` (product) | [`0xD7170B03c7d1b902FB99aEF46F4f6125588B23C8`](https://chainscan-galileo.0g.ai/address/0xD7170B03c7d1b902FB99aEF46F4f6125588B23C8) |
| `ChallengePot` (product) | [`0x0d5aA82aEaec7bE8b7bC0D2475F5870c718d7894`](https://chainscan-galileo.0g.ai/address/0x0d5aA82aEaec7bE8b7bC0D2475F5870c718d7894) |
| Drill journal + pot (binding tests) | `0x3b720C17b800D1438a85b36Eb343B7f16Cccb218` / `0x19add7e98408a2690404ed8Ec2Ddc9923939Fa7C` |

These addresses and the files without a `.mainnet` suffix are historical development evidence only. They are not presented as the production submission.

## How it works

```
Browser ── canonical SAN ──> Referee + authoritative 5+0 clock
   │                              │
   │                              ├─ chess.js legality/result gate
   │                              ├─ 0G Router: qwen3.7-max + verify_tee=true
   │                              │    └─ exact response + x_0g_trace + billing
   │                              ├─ MoveJournal.commitMove(..., evidenceHash)
   │                              └─ endGame(result) ──> ChallengePot.award()
   │                                                       (permissionless)
   └─ evidence bundle <──── browser recomputes bytes/hashes/commitment
                              Router remains TeeTLS trust boundary
```

- **`contracts/FairMate.sol`** — `MoveJournal` (game lifecycle + per-ply commitments; model moves *must* carry a receipt hash, human moves must not) and `ChallengePot` (journal-bound, permissionless award, per-win bounty + rolling daily cap, funded/defunded transparently by events).
- **`server/`** — authoritative referee, 5+0 clock, serialized chain nonce queue, serialized inference queue, per-IP/global daily admission limits, and bounded corrective retries. AI inference time counts against Qwen; chain-confirmation time does not. A malformed/illegal model reply aborts rather than falling back to a fabricated move.
- **`src/router-compute.ts`** — fail-closed Mainnet Router client with model/provider/trust/pricing pins and exact Router billing capture.
- **`shared/`** — isomorphic verification and deterministic canonical hashing used by browser, server and offline verifier.
- **`app/`** — responsive Prize Fight lobby, legal click/tap board controls, live server-clock interpolation, promotion, honest faults, receipt checks, evidence download and payout state.

## Router evidence anatomy

For every Black ply, FairMate stores:

- exact canonical request bytes, including FEN, complete legal SAN list, pinned model/provider, pricing ceilings and `verify_tee: true`
- exact raw response bytes and their SHA-256 digest
- `x_0g_trace.request_id`, provider, `tee_verified`, token counts and Neuron billing
- a canonical `receiptHash` over the complete evidence bundle, committed in the on-chain move event

The browser recomputes request/response hashes, validates trace consistency, confirms the model output decodes to the SAN that was played, and recomputes `receiptHash`. It does not pretend the Router's internal TeeTLS signature was exposed.

## Budget and abuse controls

- Router price ceilings are pinned before the match starts
- output is bounded per response; illegal replies get at most 2 attempts
- exact Router Neuron cost is accumulated in each downloadable game record
- concurrent games, per-IP starts and global daily starts are capped
- a match already admitted is never terminated because a dollar quota was reached
- the 5-minute AI clock naturally bounds how many paid calls one game can consume

## ChallengePot rules

- Entry is a `0.1 0G` stake per prize game, sent as a plain transfer to the pot from the payout wallet. The referee verifies it on-chain at admission — exact amount, right sender, right destination, mined and successful — and burns the transaction hash so it can never admit a second game. `Funded` / `BountyConfigured` / `Defunded` events keep the economics public; stake refunds are `Defunded` events back to the player.
- Refunds are driven by the same durable outbox as every other anchor: a reverted refund retries up to 3 times with a one-minute backoff. A refund that still fails, or a transfer that never admitted a game (wrong amount, wrong sender), stays in the pot and is returned manually by the pot owner via `defund`.
- Zero-move fairness (the lichess rule): a prize game that ends with no moves played — flag fall or resign alike — aborts and refunds the stake, because no paid inference was consumed. After the first move the 5+0 clock is binding for both sides: a player flag fall leaves the stake in the pot even if the tab is closed (disclosed up front and warned on leave), and a model flag fall pays the player the full win bounty.
- `award(gameId)` — callable by **anyone**. Pays the per-win bounty (`0.2 0G`: stake back + bounty) to the player address recorded in the journal at game start, only for a journal-recorded `PlayerWin`, only once per game, within a rolling 24h cap.
- Live drill (`pnpm run drill -- --network=mainnet`, results in `evidence/pot-drill.mainnet.json`): a real payout to a throwaway address, followed by live-revert proofs for double-award, model-win, no-player, cap-exceeded, ongoing-game, unknown-game, stranger-write, post-end-commit and receiptless-model-move.
- Refund drill (`pnpm run drill:refund -- --network=mainnet`, results in `evidence/refund-drill.mainnet.json`): a real staked game on the production site, deliberately abandoned until the sweep aborts it; the durable outbox then returns the stake — verified live via the `Defunded` event, exact balance reconciliation and the game's downloadable evidence.

## Evidence inventory

| File | What it proves | How |
|---|---|---|
| `evidence/deployment.mainnet.json` | Product contracts, funding and configuration | live chain reads + decoded deployment/config events |
| `evidence/bridge.mainnet.json` | Public Base → 0G funding route and source transaction | sanitized LI.FI/Gas.zip execution fields + public explorer transaction |
| `evidence/sample-game.mainnet.json` | Full Qwen Router game with exact receipts and journal transactions | local recomputation + SAN replay + live receipt/event checks |
| `evidence/pot-drill.mainnet.json` | Pot/journal positive and negative binding paths | real txs + recorded-block `eth_call` reverts |
| `evidence/refund-drill.mainnet.json` | Live draw/abort stake refund on the production site | real staked game + `Defunded` event + exact balance reconciliation |
| `evidence/selfplay.router.mainnet.json` | Dense Router TeeTLS evidence without chain writes | local byte/hash/trace/commitment checks |
| `docs/THREAT-MODEL.md` | attack → defense → proof mapping for every money path | adversarial review with explicit accepted risks |
| `evidence/deployment.json`, `sample-game.json`, `pot-drill.json` | Archived Galileo development proof | explicitly excluded from mainnet submission claims |

## Trust model

**Independently recomputed:** exact Router request/response bytes, model/provider pins, trace consistency, `tee_verified` assertion, billing arithmetic, model SAN binding, full chess replay, on-chain per-ply commitments and payout conditions.

**Trusted boundary:** 0G Router's TeeTLS verification assertion. The Router path does not expose a raw signature that FairMate can recover independently.

**Trusted operationally:** the referee controls clocks and submits the `chess.js`-derived result. It cannot redirect or double-pay a recorded win, but it could refuse to submit one. That refusal is externally auditable from the downloaded SAN/FEN evidence and public move journal.

**Adversarial review:** [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) maps every money-moving and result-integrity attack to its defense and to the artifact that proves it (test, live drill or on-chain event), and states the accepted risks explicitly.

## Wave 3 progress

- **2026-08-22:** working Galileo prototype; live journal, direct TeeML receipts, pot-binding drill and full evidence verifier
- **2026-08-23:** production UI rebuilt as Prize Fight Lobby; complete legal board interactions and 5+0 clocks added
- **2026-08-23:** architecture migrated to Aristotle Mainnet + Qwen 3.7 Max through 0G Router with explicit TeeTLS trust semantics, price pins, cost accounting and fail-closed tests
- **2026-08-23:** Aristotle contracts funded and configured; Router Payment Vault funded; full 31-ply sample paid `0.1 0G`; **581/581** mainnet evidence checks passed
- **2026-08-24:** Entry-stake era: prize games stake `0.1 0G`, wins pay `0.2 0G` (stake back + bounty), draws and aborts auto-refund via `defund` ([config tx](https://chainscan.0g.ai/tx/0xb003262c859843271b44581dbbe6b140b4045778f7dbaf1353604a244d3d0226))
- **2026-08-24:** Fairness hardening: zero-move games abort with a refund instead of settling as silent losses, resign-before-move refunds too, binding-clock rules disclosed in the lobby and warned on tab close, evidence download auto-unlocks after chain sync, full adversarial [threat model](docs/THREAT-MODEL.md) published
- **2026-08-24:** Refund path proven live: a staked production game was abandoned, auto-aborted and refunded `0.1 0G` on Mainnet ([refund tx](https://chainscan.0g.ai/tx/0x39788429d01bf77434dc80f21ed3963872f0114ed14be76ffb9f3f3c4db85c80))
## Scripts

| Command | Purpose |
|---|---|
| `pnpm run verify -- --network=mainnet` | offline + on-chain verification of the production evidence set |
| `pnpm run verify -- --file=…` | verify one downloaded or archived evidence bundle using its `chainId` |
| `pnpm run deploy -- --network=mainnet` | deploy, configure and fund the production journal + pot |
| `pnpm run drill -- --network=mainnet` | live pot-binding drill |
| `pnpm run drill:refund -- --network=mainnet` | live stake-refund drill on the production site |
| `pnpm run selfplay` | Qwen 3.7 Max Mainnet Router self-play evidence, no chain writes |
| `pnpm run compile` | solc → `build/FairMate.json` |
| `pnpm run balance -- --network=mainnet` | referee chain balance (`CHECK_DIRECT_LEDGER=1` for archived direct Compute) |
| `pnpm test` / `pnpm run typecheck` / `pnpm run build` | unit, type and production bundle gates |

## License

MIT
