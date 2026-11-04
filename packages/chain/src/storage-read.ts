import { hexToU8a } from "@polkadot/util";
import type { Hex, RuntimeFacts } from "@seam/compiler/facts";
import { rpc, type RpcClient } from "./rpc-core.js";
import { decodeRuntime, storageKey } from "./runtime.js";

export type StorageEntryLoose = Parameters<typeof storageKey>[0] & {
  meta: { type: { isMap: boolean; asMap: { value: unknown }; asPlain: unknown } };
};

/** Strict SCALE decoding: a missing entry is null; unreadable state throws. */
export async function readStorageValue(
  client: RpcClient,
  facts: RuntimeFacts,
  entry: StorageEntryLoose,
  args: unknown[],
  at: Hex,
): Promise<Record<string, { toBigInt(): bigint }> | null> {
  const raw = await rpc<string | null>(client, "state_getStorage", [
    storageKey(entry, ...args),
    at,
  ]);
  if (raw === null || raw === undefined || raw === "0x") return null;
  const { registry } = decodeRuntime(facts);
  const t = entry.meta.type.isMap ? entry.meta.type.asMap.value : entry.meta.type.asPlain;
  const r = registry as unknown as {
    createLookupType(t: unknown): string;
    createTypeUnsafe(t: string, p: unknown[], o: { isPedantic: boolean }): unknown;
  };
  const v = r.createTypeUnsafe(r.createLookupType(t), [hexToU8a(raw)], { isPedantic: true }) as {
    isSome?: boolean;
    unwrap?: () => unknown;
  };
  return (v.isSome === undefined ? v : v.isSome ? v.unwrap!() : null) as Record<
    string,
    { toBigInt(): bigint }
  > | null;
}
