import { ethers } from "ethers";
import { NETWORKS } from "../src/config.js";
import { LEDGER_MANAGER_ABI, createBroker } from "../src/compute.js";
import { loadPrivateKey } from "../src/keys.js";

const net = NETWORKS.testnet;
const key = loadPrivateKey();
const provider = new ethers.JsonRpcProvider(net.evmRpc);
const wallet = new ethers.Wallet(key, provider);
const addr = await wallet.getAddress();

console.log("network:", net.displayName, `(chainId ${net.chainId})`);
console.log("wallet :", addr);
const bal = await provider.getBalance(addr);
console.log("balance:", ethers.formatEther(bal), "OG");

const ledger = new ethers.Contract(net.ledgerManager, LEDGER_MANAGER_ABI, provider);
try {
  const min: bigint = await ledger.MIN_ACCOUNT_BALANCE();
  console.log("ledger MIN_ACCOUNT_BALANCE:", ethers.formatEther(min), "OG");
} catch (e) {
  console.log("ledger MIN_ACCOUNT_BALANCE: read failed:", (e as Error).message.slice(0, 120));
}
try {
  const l = (await ledger.getLedger(addr)) as { availableBalance: bigint; totalBalance: bigint };
  console.log("ledger available:", ethers.formatEther(l.availableBalance), "OG");
} catch {
  console.log("ledger: none for this wallet yet");
}

// read-only service discovery (no funds needed)
if (process.env.LIST_SERVICES === "1") {
  const broker = await createBroker(net, key);
  const services = (await broker.inference.listService()) as unknown as Array<{
    provider: string;
    model: string;
    verifiability: string;
    teeSignerAddress: string;
    url: string;
  }>;
  console.log(`\n0G Compute services on ${net.name}: ${services.length}`);
  for (const s of services) {
    console.log(
      `- ${s.model}  provider=${s.provider}  verifiability=${s.verifiability || "(none)"}  tee=${s.teeSignerAddress?.slice(0, 10)}…`,
    );
  }
}
