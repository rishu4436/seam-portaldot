import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { encodeDeployData, decodeAbiParameters, parseAbiParameters, keccak256, toHex } from "viem";
const built = JSON.parse(readFileSync(resolve("packages/defi/artifacts/contracts.json"), "utf8"));
const program = built.contracts.SeamV3Scenario;
if (!program) throw new Error("Run npm run defi:contracts first");
const endpoint = "https://test-evm-rpc-v3.portaldot.dev";
let id = 0;
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    signal: AbortSignal.timeout(55000),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
if (BigInt(await rpc("eth_chainId", [])) !== 420420777n)
  throw new Error("V3 chain identity mismatch");
const genesis = await rpc("eth_getBlockByNumber", ["0x0", false]);
if (genesis.hash !== "0x7c05b2dc7486f81a693d676553fa13f380b5be16da7c739b182931cd6cf07001")
  throw new Error("V3 EVM genesis mismatch");
const deploymentId = keccak256(toHex("Seam V3 read-only complete-flow compatibility scenario"));
const data = encodeDeployData({
  abi: program.abi,
  bytecode: program.bytecode,
  args: [deploymentId],
});
const sender = "0x0000000000000000000000000000000000001234";
const gasPrice = await rpc("eth_gasPrice", []);
const probe = "0x0000000000000000000000000000000000001235";
const probeResult = await rpc("eth_call", [
  { to: probe, data: "0x" },
  "latest",
  {
    [probe]: {
      code: "0x60005460005260206000f3",
      stateDiff: { [toHex(0n, { size: 32 })]: toHex(42n, { size: 32 }) },
    },
  },
]);
if (BigInt(probeResult) !== 42n)
  throw new Error("V3 allowance-preview storage overrides are unavailable");
const request = { from: sender, data, gas: "0xffffffffffffffff", gasPrice };
const overrides = { [sender]: { balance: toHex(10n ** 30n) } };
console.log(
  `Simulating complete market creation, swap, deposit and redeem on V3; ${data.length / 2 - 1} bytes of creation input. Read-only state override; no signature or submission.`,
);
const output = await rpc("eth_call", [request, "latest", overrides]);
const [passed, swapOutput, depositShares, redeemedAssets, finalDollars, finalEthers] =
  decodeAbiParameters(
    parseAbiParameters("uint256,uint256,uint256,uint256,uint256,uint256"),
    output,
  );
if (
  passed !== 1n ||
  depositShares !== 100_000_000n ||
  redeemedAssets !== 100_000_000n ||
  finalDollars !== 9_900_000_000n
)
  throw new Error("V3 scenario postconditions did not match");
const result = {
  checkedAt: new Date().toISOString(),
  chainId: 420420777,
  genesis: genesis.hash,
  readOnly: true,
  stateCommitted: false,
  storageOverrideVerified: true,
  compiler: built.compiler,
  sourceSha256: built.sourceSha256,
  creationInputHash: keccak256(data),
  results: {
    swapOutput: swapOutput.toString(),
    depositShares: depositShares.toString(),
    redeemedAssets: redeemedAssets.toString(),
    finalDollars: finalDollars.toString(),
    finalEthers: finalEthers.toString(),
  },
  limitations: [
    "This is an RPC eth_call simulation with temporary account funding. No contracts or liquidity were persistently deployed.",
    "Engineering compatibility evidence is not an independent security audit.",
  ],
};
mkdirSync(resolve(".seam-defi"), { recursive: true });
writeFileSync(
  resolve(".seam-defi/v3-complete-flow-simulation.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
