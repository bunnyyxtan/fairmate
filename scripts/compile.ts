import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import solc from "solc";
import { PROJECT_ROOT } from "../src/keys.js";

const source = readFileSync(resolve(PROJECT_ROOT, "contracts", "FairMate.sol"), "utf8");

const input = {
  language: "Solidity",
  sources: { "FairMate.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<string, Record<string, { abi: unknown; evm: { bytecode: { object: string } } }>>;
};

const errors = (out.errors ?? []).filter((e) => e.severity === "error");
if (errors.length > 0) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
for (const w of (out.errors ?? []).filter((e) => e.severity !== "error")) {
  console.warn(w.formattedMessage.trim());
}

const contracts = out.contracts?.["FairMate.sol"];
if (!contracts?.MoveJournal || !contracts?.ChallengePot) {
  throw new Error("compile: expected MoveJournal and ChallengePot in output");
}

const buildDir = resolve(PROJECT_ROOT, "build");
mkdirSync(buildDir, { recursive: true });
const artifact = {
  MoveJournal: {
    abi: contracts.MoveJournal.abi,
    bytecode: "0x" + contracts.MoveJournal.evm.bytecode.object,
  },
  ChallengePot: {
    abi: contracts.ChallengePot.abi,
    bytecode: "0x" + contracts.ChallengePot.evm.bytecode.object,
  },
};
writeFileSync(resolve(buildDir, "FairMate.json"), JSON.stringify(artifact, null, 2));
console.log("compiled: MoveJournal", artifact.MoveJournal.bytecode.length / 2 - 1, "bytes");
console.log("compiled: ChallengePot", artifact.ChallengePot.bytecode.length / 2 - 1, "bytes");
