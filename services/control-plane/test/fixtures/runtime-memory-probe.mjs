import { withFallback, v3Spec3002 } from "../../../../packages/chain/tests/metadataMutate.ts";
import { createLiveServices, V3_GENESIS } from "../../src/live.mjs";

const metadata = v3Spec3002();
let currentMetadata, head, number;
const samples = [];
const fetchImpl = async (_url, options) => {
  const request = JSON.parse(options.body);
  const results = {
    chain_getBlockHash: request.params[0] === 0 ? V3_GENESIS : head,
    chain_getFinalizedHead: head,
    chain_getHeader: { number: `0x${number.toString(16)}` },
    state_getRuntimeVersion: { specName: "portaldot-v3", specVersion: 3002, transactionVersion: 2 },
    state_getMetadata: currentMetadata,
    system_properties: { ss58Format: 42, tokenDecimals: 14, tokenSymbol: "tPOT" },
  };
  if (!(request.method in results)) throw new Error(`Unexpected read: ${request.method}`);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: results[request.method] }));
};
let layout, previousHash;
for (let i = 0; i < 40; i++) {
  number = 341000 + i;
  head = `0x${number.toString(16).padStart(64, "0")}`;
  currentMetadata = withFallback(metadata, "Revive", "EthBlockBuilderIR", `0x${i.toString(16).padStart(8, "0")}`);
  // Bypass the per-service result TTL while retaining process-wide runtime caches.
  const result = await createLiveServices(fetchImpl).runtime();
  if (result.metadataHash === previousHash) throw new Error("Raw metadata drift was hidden");
  if (layout && result.layoutHash !== layout) throw new Error("Allow-listed drift changed layout");
  layout = result.layoutHash;
  previousHash = result.metadataHash;
  global.gc();
  samples.push(process.memoryUsage());
}
console.log(JSON.stringify({ iterations: samples.length, samples }));
