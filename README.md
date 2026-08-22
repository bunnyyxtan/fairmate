# FairMate

**Chess against an AI that provably can't cheat.**

Every move the AI plays is generated inside a TEE-attested model on [0G Compute](https://docs.0g.ai), signed by the enclave, hash-anchored move-by-move on 0G Chain, and re-verifiable by anyone — offline, from raw bytes. Beat it, and a funded on-chain ChallengePot pays out real OG. A challenge prize with receipts, not a promise.

## What is proven, exactly

Three separate guarantees, decomposed so each claim matches its evidence:

1. **Model identity + execution environment.** The provider's TEE attestation binds a signing key to an enclave running the declared model. We archive the raw attestation report (`evidence/attestation/`) and pin the attested signer address.
2. **Response integrity.** Each inference receipt signs `requestHash:responseHash:provider_type:provider_identity:tls_cert_fingerprint`, where `responseHash` is the SHA-256 of the **exact raw response bytes**. We verify both the ECDSA recovery *and* the content binding — the reference SDK's own check verifies the signer only, so these receipts are strictly stronger than stock.
3. **Game integrity.** Every ply is committed on-chain (FEN hash before/after, SAN, receipt commitment) in `MoveJournal` before the game continues. Reordering, substitution, or post-hoc editing breaks the chain.

**Not claimed:** request-side provenance beyond our signed billing headers (the provider's `requestHash` is not client-recomputable — a protocol boundary, documented rather than papered over), and nothing about the model's intent or strength.

## Verifiable artifacts on 0G Galileo testnet

| What | Where |
| --- | --- |
| Attested model | `qwen/qwen2.5-omni-7b`, provider `0xa48f01287233509FD694a22Bf840225062E67836` |
| Attested TEE signer | `0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF` |
| MoveJournal (10 moves anchored) | [`0x799Ba17BcA561708DbA774cb127f4B23CA529804`](https://chainscan-galileo.0g.ai/address/0x799Ba17BcA561708DbA774cb127f4B23CA529804) |
| ChallengePot (paid 0.005 OG to a winner) | [`0x9564D6550c1EB0E62fB57018F9aEB98fe0dcbf19`](https://chainscan-galileo.0g.ai/address/0x9564D6550c1EB0E62fB57018F9aEB98fe0dcbf19) |
| Payout tx | [`0x2390…52f3d`](https://chainscan-galileo.0g.ai/tx/0x239052b4b0df4c7892f73f4496bcf29977a850a3510eb8c1ab1253f980552f3d) |

Double-award attempts revert on-chain. Award-cap exhaustion is additionally covered by local EVM tests.

## Verify it yourself (no wallet needed)

```bash
pnpm install
pnpm verify
```

`verify` re-derives everything from the committed sample evidence with zero trust in the writer: signed hash ↔ raw response bytes, signature recovery ↔ attested signer, response content ↔ unambiguous SAN, full legal replay from the start position, and a live cross-check of all on-chain journal commitments over public RPC. Current result: **135 checks, 0 failures.**

## Run your own attested game

```bash
# one-time: a funded 0G Galileo key (faucet: https://faucet.0g.ai)
mkdir -p .wallet && echo "<private key>" > .wallet/dev-testnet.key

pnpm compile    # solc -> build/FairMate.json
pnpm selfplay   # AI vs AI through the TEE, receipts verified per ply
pnpm anchor     # deploy MoveJournal + commit every move on-chain
pnpm payout     # deploy a funded ChallengePot + pay a verified winner
pnpm balance    # wallet / ledger / per-provider reserve status
```

Note: 0G Compute requires a per-provider ledger reserve (≈1 OG floor) before inference is served, and providers rate-limit to ~10 req/min — the client paces and retries automatically.

## Architecture

```
contracts/FairMate.sol   MoveJournal (per-ply commitments) + ChallengePot (capped, single-award, referee-authorized)
src/compute.ts           attested inference client — receipt parsing, content binding, signer recovery, pacing
src/chess-agent.ts       system prompt + strict move parsing (json | json-normalized | bare-san, nothing looser)
src/canonical.ts         canonical JSON hashing for board states and receipt commitments
scripts/                 selfplay / anchor / payout / verify / balance / services
evidence/                a complete sample game: per-move raw bodies, signatures, receipts, attestation report
```

## Roadmap

- Playable web app: human vs attested AI, live receipt panel, wallet payouts
- ChallengePot v2: award bound to the journal — game must exist, be ended, and pay only the recorded player
- Mainnet deployment against production TeeML providers
- Continuing through 0G waves: spectator verification, multi-model ladders

## License

MIT
