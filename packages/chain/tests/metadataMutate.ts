/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers poke raw polkadot codecs */
/** Test helpers: real metadata blobs with one targeted change, re-encoded byte-exactly from polkadot codecs. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Metadata, TypeRegistry } from "@polkadot/types";
import { hexToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import type { Hex } from "@seam/compiler";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .trim()
    .toLowerCase() as Hex;
/** substrate-contracts-node spec 100, metadata V14. */
export const devnodeV14 = () => read("../../compiler/fixtures/devnode-metadata.hex");
/** Portaldot V3 testnet spec 3002 (state_getMetadata, read-only discovery 2026-10-18), metadata V14. */
export const v3Spec3002 = () =>
  read("../../../evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex");
/** Portaldot mainnet spec 1002, metadata V13. */
export const mainnetV13 = () => read("../fixtures/portaldot-mainnet-metadata.hex");

const rebuild = (s: any, patch: Record<string, unknown>) => {
  const o: Record<string, unknown> = {};
  for (const [k, v] of s.entries()) o[k] = k in patch ? patch[k] : v;
  return new s.constructor(s.registry, o);
};

/** Rebuilds one storage entry (pallet/module name + entry name) with `patch(entry, registry)` fields. */
export function patchStorageEntry(
  hex: Hex,
  pallet: string,
  entry: string,
  patch: (e: any, reg: TypeRegistry) => Record<string, unknown>,
): Hex {
  const reg = new TypeRegistry();
  const bytes = hexToU8a(hex);
  const m = new Metadata(reg, bytes);
  const inner = (m as any)[`asV${m.version}`];
  const key = m.version >= 14 ? "pallets" : "modules";
  let hit = false;
  const pallets = inner.get(key).map((p: any) => {
    if (p.get("name").toString() !== pallet) return p;
    const st = p.get("storage");
    const s = st.unwrap();
    const items = s.get("items").map((e: any) => {
      if (e.get("name").toString() !== entry) return e;
      hit = true;
      return rebuild(e, patch(e, reg));
    });
    return rebuild(p, {
      storage: new st.constructor(
        reg,
        rebuild(s, { items: new (s.get("items").constructor)(reg, items) }),
      ),
    });
  });
  if (!hit) throw new Error(`no storage ${pallet}.${entry}`);
  const body = rebuild(inner, { [key]: new (inner.get(key).constructor)(reg, pallets) }).toU8a();
  return u8aToHex(u8aConcat(bytes.subarray(0, 5), body)) as Hex;
}

/** Same metadata with a different default value for one storage entry (what V3 does block to block). */
export const withFallback = (hex: Hex, pallet: string, entry: string, fallbackHex: Hex) =>
  patchStorageEntry(hex, pallet, entry, (e, reg) => ({
    fallback: new (e.get("fallback").constructor)(reg, fallbackHex),
  }));

/** V14 only: edit the decoded JSON and re-encode (used for type registry / call / event edits). */
export function mutateV14(hex: Hex, edit: (json: any) => void): Hex {
  const reg = new TypeRegistry();
  const bytes = hexToU8a(hex);
  const m = new Metadata(reg, bytes);
  if (m.version !== 14) throw new Error("mutateV14 needs metadata V14");
  const json = m.asV14.toJSON() as any;
  edit(json);
  return u8aToHex(
    u8aConcat(bytes.subarray(0, 5), reg.createType("MetadataV14", json).toU8a()),
  ) as Hex;
}

/** The lookup type id of a pallet's Call enum (V14). */
export function callTypeId(json: any, pallet: string): number {
  return json.pallets.find((p: any) => p.name === pallet).calls.type;
}
export function lookupDef(json: any, id: number): any {
  return json.lookup.types.find((t: any) => t.id === id).type.def;
}
