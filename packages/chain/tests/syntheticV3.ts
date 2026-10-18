/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic metadata fixture manipulates raw JSON */
// SYNTHETIC fixtures. NOT real Portaldot V3 metadata and NOT observed on any chain. They are the committed dev-node
// metadata (spec 100, V14, older Revive layout) with hand-edited Revive/Nfts definitions, built only to exercise the
// preflight's handling of revive.call / nfts.mint. A pass against these proves nothing about any real chain.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Metadata, TypeRegistry } from "@polkadot/types";
import type { Hex } from "@seam/compiler";
import { factsFromChainInputs, type ChainInputs } from "../src/index.js";

const fx = (n: string) => fileURLToPath(new URL(`../../compiler/fixtures/${n}`, import.meta.url));
const devSnap = JSON.parse(readFileSync(fx("devnode-snapshot.json"), "utf8"));
export const devHex = readFileSync(fx("devnode-metadata.hex"), "utf8").trim() as Hex;

export interface SyntheticV3Options {
  /** Revive.call dest as a synthetic H160 (the shape SEAM's compiler accepts). Default: real dev-node MultiAddress. */
  h160?: boolean;
  /** Add a synthetic Nfts pallet with mint(collection u32, item u32, mint_to, witness_data Option<u32>). */
  nfts?: boolean;
  /** Add Revive.map_account (call index 7). */
  mapAccount?: boolean;
  /** Add a Revive.OriginalAccount storage map: H160 -> AccountId32 (synthetic). */
  originalAccount?: boolean;
}

export function syntheticV3Hex(o: SyntheticV3Options = {}): Hex {
  const j: any = new Metadata(new TypeRegistry(), devHex).toJSON();
  const v = j.metadata.v14;
  const types: any[] = v.lookup.types;
  let next = Math.max(...types.map((t) => t.id)) + 1;
  const add = (type: unknown) => {
    types.push({ id: next, type });
    return next++;
  };
  const u8 = types.find((t) => t.type.def.primitive === "U8")!.id as number;
  const u32 = types.find((t) => t.type.def.primitive === "U32")!.id as number;
  const revive = v.pallets.find((p: any) => p.name === "Revive");
  const calls = types.find((t) => t.id === revive.calls.type)!.type.def.variant.variants;
  const fields: any[] = calls[0].fields;
  const mk = (name: string, type: number, typeName: string) => ({ name, type, typeName, docs: [] });
  const arr20 = add({ path: [], params: [], docs: [], def: { array: { len: 20, type: u8 } } });
  if (o.h160) {
    fields.find((f) => f.name === "dest")!.type = add({
      path: ["primitive_types", "H160"],
      params: [],
      def: { composite: { fields: [{ name: null, type: arr20, typeName: "[u8; 20]", docs: [] }] } },
      docs: [],
    });
  }
  if (o.mapAccount) calls.push({ name: "map_account", fields: [], index: 7, docs: [] });
  if (o.originalAccount) {
    const accountId = types.find((t) => t.type.path?.join("::") === "sp_core::crypto::AccountId32")!
      .id as number;
    revive.storage.items.push({
      name: "OriginalAccount",
      modifier: "Optional",
      type: { map: { hashers: ["Identity"], key: arr20, value: accountId } },
      fallback: "0x00",
      docs: [],
    });
  }
  if (o.nfts) {
    const contracts = v.pallets.find((p: any) => p.name === "Contracts");
    const cv = types
      .find((t) => t.id === contracts.calls.type)!
      .type.def.variant.variants.find((x: any) => x.name === "call");
    const addrId = cv.fields[0].type as number;
    const optU32 = add({
      path: ["Option"],
      params: [{ name: "T", type: u32 }],
      def: {
        variant: {
          variants: [
            { name: "None", fields: [], index: 0, docs: [] },
            {
              name: "Some",
              fields: [{ name: null, type: u32, typeName: null, docs: [] }],
              index: 1,
              docs: [],
            },
          ],
        },
      },
      docs: [],
    });
    const nftCalls = add({
      path: ["synthetic_nfts", "pallet", "Call"],
      params: [],
      def: {
        variant: {
          variants: [
            {
              name: "mint",
              index: 15,
              docs: [],
              fields: [
                mk("collection", u32, "T::CollectionId"),
                mk("item", u32, "T::ItemId"),
                mk("mint_to", addrId, "AccountIdLookupOf<T>"),
                mk("witness_data", optU32, "Option<MintWitness>"),
              ],
            },
          ],
        },
      },
      docs: [],
    });
    v.pallets.push({
      name: "Nfts",
      storage: null,
      calls: { type: nftCalls, deprecationInfo: {} },
      events: null,
      constants: [],
      errors: null,
      index: 40,
      docs: [],
    });
  }
  return new Metadata(new TypeRegistry(), j).toHex() as Hex;
}

/** Chain inputs for the dev-node identity with the given metadata. `reviveApi` adds ReviveApi to the runtime version apis. */
export function devInputs(metadataHex: Hex, reviveApi = false): ChainInputs {
  return {
    metadataHex,
    genesisHash: devSnap.genesis,
    runtimeVersion: {
      ...devSnap.runtime,
      apis: reviveApi ? [[REVIVE_API_ID, 1]] : [],
    },
    properties: { tokenSymbol: "UNIT", tokenDecimals: 12, ss58Format: 42 },
    head: { number: devSnap.block, hash: `0x${"aa".repeat(32)}` },
  };
}
// blake2_64("ReviveApi"), computed by runtimeApiId() in src/capabilities.ts; asserted equal in the tests.
export const REVIVE_API_ID = "0x8c403e5c4a9fd442";
export const devFacts = (inputs: ChainInputs) => factsFromChainInputs(inputs);
