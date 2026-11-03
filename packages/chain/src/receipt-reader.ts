import type { Hex, RuntimeFacts } from "@seam/compiler/facts";
import { factsFromChainInputs } from "./facts-core.js";
import { extractSignedCall } from "./signing.js";
import { outcomeForExtrinsic, toChainEvent } from "./events.js";
import { extrinsicHash, SYSTEM_EVENTS_KEY } from "./runtime.js";
import { clientFromSend, rpc, toSafeNumber, type RpcSend } from "./rpc-core.js";
import { xxhashAsHex } from "@polkadot/util-crypto";

/** A read-only SDK-compatible receipt reader using the runtime that actually executed each block. */
export function createReceiptReader(
  send: RpcSend,
  options: {
    expectedGenesis: Hex;
    expectedSpec?: string;
    typesBundle?: string;
    onBlockFacts?: (facts: RuntimeFacts) => void;
  },
) {
  const client = clientFromSend(send);
  const blocks = new Map<string, { facts: RuntimeFacts; extrinsics: Hex[]; events: Hex }>();
  async function factsAt(at: Hex): Promise<RuntimeFacts> {
    const [genesis, version, metadata, properties, header] = await Promise.all([
      rpc<Hex>(client, "chain_getBlockHash", [0]),
      rpc(client, "state_getRuntimeVersion", [at]),
      rpc<Hex>(client, "state_getMetadata", [at]),
      rpc(client, "system_properties", []),
      rpc<{ number: string } | null>(client, "chain_getHeader", [at]),
    ]);
    const runtimeVersion = version as { specName: string };
    if (
      genesis.toLowerCase() !== options.expectedGenesis.toLowerCase() ||
      (options.expectedSpec && runtimeVersion.specName !== options.expectedSpec)
    )
      throw new Error("The receipt reader is connected to the wrong network.");
    if (!header) throw new Error("Block header unavailable.");
    return factsFromChainInputs(
      {
        genesisHash: genesis,
        runtimeVersion: version,
        metadataHex: metadata,
        properties,
        head: { hash: at, number: toSafeNumber(header.number) },
      } as Parameters<typeof factsFromChainInputs>[0],
      { typesBundle: options.typesBundle },
    );
  }
  return {
    async runtimeFingerprint() {
      const head = await rpc<Hex>(client, "chain_getFinalizedHead", []);
      return (await factsAt(head)).fingerprint;
    },
    async finalizedNumber() {
      const head = await rpc<Hex>(client, "chain_getFinalizedHead", []);
      const header = await rpc<{ number: string } | null>(client, "chain_getHeader", [head]);
      if (!header) throw new Error("Finalized header unavailable.");
      return toSafeNumber(header.number);
    },
    canonicalHash: (number: number) => rpc<Hex | null>(client, "chain_getBlockHash", [number]),
    async originalAccount(address: string, at?: Hex) {
      if (!/^0x[\da-f]{40}$/i.test(address)) throw new Error("Invalid Revive address.");
      const key =
        xxhashAsHex("Revive", 128) +
        xxhashAsHex("OriginalAccount", 128).slice(2) +
        address.slice(2);
      const block = at ?? (await rpc<Hex>(client, "chain_getFinalizedHead", []));
      const value = await rpc<Hex | null>(client, "state_getStorage", [key, block]);
      if (value !== null && !/^0x[\da-f]{64}$/i.test(value))
        throw new Error("Unrecognized account mapping.");
      return value;
    },
    async readTx(blockHash: Hex, txHash: Hex) {
      let block = blocks.get(blockHash);
      if (!block) {
        const [header, body, events] = await Promise.all([
          rpc<{ parentHash: Hex } | null>(client, "chain_getHeader", [blockHash]),
          rpc<{ block?: { extrinsics?: Hex[] } } | null>(client, "chain_getBlock", [blockHash]),
          rpc<Hex | null>(client, "state_getStorage", [SYSTEM_EVENTS_KEY, blockHash]),
        ]);
        if (!header || !Array.isArray(body?.block?.extrinsics) || !events)
          throw new Error("Block body or events unavailable.");
        const facts = await factsAt(header.parentHash);
        block = { facts, extrinsics: body.block.extrinsics, events };
        if (blocks.size >= 16) blocks.delete(blocks.keys().next().value!);
        blocks.set(blockHash, block);
        options.onBlockFacts?.(facts);
      }
      const index = block.extrinsics.findIndex(
        (xt) => extrinsicHash(xt).toLowerCase() === txHash.toLowerCase(),
      );
      if (index < 0) return null;
      const decoded = extractSignedCall(block.extrinsics[index], block.facts);
      return {
        extrinsicIndex: index,
        signer: decoded.signer.accountId,
        callHex: decoded.callHex,
        nonce: decoded.nonce,
        events: outcomeForExtrinsic(block.events, index, block.facts).events.map(toChainEvent),
      };
    },
  };
}
