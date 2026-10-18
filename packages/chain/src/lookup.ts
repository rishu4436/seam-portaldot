import type { Hex } from "@seam/compiler";
import { extrinsicHash } from "./runtime.js";
import { withClient, rpc, toSafeNumber, type ConnectOptions, type Endpoint } from "./rpc.js";

/**
 * Where is this transaction? Used after a send ended uncertain (SEAM-005). Read-only.
 *   found_finalized / found_included : it is in a block on the node's best chain (finalized or not yet).
 *   not_found { definitive: false }  : not seen in the scanned range. This is NOT proof of absence.
 *   not_found { definitive: true }   : it can no longer land: the node was reachable, the whole era window was
 *                                      scanned, and finality has passed validUntilBlock.
 *   unknown                          : the node could not be read, or the transaction is still pending in the pool.
 * It never reports absence when it cannot know.
 */
export type TxLookup =
  | { state: "found_finalized" | "found_included"; block: { number: number; hash: Hex } }
  | { state: "not_found"; definitive: boolean; detail?: string }
  | { state: "unknown"; detail: string };

export interface LookupOptions {
  /** First block the transaction could be in (its checkpoint/birth block). Needed for a definitive answer. */
  fromBlock?: number;
  /** Last block of the era window (checkpoint + period). Needed for a definitive answer; omit for immortal. */
  validUntilBlock?: number;
  /** Most blocks to scan back from the best head. Default 512. */
  maxScan?: number;
}

export async function lookupExtrinsic(
  endpoint: Endpoint,
  txHash: Hex,
  opts: LookupOptions & ConnectOptions = {},
): Promise<TxLookup> {
  const want = txHash.toLowerCase();
  const maxScan = Math.max(1, opts.maxScan ?? 512);
  try {
    return await withClient(
      endpoint,
      async (client) => {
        const numberOf = async (hash: unknown): Promise<number> => {
          const h = await rpc<{ number: unknown } | null>(client, "chain_getHeader", [hash]);
          if (!h) throw new Error(`header ${String(hash)} not found`);
          return toSafeNumber(h.number);
        };
        const best = await numberOf(await rpc<string>(client, "chain_getBlockHash", []));
        const finalized = await numberOf(await rpc<string>(client, "chain_getFinalizedHead", []));
        const floor = Math.max(0, best - maxScan + 1);
        const lower = opts.fromBlock !== undefined ? Math.max(floor, opts.fromBlock) : floor;
        const covered = opts.fromBlock !== undefined && opts.fromBlock >= floor;
        for (let n = best; n >= lower; n--) {
          const hash = await rpc<Hex | null>(client, "chain_getBlockHash", [n]);
          if (!hash)
            return { state: "unknown", detail: `the node has no block hash for #${n}` } as TxLookup;
          const block = await rpc<{ block: { extrinsics: string[] } } | null>(
            client,
            "chain_getBlock",
            [hash],
          );
          if (!block)
            return { state: "unknown", detail: `the node has no body for block #${n}` } as TxLookup;
          if (block.block.extrinsics.some((x) => extrinsicHash(x) === want)) {
            return {
              state: n <= finalized ? "found_finalized" : "found_included",
              block: { number: n, hash },
            } as TxLookup;
          }
        }
        let pending = false;
        try {
          const pool = await rpc<string[]>(client, "author_pendingExtrinsics", []);
          pending = pool.some((x) => extrinsicHash(x) === want);
        } catch {
          /* pool not readable: only matters before the era has passed */
        }
        if (pending)
          return {
            state: "unknown",
            detail: "the transaction is still pending in the pool",
          } as TxLookup;
        const expired = opts.validUntilBlock !== undefined && finalized > opts.validUntilBlock;
        const definitive = covered && expired;
        return {
          state: "not_found",
          definitive,
          detail: definitive
            ? `not in blocks #${lower}..#${best}; finality (#${finalized}) is past the era (#${opts.validUntilBlock}), so it can no longer land`
            : `not in blocks #${lower}..#${best}; this is not proof it was never accepted`,
        } as TxLookup;
      },
      opts,
    );
  } catch (e) {
    return { state: "unknown", detail: `could not read the node: ${(e as Error).message}` };
  }
}
