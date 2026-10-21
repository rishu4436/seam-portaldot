// Pulls the PolkaVM blob, EVM init code and ABI out of the compiler outputs and writes build-info.json.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { keccakAsHex } = require("@polkadot/util-crypto");
const [pvmFile, evmFile, out] = process.argv.slice(2);
const fail = (j, w) => {
  const errs = (j.errors ?? []).filter((e) => e.severity === "error");
  if (errs.length)
    throw new Error(`${w}: ${errs.map((e) => e.formattedMessage ?? e.message).join("\n")}`);
};
const pvm = JSON.parse(readFileSync(pvmFile, "utf8"));
const evm = JSON.parse(readFileSync(evmFile, "utf8"));
fail(pvm, "resolc");
fail(evm, "solc");
const c = pvm.contracts["Escrow.sol"].SeamEscrow;
const blob = Buffer.from(c.evm.bytecode.object.replace(/^0x/, ""), "hex");
const evmInit = Buffer.from(evm.contracts["Escrow.sol"].SeamEscrow.evm.bytecode.object, "hex");
if (blob.subarray(0, 3).toString() !== "PVM")
  throw new Error("resolc output is not a PolkaVM blob (no PVM magic)");
writeFileSync(`${out}/SeamEscrow.pvm`, blob);
writeFileSync(`${out}/SeamEscrow.evm`, evmInit);
writeFileSync(`${out}/SeamEscrow.abi.json`, `${JSON.stringify(c.abi, null, 2)}\n`);
const info = {
  contract: "SeamEscrow",
  source: "Escrow.sol",
  sourceKeccak256: keccakAsHex(readFileSync("Escrow.sol")),
  resolc: process.env.RV,
  solc: process.env.SV,
  settings: { resolcOptimizer: "z", solcOptimizerRuns: 200, bytecodeHash: "none" },
  pvm: {
    bytes: blob.length,
    codeHash: keccakAsHex(blob),
    note: "pallet-revive code hash = keccak256(blob)",
  },
  evm: { initBytes: evmInit.length, initCodeHash: keccakAsHex(evmInit) },
};
writeFileSync(`${out}/build-info.json`, `${JSON.stringify(info, null, 2)}\n`);
console.log(JSON.stringify(info, null, 2));
