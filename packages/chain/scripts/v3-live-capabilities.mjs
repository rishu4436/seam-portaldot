#!/usr/bin/env node
// READ-ONLY: live capabilities of the V3 test node (per SEAM action: supported or not, from the node's own metadata).
// Writes evidence/testnet-v3/capabilities-<timestamp>.json. Signs and sends nothing.
//   node packages/chain/scripts/v3-live-capabilities.mjs [https://test-node-v3.portaldot.dev]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { httpRpcClient, readLiveCapabilities } from "../dist/index.js";

const URL_ =
  process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ?? "https://test-node-v3.portaldot.dev";
if (/mainnet/i.test(URL_)) throw new Error("refusing: this script is for the V3 test node");
const V3_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const c = httpRpcClient(URL_, { requestTimeoutMs: 90_000 });
try {
  const caps = await readLiveCapabilities((m, p) => c.send(m, p), { endpoint: URL_ });
  if (caps.fingerprint.genesisHash.toLowerCase() !== V3_GENESIS)
    throw new Error("not the V3 test node");
  const out = {
    kind: "seam-live-capabilities",
    generatedAt: new Date().toISOString(),
    rpcRequests: c.stats,
    ...caps,
  };
  const file = fileURLToPath(
    new URL(`../../../evidence/testnet-v3/capabilities-${Date.now()}.json`, import.meta.url),
  );
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  for (const a of Object.values(caps.actions))
    console.log(
      `${a.kind.padEnd(30)} ${a.supported ? "supported  " : "unsupported"} ${a.reasonCode ?? a.presence} ${a.palletIndex ?? "-"}/${a.callIndex ?? "-"}`,
    );
  console.log(
    `spec ${caps.fingerprint.specName} ${caps.fingerprint.specVersion} at #${caps.atBlock.number}; layout ${caps.metadataLayoutHash} -> ${file}`,
  );
} finally {
  c.close();
}
