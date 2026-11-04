import { createPublicClient, http } from "viem";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// Read-only probe. No wallet, secret, deployment, approval or transaction submission.
const rpc = createPublicClient({
  transport: http("https://test-evm-rpc-v3.portaldot.dev", { retryCount: 1, timeout: 20000 }),
});
const result = {
  checkedAt: new Date().toISOString(),
  endpoint: "https://test-evm-rpc-v3.portaldot.dev",
  expectedChainId: 420420777,
  readOnly: true,
  checks: [],
  marketStatus: "unconfigured",
  limitations: [
    "No reviewed V3 swap/vault contract addresses or ERC-20 mapping have been supplied.",
    "Local reference contracts target Cancun; V3 opcode compatibility and deployment have not been established.",
    "No testnet liquidity, exit capacity, price oracle or economic security audit is claimed.",
  ],
};
for (const [name, read] of [
  ["chainId", () => rpc.getChainId()],
  ["genesis", () => rpc.getBlock({ blockNumber: 0n })],
  ["latest", () => rpc.getBlock()],
  ["finalized", () => rpc.getBlock({ blockTag: "finalized" })],
]) {
  try {
    const value = await read();
    result.checks.push({
      name,
      status: name === "chainId" && value !== 420420777 ? "fail" : "pass",
      value:
        typeof value === "object"
          ? {
              hash: value.hash,
              number: value.number?.toString(),
              timestamp: value.timestamp.toString(),
            }
          : value,
    });
  } catch (error) {
    result.checks.push({ name, status: "unknown", error: error.shortMessage ?? error.message });
  }
}
const folder = resolve(".seam-defi");
mkdirSync(folder, { recursive: true });
writeFileSync(resolve(folder, "v3-audit.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
if (result.checks.some((c) => c.status === "fail")) process.exitCode = 1;
