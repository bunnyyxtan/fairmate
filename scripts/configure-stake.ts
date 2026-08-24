/**
 * One-shot owner reconfiguration for the entry-stake era:
 *   perWinBounty 0.1 -> 0.2 0G  (the winner's stake back plus the bounty)
 *   dailyCap     0.3 -> 0.6 0G  (still three paid wins per rolling day)
 *
 * Usage:
 *   OG_CHAIN_NETWORK=mainnet npx tsx scripts/configure-stake.ts
 */
import { ethers } from "ethers";
import { pot, refereeAddress } from "../server/chain.js";

const per = ethers.parseEther(process.env.FAIRMATE_NEW_PER_WIN_OG ?? "0.2");
const cap = ethers.parseEther(process.env.FAIRMATE_NEW_DAILY_CAP_OG ?? "0.6");

const [perBefore, capBefore] = await Promise.all([pot.perWinBounty(), pot.dailyCap()]);
console.log(`owner wallet: ${refereeAddress()}`);
console.log(
  `before: perWinBounty ${ethers.formatEther(perBefore)} 0G, dailyCap ${ethers.formatEther(capBefore)} 0G`,
);
const tx = await pot.configureBounty(per, cap);
console.log(`sent: ${tx.hash}`);
const confirmation = await tx.wait();
console.log(`confirmed in block ${confirmation?.blockNumber}`);
const [perAfter, capAfter] = await Promise.all([pot.perWinBounty(), pot.dailyCap()]);
console.log(
  `after: perWinBounty ${ethers.formatEther(perAfter)} 0G, dailyCap ${ethers.formatEther(capAfter)} 0G`,
);
process.exit(0);
