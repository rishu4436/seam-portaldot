// Writes EVM init/runtime artifacts for EscrowMin.sol variants plus the hand-minimal variant, and build-info.json.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { keccakAsHex } = require("@polkadot/util-crypto");
const [tmp, out] = process.argv.slice(2);
const variants = [];
for (const runs of [1, 200]) {
  const j = JSON.parse(readFileSync(`${tmp}/r${runs}.json`, "utf8"));
  const errs = (j.errors ?? []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  for (const name of ["SeamEscrowMin", "SeamEscrowOne"]) {
    const c = j.contracts["EscrowMin.sol"][name];
    const init = Buffer.from(c.evm.bytecode.object, "hex");
    const rt = Buffer.from(c.evm.deployedBytecode.object, "hex");
    const base = `${name}-r${runs}`;
    writeFileSync(`${out}/${base}.init`, init);
    writeFileSync(`${out}/${base}.runtime`, rt);
    if (runs === 200)
      writeFileSync(`${out}/${name}.abi.json`, `${JSON.stringify(c.abi, null, 2)}\n`);
    variants.push({
      id: base,
      contract: name,
      solcOptimizerRuns: runs,
      initBytes: init.length,
      initKeccak: keccakAsHex(init),
      runtimeBytes: rt.length,
      runtimeKeccak: keccakAsHex(rt),
      runtimeHasImmutables:
        Object.keys(c.evm.deployedBytecode.immutableReferences ?? {}).length > 0,
      constructorArgs:
        name === "SeamEscrowOne"
          ? "(address payee, uint256 releaseBlock) ABI-encoded after init code"
          : "none",
    });
  }
}
// Hand-minimal: not an escrow. Smallest possible contract (runtime = STOP, 1 byte) to measure the per-contract floor.
// init: PUSH1 1 PUSH1 0x0c PUSH1 0 CODECOPY PUSH1 1 PUSH1 0 RETURN | 00
const floorInit = Buffer.from("6001600c60003960016000f300", "hex");
writeFileSync(`${out}/Floor.init`, floorInit);
variants.push({
  id: "Floor-stop",
  contract: "hand-minimal (runtime 0x00 = STOP; NOT an escrow, floor probe only)",
  initBytes: floorInit.length,
  initKeccak: keccakAsHex(floorInit),
  runtimeBytes: 1,
  runtimeKeccak: keccakAsHex(Buffer.from("00", "hex")),
});
const info = {
  source: "EscrowMin.sol",
  sourceKeccak256: keccakAsHex(readFileSync("EscrowMin.sol")),
  solc: process.env.SV,
  settings: { bytecodeHash: "none", appendCBOR: false },
  variants,
};
writeFileSync(`${out}/build-info.json`, `${JSON.stringify(info, null, 2)}\n`);
console.log(
  JSON.stringify(
    variants.map((v) => [v.id, v.initBytes, v.runtimeBytes]),
    null,
    0,
  ),
);
