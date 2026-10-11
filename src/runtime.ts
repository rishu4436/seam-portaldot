import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { blake2_256, hexBytes, utf8Bytes } from './canonical.js';
import type { Hex } from './types.js';

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

export const PORTALDOT_SPEC1002_TYPES_PATH = fileURLToPath(new URL('../types/portaldot-spec1002.json', import.meta.url));

/** Reads a pinned types file as exact text (its bytes are hashed into the fingerprint). */
export function readPinnedTypes(path: string = PORTALDOT_SPEC1002_TYPES_PATH): string {
  return readFileSync(path, 'utf8');
}

export function parsePinnedTypes(text: string): PinnedTypes {
  const parsed = JSON.parse(text) as PinnedTypes;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.types !== 'object' || parsed.types === null) {
    throw new Error('pinned types file must be a JSON object with a "types" object');
  }
  return parsed;
}

export interface LoadedRuntime {
  registry: TypeRegistry;
  metadata: Metadata;
  metadataHash: Hex;
  typesBundleHash: Hex;
  pinned: PinnedTypes;
}

const cache = new Map<string, LoadedRuntime>();

/**
 * Builds a polkadot.js registry from raw metadata plus the pinned types.
 * Pure and offline. Cached by (metadataHash, typesBundleHash).
 */
export function loadRuntime(metadataHex: string, typesBundle: string): LoadedRuntime {
  const metaBytes = hexBytes(metadataHex.trim());
  const metadataHash = blake2_256(metaBytes);
  const typesBundleHash = blake2_256(utf8Bytes(typesBundle));
  const key = `${metadataHash}:${typesBundleHash}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const pinned = parsePinnedTypes(typesBundle);
  const registry = new TypeRegistry();
  registry.register(pinned.types as Record<string, string>);
  // polkadot.js warns "Unable to map [u8; 32] to a lookup index" while decorating V13 *storage* keys. SEAM never
  // reads storage through this registry (calls and events only), so drop exactly that message and nothing else.
  const warn = console.warn;
  console.warn = (...a: unknown[]) => {
    if (typeof a[0] === 'string' && /^Unable to map .* to a lookup index$/.test(a[0])) return;
    warn(...a);
  };
  let metadata: Metadata;
  try {
    metadata = new Metadata(registry, metaBytes);
    registry.setMetadata(metadata);
  } finally {
    console.warn = warn;
  }
  const loaded: LoadedRuntime = { registry, metadata, metadataHash, typesBundleHash, pinned };
  cache.set(key, loaded);
  return loaded;
}
