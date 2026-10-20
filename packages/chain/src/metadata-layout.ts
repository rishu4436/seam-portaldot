import { Metadata, TypeRegistry } from "@polkadot/types";
import { hexToU8a, stringToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { blake2AsHex } from "@polkadot/util-crypto";
import type { Hex } from "@seam/compiler";
import { quietly } from "./quiet.js";

/**
 * Storage defaults (pallet, entry) that the layout hash ignores. Only entries observed to drift without a runtime
 * upgrade belong here. Any other storage default is part of the layout: a change there changes the hash (fail closed).
 */
export const BLANKED_STORAGE_DEFAULTS: readonly (readonly [pallet: string, entry: string])[] =
  Object.freeze([Object.freeze(["Revive", "EthBlockBuilderIR"] as const)]);
const isBlanked = (pallet: string, entry: string) =>
  BLANKED_STORAGE_DEFAULTS.some(([p, e]) => p === pallet && e === entry);

/**
 * Metadata layout fingerprint: blake2b-256 over the metadata with the allow-listed storage defaults
 * (BLANKED_STORAGE_DEFAULTS, today only Revive.EthBlockBuilderIR) blanked.
 *
 * Why: a storage entry's `fallback` (the SCALE default returned for an absent key) is computed by the runtime when
 * metadata is built. On Portaldot V3 spec 3002 `Revive.EthBlockBuilderIR`'s fallback is state-dependent, so the raw
 * `state_getMetadata` bytes (and their hash) change block to block without a runtime upgrade. That one default is
 * ignored; every other storage default still counts, so an unexplained default change is treated as a layout change.
 *
 * Definition (deterministic):
 *   1. Decode the metadata (magic + version byte + versioned body; V13, V14 and V15 are supported).
 *   2. Rebuild the body from its own decoded codecs with nothing changed and require the bytes to equal the input
 *      exactly. If they don't (unknown version, trailing bytes, a codec that does not round-trip), there is no safe
 *      normalization: the layout hash is taken over the raw bytes under a separate domain, so it only matches an
 *      identical blob (fail closed).
 *   3. Rebuild again with the `fallback` of each allow-listed (pallet, entry) set to empty bytes (0x00, a zero-length
 *      Vec<u8>); every other byte, including every other storage default (pallet names and indices, calls, arguments, the type registry, events, errors, constants, storage
 *      names, prefixes, modifiers, hashers, key and value types, docs, extrinsic and signed extensions) is kept.
 *   4. layoutHash = blake2b-256( utf8("seam/metadata-layout/v2") ++ magic ++ version ++ rebuilt body ).
 * Any change outside the allow-listed defaults changes the hash. (v1 blanked every storage default; its values differ.)
 */
export const METADATA_LAYOUT_DOMAIN = "seam/metadata-layout/v2";
const RAW_DOMAIN = "seam/metadata-layout/v2/raw";

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

/** The versioned body rebuilt from its codecs; `blank` empties every storage fallback. */
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

/** Metadata bytes with the allow-listed storage defaults blanked, or undefined when they cannot be normalized safely. */
export function blankStorageFallbacks(metadataHex: string): Uint8Array | undefined {
  const bytes = hexToU8a(metadataHex.trim().toLowerCase());
  try {
    return quietly(() => {
      const registry = new TypeRegistry();
      const m = new Metadata(registry, bytes);
      const version = m.version;
      if (version < 13 || version > 15) return undefined;
      const inner = (m as unknown as Record<string, StructLike>)[`asV${version}`];
      if (!inner) return undefined;
      const head = bytes.subarray(0, 5); // "meta" magic + version byte
      const same = u8aConcat(head, rebuiltBody(inner, version, false));
      if (u8aToHex(same) !== u8aToHex(bytes)) return undefined;
      return u8aConcat(head, rebuiltBody(inner, version, true));
    });
  } catch {
    return undefined;
  }
}

const cache = new Map<string, Hex>();

/** See METADATA_LAYOUT_DOMAIN. Cached per raw metadata hash. */
export function metadataLayoutHash(metadataHex: string): Hex {
  const bytes = hexToU8a(metadataHex.trim().toLowerCase());
  const raw = blake2AsHex(bytes, 256);
  const hit = cache.get(raw);
  if (hit) return hit;
  const blanked = blankStorageFallbacks(metadataHex);
  const h = (
    blanked
      ? blake2AsHex(u8aConcat(stringToU8a(METADATA_LAYOUT_DOMAIN), blanked), 256)
      : blake2AsHex(u8aConcat(stringToU8a(RAW_DOMAIN), bytes), 256)
  ) as Hex;
  if (cache.size > 32) cache.clear();
  cache.set(raw, h);
  return h;
}

/** True when the two blobs are identical, or differ only in allow-listed storage defaults. */
export function sameMetadataLayout(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  return metadataLayoutHash(a) === metadataLayoutHash(b);
}

/** How a live metadata blob relates to the pinned one. */
export interface MetadataDrift {
  /** blake2b-256 of the live bytes the node returned. */
  liveMetadataHash: Hex;
  /** blake2b-256 of the pinned bytes SEAM keeps using. */
  pinnedMetadataHash: Hex;
  /** The layout hash both share. */
  layoutHash: Hex;
}

/**
 * When the live metadata differs from the pinned one only in allow-listed storage defaults, returns the pinned bytes and a
 * drift record, so the fingerprint (raw hash of the bytes SEAM decodes with) stays the pinned one. Any other
 * difference returns the live bytes unchanged, so the runtime lock sees the change and blocks.
 */
export function pinMetadata(
  liveHex: Hex,
  pinnedHex: Hex | undefined,
): { metadataHex: Hex; drift?: MetadataDrift } {
  if (!pinnedHex) return { metadataHex: liveHex };
  const live = liveHex.toLowerCase() as Hex;
  const pinned = pinnedHex.trim().toLowerCase() as Hex;
  if (live === pinned) return { metadataHex: live };
  const layoutHash = metadataLayoutHash(live);
  if (layoutHash !== metadataLayoutHash(pinned)) return { metadataHex: live };
  return {
    metadataHex: pinned,
    drift: {
      liveMetadataHash: blake2AsHex(hexToU8a(live), 256) as Hex,
      pinnedMetadataHash: blake2AsHex(hexToU8a(pinned), 256) as Hex,
      layoutHash,
    },
  };
}
