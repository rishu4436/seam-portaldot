/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic metadata fixture manipulates raw JSON */
// SYNTHETIC metadata fixtures. NOT real Portaldot V3 metadata. They are the committed dev-node metadata (V14) with
// hand-edited pallet/call definitions, built only to exercise the compiler's shape verification. A pass against these
// proves nothing about any real chain.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Metadata, TypeRegistry } from "@polkadot/types";
import { factsFromMetadata, type RuntimeFacts } from "../src/index.js";

const fx = (n: string) => fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url));
export const devSnap = JSON.parse(readFileSync(fx("devnode-snapshot.json"), "utf8"));
export const devHex = readFileSync(fx("devnode-metadata.hex"), "utf8").trim();

export interface SyntheticOptions {
  /** Revive.call dest type: real dev-node MultiAddress (default), or a synthetic H160. */
  reviveDest?: "multiaddress" | "h160";
  /** Drop one Revive.call argument by name. */
  reviveDrop?: string;
  /** Swap the two last Revive.call arguments. */
  reviveSwap?: boolean;
  /** Add an extra u32 argument to Revive.call. */
  reviveExtra?: boolean;
  /** Add a synthetic Nfts pallet with mint(collection u32, item u32, mint_to, witness_data Option<u32>). */
  nfts?: boolean;
  nftsWitness?: "option" | "u32";
  nftsMintTo?: "multiaddress" | "u128";
}

export function syntheticHex(o: SyntheticOptions = {}): string {
  const reg = new TypeRegistry();
  const j: any = new Metadata(reg, devHex).toJSON();
  const v = j.metadata.v14;
  const types: any[] = v.lookup.types;
  let next = Math.max(...types.map((t) => t.id)) + 1;
  const add = (type: unknown) => {
    types.push({ id: next, type });
    return next++;
  };
  const u8 = types.find((t) => t.type.def.primitive === "U8")!.id as number;
  const u32 = types.find((t) => t.type.def.primitive === "U32")!.id as number;
  const u128 = types.find((t) => t.type.def.primitive === "U128")!.id as number;
  const multi = v.pallets.find((p: any) => p.name === "Revive");
  const callTypeId = multi.calls.type as number;
  const call = types.find((t) => t.id === callTypeId)!.type.def.variant.variants[0];
  const fields: any[] = call.fields;
  const field = (name: string) => fields.find((f) => f.name === name)!;
  const docsless = { path: [], params: [], docs: [] };

  if (o.reviveDest === "h160") {
    const arr = add({ ...docsless, def: { array: { len: 20, type: u8 } } });
    field("dest").type = add({
      path: ["primitive_types", "H160"],
      params: [],
      def: { composite: { fields: [{ name: null, type: arr, typeName: "[u8; 20]", docs: [] }] } },
      docs: [],
    });
  }
  if (o.reviveDrop)
    fields.splice(
      fields.findIndex((f) => f.name === o.reviveDrop),
      1,
    );
  if (o.reviveSwap) fields.push(fields.splice(fields.length - 2, 1)[0]);
  if (o.reviveExtra) fields.push({ name: "extra", type: u32, typeName: "u32", docs: [] });

  if (o.nfts) {
    const multiAddr = field("dest").type; // original MultiAddress id may have been replaced; recover from Contracts.call
    const contracts = v.pallets.find((p: any) => p.name === "Contracts");
    const cv = types
      .find((t) => t.id === contracts.calls.type)!
      .type.def.variant.variants.find((x: any) => x.name === "call");
    const addrId = cv.fields[0].type as number;
    void multiAddr;
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
    const mk = (name: string, type: number, typeName: string) => ({
      name,
      type,
      typeName,
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
                mk("mint_to", o.nftsMintTo === "u128" ? u128 : addrId, "AccountIdLookupOf<T>"),
                mk("witness_data", o.nftsWitness === "u32" ? u32 : optU32, "Option<MintWitness>"),
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
  return new Metadata(new TypeRegistry(), j).toHex();
}

export function syntheticFacts(o: SyntheticOptions = {}): RuntimeFacts {
  return factsFromMetadata({
    metadataHex: syntheticHex(o),
    genesisHash: devSnap.genesis,
    tokenSymbol: "UNIT",
    tokenDecimals: 12,
  });
}
