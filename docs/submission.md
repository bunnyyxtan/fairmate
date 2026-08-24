# FairMate submission

## Verified claims

- Production contracts are deployed on 0G Aristotle Mainnet, chain ID `16661`
- `MoveJournal` records sequential SAN/FEN and receipt commitments
- `ChallengePot` admits a prize game for an exact `0.1 OG` stake, verified on-chain and replay-locked at admission
- A journal-recorded player win pays `0.2 OG`, the stake back plus a `0.1 OG` bounty ([config tx](https://chainscan.0g.ai/tx/0xb003262c859843271b44581dbbe6b140b4045778f7dbaf1353604a244d3d0226))
- Draws and aborted games refund the stake automatically, proven live on mainnet ([refund tx](https://chainscan.0g.ai/tx/0x39788429d01bf77434dc80f21ed3963872f0114ed14be76ffb9f3f3c4db85c80))
- Sample game `0x4c14dc1c4d80a261419d0014f9a7866b799b1b99e38e7c6c94440f60ad48d1e6` started, ended and paid on mainnet; its `0.1 OG` award predates the entry-stake configuration
- Production pot observed at `3.1 OG` on 2026-08-24
- Qwen `qwen3.7-max` ran through 0G Router with Verified TeeTLS as the explicit trust boundary
- Mainnet evidence verification passed `604/604` checks, including the live refund drill
- Public bridge evidence is packaged in `evidence/bridge.mainnet.json`
- [docs/THREAT-MODEL.md](THREAT-MODEL.md) maps every money-moving attack to its defense and proof

## Exact public links

- [MoveJournal](https://chainscan.0g.ai/address/0x78718E892705129417636F70ceE11A97ca5AD726)
- [ChallengePot](https://chainscan.0g.ai/address/0x9BD5f06Ce7aB22dfF739Ed2b2886BfB49acc69Ef)
- [Configure 0.1 OG bounty (pre-stake era)](https://chainscan.0g.ai/tx/0x6aa3022503979c9804ed2931a0eeddd1ac9d44f9b31109f30a68c048afd5c56c)
- [Configure 0.2 OG win payout (entry-stake era)](https://chainscan.0g.ai/tx/0xb003262c859843271b44581dbbe6b140b4045778f7dbaf1353604a244d3d0226)
- [Fund pot with 3 OG](https://chainscan.0g.ai/tx/0x42108033ebc8f6a0a38176c890a126528952f6253d38eaed88ca0fed42ffc558)
- [Deposit 23 OG to Router Payment Vault](https://chainscan.0g.ai/tx/0xc9027ae6332d6ea5a9a1f4108f101076a691c8942bab15d9d3d039936457e75a)
- [Sample game start](https://chainscan.0g.ai/tx/0xb0fb7c2040469b31e8eb02b012f15662f11fcfd96df903c0e102dba58db58cff)
- [Sample game end](https://chainscan.0g.ai/tx/0x421d7e2a19000d58d220e41e8df8e2a3d716cf0429ab46c114e6195fef27f07f)
- [Sample game 0.1 OG award](https://chainscan.0g.ai/tx/0xac8277b8f730ea565884aaac3829c2b96049f5af831c2e6de64f0a5f51b8fff8)
- [Live stake refund](https://chainscan.0g.ai/tx/0x39788429d01bf77434dc80f21ed3963872f0114ed14be76ffb9f3f3c4db85c80)
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
| Production pot observed 2026-08-23, after the sample award | `2.9 OG` |
| Production pot observed 2026-08-24, entry-stake era | `3.1 OG` |
| Player recipient observed 2026-08-23 | `0.1 OG` |

The signed-response charges are the evidence-derived Router usage total. Vault funding and internal vault transfers are separate ledger movements. The difference between the `23 OG` vault deposit transaction and the observed `22.5 OG` vault balance is **not** presented as spend.

## Demo checklist

- Open the Prize Fight lobby and show the live pot
- Start a free practice game, same proof pipeline, no payout
- Stake `0.1 OG` and start a prize game, admission verifies the stake on-chain
- Show legal move gating and live 5+0 clocks
- Open a Qwen move receipt and identify the Router TeeTLS boundary
- Show the MoveJournal transaction links
- Download the evidence bundle
- Run `pnpm run verify -- --network=mainnet` and show `604/604`
- Show the award and refund transactions on the explorer

## Remaining public URLs

- App: <https://fairmate-cyan.vercel.app>
- Repository: <https://github.com/bunnyyxtan/fairmate>
- Demo video: `[DEMO_URL]`
