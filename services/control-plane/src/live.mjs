import { metadataLayoutHash, verifyPlan } from "@seam/compiler";
import {
  factsFromChainInputs,
  createReceiptReader,
  createReadFailover,
  createJsonRpcTransport,
  V3_RPC_ENDPOINTS,
} from "@seam/chain";
import {
  verifyReceiptLive,
  verifyConsoleReceiptLive,
  isConsoleReceipt,
  inspectEvidenceBundle,
} from "@seam/sdk";

export const RPC_URL = "https://test-node-v3.portaldot.dev";
export const V3_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const READ_METHODS = new Set([
  "chain_getBlockHash",
  "chain_getFinalizedHead",
  "chain_getHeader",
  "chain_getBlock",
  "state_getRuntimeVersion",
  "state_getMetadata",
  "state_getStorage",
  "system_properties",
]);
const hex32 = (value) => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const blockNumber = (value) => {
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid block number.");
  return number;
};

export function createReadRpc(
  fetchImpl = fetch,
  deadline = Infinity,
  endpoints = V3_RPC_ENDPOINTS,
) {
  let activeEndpoint = endpoints[0];
  const send = createReadFailover({
    endpoints,
    deadline,
    onFailover: (endpoint) => {
      activeEndpoint = endpoint;
    },
    transport: (endpoint) => createJsonRpcTransport(endpoint, { fetch: fetchImpl, deadline }),
  });
  const read = async (method, params) => {
    if (!READ_METHODS.has(method))
      throw new Error("This service only permits read-only chain methods.");
    return send(method, params);
  };
  return Object.assign(read, { endpoint: () => activeEndpoint });
}

async function factsAt(send, at) {
  const [genesis, runtimeVersion, metadataHex, properties, header] = await Promise.all([
    send("chain_getBlockHash", [0]),
    send("state_getRuntimeVersion", [at]),
    send("state_getMetadata", [at]),
    send("system_properties", []),
    send("chain_getHeader", [at]),
  ]);
  if (genesis !== V3_GENESIS || runtimeVersion?.specName !== "portaldot-v3")
    throw new Error("The reader is not connected to the hosted V3 testnet.");
  if (!header || !hex32(at)) throw new Error("The block is not readable.");
  return factsFromChainInputs({
    genesisHash: genesis,
    runtimeVersion,
    metadataHex,
    properties,
    head: { hash: at, number: blockNumber(header.number) },
  });
}

export function createLiveServices(fetchImpl = fetch, endpoints = V3_RPC_ENDPOINTS) {
  let cached, pending;
  async function runtime() {
    if (cached && Date.now() - cached.at < 20000) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const send = createReadRpc(fetchImpl, Date.now() + 25000, endpoints),
        head = await send("chain_getFinalizedHead", []);
      const facts = await factsAt(send, head),
        fp = facts.fingerprint;
      const value = {
        genesisHash: fp.genesisHash,
        specName: fp.specName,
        specVersion: fp.specVersion,
        transactionVersion: fp.transactionVersion,
        metadataHash: fp.metadataHash,
        layoutHash: metadataLayoutHash(facts.source.metadataHex),
        finalizedBlock: facts.blockNumber,
        checkedAt: new Date().toISOString(),
      };
      cached = { at: Date.now(), value };
      return value;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  }
  async function verify(bundle) {
    const offline = inspectEvidenceBundle(bundle);
    if (offline.status === "failed")
      return {
        status: "failed",
        checks: offline.checks,
        checkedAt: new Date().toISOString(),
        endpoint: RPC_URL,
      };
    const send = createReadRpc(fetchImpl, Date.now() + 40000, endpoints);
    const head = await send("chain_getFinalizedHead", []);
    await factsAt(send, head);
    let firstFacts;
    const reader = createReceiptReader(send, {
      expectedGenesis: V3_GENESIS,
      expectedSpec: "portaldot-v3",
      onBlockFacts: (facts) => {
        firstFacts ??= facts;
      },
    });
    const result = isConsoleReceipt(bundle.receipt)
      ? await verifyConsoleReceiptLive(bundle.receipt, reader)
      : await verifyReceiptLive(bundle.receipt, reader, {
          plan: bundle.plan,
          runtime: bundle.runtime,
          effects: bundle.effects,
        });
    if (bundle.manifest && firstFacts) {
      const bytes = verifyPlan(bundle.manifest, bundle.plan, firstFacts, {
        abis: bundle.abis,
        allowAtomicUnverified: bundle.plan.mode === "atomic_unverified",
      });
      if (!bytes.ok) {
        result.status = "failed";
        (result.problems ??= []).push(
          `The manifest does not compile to the observed plan (${bytes.issues.map((i) => i.code).join(", ")}).`,
        );
      }
    } else {
      if (result.status === "chain_verified") result.status = "unknown";
      (result.notes ??= []).push(
        "Manifest recompilation was unavailable. The supplied intent has not been independently bound to its call bytes.",
      );
    }
    return { ...result, checkedAt: new Date().toISOString(), endpoint: send.endpoint() };
  }
  return { runtime, verify };
}
