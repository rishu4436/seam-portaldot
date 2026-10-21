import type { Hex, RuntimeFacts } from "@seam/compiler/facts";
import { clientFromSend, rpc, toSafeNumber, type RpcClient, type RpcSend } from "./rpc-core.js";
import { extrinsicHash, SYSTEM_EVENTS_KEY } from "./runtime.js";
import { outcomeForExtrinsic, toChainEvent, type ChainEvent } from "./events.js";
import { factsFromChainInputs } from "./facts-core.js";

/**
 * Reconcile by hash after an uncertain submit (P0-06). Read-only, fail closed:
 *   found     : the extrinsic is in block `blockNumber` at `extrinsicIndex`; `success` from System.ExtrinsicSuccess /
 *               ExtrinsicFailed (with the decoded dispatch error) and its events, decoded with that block's own metadata.
 *   not_found : not in blocks #scannedFrom..#scannedTo (every block in that range was read). Not proof it can never land.
 *   unknown   : anything could not be read or decoded (or neither success nor failure event), with the reason.
 */
export type TxLookupByHash =
  | {
      status: "found";
      blockNumber: number;
      blockHash: Hex;
      extrinsicIndex: number;
      success: boolean;
      dispatchError?: string;
      events: ChainEvent[];
    }
  | { status: "not_found"; scannedFrom: number; scannedTo: number }
  | { status: "unknown"; reason: string };

export interface LookupTxByHashOptions {
  txHash: Hex;
  /** First block to scan (e.g. the signing checkpoint / birth block). */
  fromBlock: number;
  /** Last block to scan. Default: the node's best block. */
  toBlock?: number;
  /** Most blocks to scan from fromBlock. Default 256. */
  maxBlocks?: number;
  /** Facts to decode events with. Default: built from the found block's own metadata, runtime version and genesis. */
  facts?: RuntimeFacts;
}

export async function lookupTxByHash(
  rpcIn: RpcSend | RpcClient,
  o: LookupTxByHashOptions,
): Promise<TxLookupByHash> {
  const client = typeof rpcIn === "function" ? clientFromSend(rpcIn) : rpcIn;
  const want = String(o.txHash).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(want))
    return { status: "unknown", reason: "txHash is not a 32-byte 0x hash" };
  if (!Number.isSafeInteger(o.fromBlock) || o.fromBlock < 0)
    return { status: "unknown", reason: "fromBlock must be a non-negative integer" };
  const maxBlocks = Math.max(1, Math.floor(o.maxBlocks ?? 256));
  try {
    let to = o.toBlock;
    if (to === undefined) {
      const head = await rpc<{ number: unknown } | null>(client, "chain_getHeader", []);
      if (!head) return { status: "unknown", reason: "the node returned no best header" };
      to = toSafeNumber(head.number);
    }
    if (to < o.fromBlock)
      return { status: "unknown", reason: `toBlock #${to} is before fromBlock #${o.fromBlock}` };
    const last = Math.min(to, o.fromBlock + maxBlocks - 1);
    for (let n = o.fromBlock; n <= last; n++) {
      const hash = await rpc<Hex | null>(client, "chain_getBlockHash", [n]);
      if (!hash) return { status: "unknown", reason: `the node has no block hash for #${n}` };
      const block = await rpc<{ block?: { extrinsics?: unknown } } | null>(
        client,
        "chain_getBlock",
        [hash],
      );
      const xs = block?.block?.extrinsics;
      if (!Array.isArray(xs))
        return { status: "unknown", reason: `the node has no body for block #${n}` };
      const idx = xs.findIndex((x) => typeof x === "string" && extrinsicHash(x) === want);
      if (idx < 0) continue;
      const eventsHex = await rpc<Hex | null>(client, "state_getStorage", [
        SYSTEM_EVENTS_KEY,
        hash,
      ]);
      if (!eventsHex)
        return {
          status: "unknown",
          reason: `found in #${n} at index ${idx}, but System.Events is not readable`,
        };
      let facts = o.facts;
      try {
        if (!facts) {
          const parent = (await rpc<{ parentHash: Hex }>(client, "chain_getHeader", [hash]))
            .parentHash;
          // The block's own runtime: metadata at the block's parent is what applied it (identical unless it upgraded).
          facts = factsFromChainInputs({
            metadataHex: await rpc<Hex>(client, "state_getMetadata", [parent]),
            genesisHash: await rpc<Hex>(client, "chain_getBlockHash", [0]),
            runtimeVersion: await rpc(client, "state_getRuntimeVersion", [parent]),
            properties: await rpc(client, "system_properties", []),
            head: { number: n - 1, hash: parent },
          } as never);
        }
        const out = outcomeForExtrinsic(eventsHex, idx, facts);
        if (out.success === undefined)
          return {
            status: "unknown",
            reason: `found in #${n} at index ${idx}, but it has neither ExtrinsicSuccess nor ExtrinsicFailed`,
          };
        return {
          status: "found",
          blockNumber: n,
          blockHash: hash,
          extrinsicIndex: idx,
          success: out.success,
          ...(out.dispatchError ? { dispatchError: out.dispatchError } : {}),
          events: out.events.map(toChainEvent),
        };
      } catch (e) {
        return {
          status: "unknown",
          reason: `found in #${n} at index ${idx}, but its events could not be decoded: ${(e as Error).message.slice(0, 200)}`,
        };
      }
    }
    return { status: "not_found", scannedFrom: o.fromBlock, scannedTo: last };
  } catch (e) {
    return {
      status: "unknown",
      reason: `could not read the node: ${(e as Error).message.slice(0, 200)}`,
    };
  }
}
