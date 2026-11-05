import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { u8aToHex } from "@polkadot/util";
import {
  chainInputsFromSnapshot,
  decodeRuntime,
  factsFromChainInputs,
  storageKey,
  type SnapshotJson,
} from "../src/index.js";
import type { RpcSend } from "../src/rpc-core.js";
import { FakeNode } from "./fakeNode.js";
import { ALICE } from "./helpers.js";
const evidence = (name: string) =>
  fileURLToPath(new URL(`../../../evidence/v3-discovery/${name}`, import.meta.url));
const snapshot = JSON.parse(
  readFileSync(evidence("portaldot-v3-spec3002-snapshot.json"), "utf8"),
) as SnapshotJson;
export const nativeInputs = chainInputsFromSnapshot(
  snapshot,
  readFileSync(evidence("portaldot-v3-spec3002-metadata.hex"), "utf8").trim(),
);
export const nativeFacts = factsFromChainInputs(nativeInputs);
export function nativeSwapNode(
  options: {
    free?: bigint;
    frozen?: bigint;
    assetBalance?: bigint;
    quote?: bigint;
    fee?: bigint;
    badDryRun?: boolean;
    decimals?: number;
  } = {},
) {
  const rt = decodeRuntime(nativeFacts),
    query = rt.decorated().query;
  const node = new FakeNode({
    inputs: nativeInputs,
    facts: nativeFacts,
    nativeBalances: {
      [ALICE]: { free: options.free ?? 10000000000000000n, frozen: options.frozen ?? 0n },
    },
    assetBalances: [
      {
        assetId: "8801000",
        minBalance: 1n,
        accounts: { [ALICE]: options.assetBalance ?? 200000000000n },
      },
    ],
    ...(options.badDryRun ? { dryRunAnswer: () => "0x010004" } : {}),
  });
  const log: { method: string; params: unknown[] }[] = [];
  const metaEntry = query.assets.metadata;
  const metadata = u8aToHex(
    rt.registry
      .createType(rt.registry.createLookupType(metaEntry.meta.type.asMap.value), {
        deposit: 0,
        name: "Test Ducat",
        symbol: "DUCAT",
        decimals: options.decimals ?? 10,
        isFrozen: false,
      })
      .toU8a(),
  );
  const send: RpcSend = async (method, params) => {
    log.push({ method, params });
    if (method === "state_getKeysPaged")
      return [storageKey(query.assetConversion.pools, [{ Native: null }, { WithId: 8801000 }])];
    if (method === "state_getStorage" && params[0] === storageKey(metaEntry, 8801000))
      return metadata;
    if (method === "state_call") {
      if (params[0] === "AssetConversionApi_get_reserves")
        return u8aToHex(
          rt.registry
            .createType("Option<(u128,u128)>", ["2000000000000000", "200000000000000"])
            .toU8a(),
        );
      if (params[0] === "AssetConversionApi_quote_price_exact_tokens_for_tokens")
        return u8aToHex(
          rt.registry
            .createType("Option<u128>", (options.quote ?? 99650324313n).toString())
            .toU8a(),
        );
    }
    if (method === "payment_queryInfo")
      return { partialFee: (options.fee ?? 1810737180385n).toString() };
    return node.send(method, params);
  };
  return { node, send, log, rt };
}
