// Pure: no node builtins. The node-only pinned-file reader lives in pinned-file.ts, so `@seam/compiler/facts` stays browser-safe.
import { Metadata, TypeRegistry } from "@polkadot/types";
import { blake2_256, hexBytes, utf8Bytes } from "./canonical.js";
import type { Hex } from "./types.js";

/** Parsed form of a pinned type-definitions file (see types/portaldot-spec1002.json). */
export interface PinnedTypes {
  chain?: string;
  specVersion?: number;
  metadataVersion?: number;
  /** polkadot.js type overrides registered before metadata is loaded. */
  types: Record<string, unknown>;
  /** Type names whose definition was checked against chain evidence (name -> evidence). */
  verified?: Record<string, string>;
  /** Type names that are assumptions (name -> why). */
  assumed?: Record<string, string>;
}

export function parsePinnedTypes(text: string): PinnedTypes {
  const parsed = JSON.parse(text) as PinnedTypes;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.types !== "object" ||
    parsed.types === null
  ) {
    throw new Error('pinned types file must be a JSON object with a "types" object');
  }
  return parsed;
}

export interface LoadedRuntime {
  registry: TypeRegistry;
  metadata: Metadata;
  metadataHash: Hex;
  /** blake2b-256 of the pinned types file, or null for metadata V14+ (self-describing, no pinned types used). */
  typesBundleHash: Hex | null;
  pinned: PinnedTypes;
  /** Metadata version byte (13 for Portaldot spec 1002, 14+ for self-describing runtimes). */
  metadataVersion: number;
}

/**
 * The `source.typesBundle` value recorded for metadata V14+ runtimes: no overrides. Whatever types file a caller
 * passes for a V14+ runtime is ignored, so the Portaldot spec-1002 file can never be applied to another chain.
 */
export const NO_PINNED_TYPES = '{"types":{}}';

/** Metadata version: byte 4 of the raw metadata, after the "meta" magic. */
export function metadataVersionOf(metadataHex: string): number {
  const h = metadataHex.trim();
  if (!/^0x6d657461[0-9a-fA-F]{2}/.test(h))
    throw new Error('metadata must start with the "meta" magic (0x6d657461)');
  return parseInt(h.slice(10, 12), 16);
}

/** True when the runtime needs a pinned types file (metadata V13 and older). */
export function needsPinnedTypes(metadataHex: string): boolean {
  return metadataVersionOf(metadataHex) <= 13;
}

const cache = new Map<string, LoadedRuntime>();

/**
 * Builds a polkadot.js registry from raw metadata plus, for metadata V13 and older only, the pinned types.
 * Metadata V14+ is self-describing: its own type registry is used, any `typesBundle` is ignored and
 * `typesBundleHash` is null. A V13 runtime must be given a pinned types file, and if the file declares a
 * `metadataVersion` it must match. Pure and offline. Cached by (metadataHash, typesBundleHash).
 */
export function loadRuntime(metadataHex: string, typesBundle?: string | null): LoadedRuntime {
  const metadataVersion = metadataVersionOf(metadataHex);
  const legacy = metadataVersion <= 13;
  if (legacy && (typeof typesBundle !== "string" || typesBundle.length === 0)) {
    throw new Error(
      `metadata V${metadataVersion} is not self-describing; a pinned types file is required`,
    );
  }
  const metaBytes = hexBytes(metadataHex.trim());
  const metadataHash = blake2_256(metaBytes);
  const typesBundleHash = legacy ? blake2_256(utf8Bytes(typesBundle!)) : null;
  const key = `${metadataHash}:${typesBundleHash}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const pinned = legacy ? parsePinnedTypes(typesBundle!) : parsePinnedTypes(NO_PINNED_TYPES);
  if (
    legacy &&
    pinned.metadataVersion !== undefined &&
    pinned.metadataVersion !== metadataVersion
  ) {
    throw new Error(
      `the pinned types file is for metadata V${pinned.metadataVersion}, this runtime serves V${metadataVersion}`,
    );
  }
  const registry = new TypeRegistry();
  registry.register(pinned.types as Record<string, string>);
  let metadata!: Metadata;
  withoutLookupWarning(() => {
    metadata = new Metadata(registry, metaBytes);
    registry.setMetadata(metadata);
  });
  const loaded: LoadedRuntime = {
    registry,
    metadata,
    metadataHash,
    typesBundleHash,
    pinned,
    metadataVersion,
  };
  cache.set(key, loaded);
  return loaded;
}

/** polkadot.js warns "Unable to map [u8; 32] to a lookup index" whenever it decorates V13 *storage* keys
 * (setMetadata, expandMetadata). SEAM never reads storage through this registry (calls, constants and events only),
 * so drop exactly that message and nothing else. */
export function withoutLookupWarning<T>(fn: () => T): T {
  const warn = console.warn;
  console.warn = (...a: unknown[]) => {
    if (typeof a[0] === "string" && /^Unable to map .* to a lookup index$/.test(a[0])) return;
    warn(...a);
  };
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}
