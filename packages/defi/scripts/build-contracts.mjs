import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import solc from "solc";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const source = readFileSync(resolve(here, "../../../contracts/defi/SeamDeFi.sol"), "utf8");
const marketSource = readFileSync(
  resolve(here, "../../../contracts/defi/SeamTestMarket.sol"),
  "utf8",
);
const scenarioSource = readFileSync(
  resolve(here, "../../../contracts/defi/SeamV3Scenario.sol"),
  "utf8",
);
export function buildContracts() {
  if (!solc.version().startsWith("0.8.38+")) throw new Error("Expected pinned solc 0.8.38");
  const settings = {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "cancun",
    metadata: { bytecodeHash: "none" },
    outputSelection: {
      "*": {
        "": ["ast"],
        "*": [
          "abi",
          "evm.bytecode.object",
          "evm.deployedBytecode.object",
          "evm.deployedBytecode.immutableReferences",
        ],
      },
    },
  };
  const input = {
    language: "Solidity",
    sources: {
      "SeamDeFi.sol": { content: source },
      "SeamTestMarket.sol": { content: marketSource },
      "SeamV3Scenario.sol": { content: scenarioSource },
    },
    settings,
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (path) => {
        if (!path.startsWith("@openzeppelin/contracts/")) return { error: "Unapproved import" };
        return { contents: readFileSync(require.resolve(path), "utf8") };
      },
    }),
  );
  const errors = output.errors?.filter((e) => e.severity === "error");
  if (errors?.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const immutableNames = {};
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable")
      immutableNames[node.id] = node.name;
    for (const value of Object.values(node))
      if (value && typeof value === "object") {
        if (Array.isArray(value)) value.forEach(visit);
        else visit(value);
      }
  }
  for (const value of Object.values(output.sources)) visit(value.ast);
  const contracts = Object.fromEntries(
    ["SeamDeFi.sol", "SeamTestMarket.sol", "SeamV3Scenario.sol"]
      .flatMap((name) => Object.entries(output.contracts[name]))
      .filter(([, v]) => v.evm.bytecode.object)
      .map(([name, v]) => [
        name,
        {
          abi: v.abi,
          bytecode: `0x${v.evm.bytecode.object}`,
          runtime: `0x${v.evm.deployedBytecode.object}`,
          immutableReferences: Object.fromEntries(
            Object.entries(v.evm.deployedBytecode.immutableReferences).map(([id, positions]) => [
              immutableNames[id],
              positions,
            ]),
          ),
        },
      ]),
  );
  return {
    compiler: solc.version(),
    openZeppelin: "5.6.1",
    sourceSha256: createHash("sha256").update(JSON.stringify(input.sources)).digest("hex"),
    settings,
    contracts,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = buildContracts();
  const destination = resolve(here, "../artifacts");
  mkdirSync(destination, { recursive: true });
  writeFileSync(resolve(destination, "contracts.json"), JSON.stringify(built, null, 2) + "\n");
  console.log(
    `Compiled ${Object.keys(built.contracts).join(", ")} with ${built.compiler}; target Cancun (local reference only).`,
  );
}
