import { NETWORKS, type NetworkName } from "../src/config.js";
import { createBroker } from "../src/compute.js";
import { loadPrivateKey } from "../src/keys.js";

const netName = (process.env.OG_NET ?? "testnet") as NetworkName;
const net = NETWORKS[netName];
if (!net) throw new Error(`unknown network ${netName}`);

const broker = await createBroker(net, loadPrivateKey());
const services = (await broker.inference.listService()) as unknown as Array<{
  provider: string;
  model: string;
  serviceType: string;
  verifiability: string;
  teeSignerAddress: string;
  inputPrice: bigint;
  outputPrice: bigint;
}>;
console.log(`0G Compute services on ${net.displayName}: ${services.length}`);
for (const s of services) {
  console.log(
    `- ${s.model}\n    provider=${s.provider} type=${s.serviceType} verifiability=${s.verifiability || "(none)"} ` +
      `inPrice=${s.inputPrice} outPrice=${s.outputPrice} tee=${s.teeSignerAddress}`,
  );
}
