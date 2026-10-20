import { Metadata, TypeRegistry } from "@polkadot/types";
import { u8aConcat, u8aToHex } from "@polkadot/util";
import { blake2_256, hexBytes, utf8Bytes } from "./canonical.js";
import { withoutLookupWarning } from "./runtime.js";
import type { Hex } from "./types.js";

/**
 * Storage defaults (pallet, entry) the layout hash ignores. Same list as @seam/chain's BLANKED_STORAGE_DEFAULTS. Only
 * entries observed to drift without a runtime upgrade belong here; any other storage default is part of the layout.
 */
export const BLANKED_STORAGE_DEFAULTS: readonly (readonly [pallet: string, entry: string])[] =
  Object.freeze([Object.freeze(["Revive", "EthBlockBuilderIR"] as const)]);
const isBlanked = (pallet: string, entry: string) =>
  BLANKED_STORAGE_DEFAULTS.some(([p, e]) => p === pallet && e === entry);

/**
 * Metadata layout hash: blake2b-256 over the metadata with only the allow-listed storage defaults
 * (BLANKED_STORAGE_DEFAULTS, today only Revive.EthBlockBuilderIR) blanked. A change to any other default changes it.
 * Same definition and domains as @seam/chain's metadataLayoutHash, so both packages produce identical values.
 *
 * Why: on Portaldot V3 spec 3002 `Revive.EthBlockBuilderIR`'s fallback is state-dependent, so the raw metadata
 * bytes change block to block with no runtime upgrade. (v1 blanked every storage default; its values differ.)
 *
 * Fail closed: the metadata is decoded and rebuilt unchanged first; unless that round-trips byte for byte
 * (V13-V15 only), the hash is taken over the raw bytes under a separate domain, so it only matches an identical blob.
 */
export const METADATA_LAYOUT_DOMAIN = "seam/metadata-layout/v2";
export const METADATA_LAYOUT_RAW_DOMAIN = "seam/metadata-layout/v2/raw";

type AnyCodec = {
  registry: TypeRegistry;
  constructor: new (registry: TypeRegistry, value?: unknown) => AnyCodec;
  toU8a(): Uint8Array;
};
type StructLike = AnyCodec & {
  entries(): IterableIterator<[string, AnyCodec]>;
  get(k: string): AnyCodec | undefined;
};
type VecLike = AnyCodec & { map<T>(fn: (v: AnyCodec) => T): T[] };
type OptionLike = AnyCodec & { isNone: boolean; unwrap(): AnyCodec };

function rebuild(s: StructLike, patch: Record<string, AnyCodec>): AnyCodec {
  const o: Record<string, AnyCodec> = {};
  for (const [k, v] of s.entries()) o[k] = k in patch ? patch[k]! : v;
  return new s.constructor(s.registry, o);
}

function rebuiltBody(inner: StructLike, version: number, blank: boolean): Uint8Array {
  const key = version >= 14 ? "pallets" : "modules";
  const pallets = inner.get(key) as VecLike;
  const reg = inner.registry;
  const out = pallets.map((p) => {
    const ps = p as StructLike;
    const pname = ps.get("name")!.toString();
    const st = ps.get("storage") as OptionLike | undefined;
    if (!st || st.isNone) return rebuild(ps, {});
    const s = st.unwrap() as StructLike;
    const items = s.get("items") as VecLike;
    const newItems = items.map((e) => {
      const es = e as StructLike;
      if (!blank || !isBlanked(pname, es.get("name")!.toString())) return rebuild(es, {});
      const fb = es.get("fallback")!;
      return rebuild(es, { fallback: new fb.constructor(reg, "0x") });
    });
    return rebuild(ps, {
      storage: new st.constructor(reg, rebuild(s, { items: new items.constructor(reg, newItems) })),
    });
  });
  return rebuild(inner, { [key]: new pallets.constructor(reg, out) }).toU8a();
}

/** Metadata bytes with the allow-listed storage defaults blanked, or undefined when they cannot be normalized safely. Pure. */
export function blankStorageFallbacks(metadataHex: string): Uint8Array | undefined {
  try {
    const bytes = hexBytes(metadataHex.trim().toLowerCase());
    return withoutLookupWarning(() => {
      const m = new Metadata(new TypeRegistry(), bytes);
      const version = m.version;
      if (version < 13 || version > 15) return undefined;
      const inner = (m as unknown as Record<string, StructLike>)[`asV${version}`];
      if (!inner) return undefined;
      const head = bytes.subarray(0, 5); // "meta" magic + version byte
      if (u8aToHex(u8aConcat(head, rebuiltBody(inner, version, false))) !== u8aToHex(bytes))
        return undefined;
      return u8aConcat(head, rebuiltBody(inner, version, true));
    });
  } catch {
    return undefined;
  }
}

export interface MetadataLayout {
  hash: Hex;
  /** true: storage defaults were blanked; false: fell back to the raw-bytes domain (matches identical bytes only). */
  normalized: boolean;
}

const cache = new Map<string, MetadataLayout>();

/** Layout hash with whether normalization succeeded. Deterministic; cached per raw metadata hash. */
export function metadataLayout(metadataHex: string): MetadataLayout {
  const bytes = hexBytes(metadataHex.trim().toLowerCase());
  const raw = blake2_256(bytes);
  const hit = cache.get(raw);
  if (hit) return hit;
  const blanked = blankStorageFallbacks(metadataHex);
  const r: MetadataLayout = blanked
    ? { hash: blake2_256(u8aConcat(utf8Bytes(METADATA_LAYOUT_DOMAIN), blanked)), normalized: true }
    : {
        hash: blake2_256(u8aConcat(utf8Bytes(METADATA_LAYOUT_RAW_DOMAIN), bytes)),
        normalized: false,
      };
  if (cache.size > 32) cache.clear();
  cache.set(raw, r);
  return r;
}

export function metadataLayoutHash(metadataHex: string): Hex {
  return metadataLayout(metadataHex).hash;
}
