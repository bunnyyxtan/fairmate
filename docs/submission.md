# FairMate submission

## Verified claims

- Production contracts are deployed on 0G Aristotle Mainnet, chain ID `16661`
- `MoveJournal` records sequential SAN/FEN and receipt commitments
- `ChallengePot` is funded by the builder and pays `0.1 OG` for a journal-recorded player win
- Sample game `0x4c14dc1c4d80a261419d0014f9a7866b799b1b99e38e7c6c94440f60ad48d1e6` started, ended and paid on mainnet
- The payout was `0.1 OG` and the current production pot is `2.9 OG`
- Qwen `qwen3.7-max` ran through 0G Router with Verified TeeTLS as the explicit trust boundary
- Mainnet evidence verification passed `581/581` checks
- Public bridge evidence is packaged in `evidence/bridge.mainnet.json`

## Exact public links

- [MoveJournal](https://chainscan.0g.ai/address/0x78718E892705129417636F70ceE11A97ca5AD726)
- [ChallengePot](https://chainscan.0g.ai/address/0x9BD5f06Ce7aB22dfF739Ed2b2886BfB49acc69Ef)
- [Configure 0.1 OG bounty](https://chainscan.0g.ai/tx/0x6aa3022503979c9804ed2931a0eeddd1ac9d44f9b31109f30a68c048afd5c56c)
- [Fund pot with 3 OG](https://chainscan.0g.ai/tx/0x42108033ebc8f6a0a38176c890a126528952f6253d38eaed88ca0fed42ffc558)
- [Deposit 23 OG to Router Payment Vault](https://chainscan.0g.ai/tx/0xc9027ae6332d6ea5a9a1f4108f101076a691c8942bab15d9d3d039936457e75a)
- [Sample game start](https://chainscan.0g.ai/tx/0xb0fb7c2040469b31e8eb02b012f15662f11fcfd96df903c0e102dba58db58cff)
- [Sample game end](https://chainscan.0g.ai/tx/0x421d7e2a19000d58d220e41e8df8e2a3d716cf0429ab46c114e6195fef27f07f)
- [Sample game 0.1 OG award](https://chainscan.0g.ai/tx/0xac8277b8f730ea565884aaac3829c2b96049f5af831c2e6de64f0a5f51b8fff8)
- [Bridge source transaction on Base](https://basescan.org/tx/0x50e8c9b1e24320a3137bf4a9f91581f2c74de0fadd5ece530adbecb4e98fddfd)
- [Source repository](https://github.com/bunnyyxtan/fairmate)

## Evidence-derived budget reconciliation

| Evidence or balance | Amount |
|---|---:|
| Six-ply Router proof signed-response charges | `0.04276914` Neuron/OG-equivalent |
| Full-game signed-response charges | `0.19882763` Neuron/OG-equivalent |
| Total signed Router response charges | **`0.24159677` Neuron/OG-equivalent** |
| Router Payment Vault balance observed 2026-08-23 | `22.5 OG` |
| Operator wallet reserve observed 2026-08-23 | `7.636350473056340054 OG` |
| Production pot observed after payout 2026-08-23 | `2.9 OG` |
| Player recipient observed 2026-08-23 | `0.1 OG` |

The signed-response charges are the evidence-derived Router usage total. Vault funding and internal vault transfers are separate ledger movements. The difference between the `23 OG` vault deposit transaction and the observed `22.5 OG` vault balance is **not** presented as spend.

## Demo checklist

- Open the Prize Fight lobby and connect a wallet
- Start a free 5+0 game as White
- Show legal move gating and live clocks
- Open a Qwen move receipt and identify the Router TeeTLS boundary
- Show the MoveJournal transaction links
- Download the evidence bundle
- Run `pnpm run verify -- --network=mainnet` and show `581/581`
- Show the award transaction and `2.9 OG` remaining pot

## Remaining public URLs

- App: `[APP_URL]`
- Repository: <https://github.com/bunnyyxtan/fairmate>
- Demo video: `[DEMO_URL]`