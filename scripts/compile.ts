// Compiles contracts/RealEstateEscrow.sol with solc-js into artifacts/RealEstateEscrow.json.
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error solc ships without types
import solc from "solc";
import { ARTIFACT_FILE, ROOT } from "../src/config.js";

const source = fs.readFileSync(path.join(ROOT, "contracts", "RealEstateEscrow.sol"), "utf8");
const input = {
  language: "Solidity",
  sources: { "RealEstateEscrow.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris", // conservative target; avoids opcodes newer chains may not support
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
for (const e of output.errors ?? []) console.log(e.formattedMessage);
if (errors.length) process.exit(1);

const c = output.contracts["RealEstateEscrow.sol"].RealEstateEscrow;
fs.mkdirSync(path.dirname(ARTIFACT_FILE), { recursive: true });
fs.writeFileSync(ARTIFACT_FILE, JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2));
console.log(`Compiled RealEstateEscrow -> ${path.relative(ROOT, ARTIFACT_FILE)}`);
