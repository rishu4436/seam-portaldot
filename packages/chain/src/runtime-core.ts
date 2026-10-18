import { Metadata, TypeRegistry } from '@polkadot/types';
import { hexToU8a, stringToU8a } from '@polkadot/util';
import { blake2AsHex } from '@polkadot/util-crypto';
import type { Hex, LoadedRuntime } from '@seam/compiler';
import { quietly } from './quiet.js';

/**
 * Browser-safe copy of @seam/compiler's loadRuntime (and the two helpers it needs). The compiler package reads its pinned
 * types file with node:fs at module load, so anything that imports its runtime values cannot run in a browser. @seam/chain's
 * signing code needs only the encoder registry, so it builds it here. tests/browser-entry.test.ts checks that this copy
 * gives the same hashes and the same decoding as the compiler's loadRuntime on the fixtures; change both together.
 */
interface PinnedTypes { types: Record<string, unknown>; metadataVersion?: number; [k: string]: unknown }

const NO_PINNED_TYPES = '{"types":{}}';

function parsePinned(text: string): PinnedTypes {
  const parsed = JSON.parse(text) as PinnedTypes;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.types !== 'object' || parsed.types === null) {
    throw new Error('pinned types file must be a JSON object with a "types" object');
  }
  return parsed;
}

export function parsePinnedTypes(text: string): PinnedTypes { return parsePinned(text); }

function metadataVersion(metadataHex: string): number {
  const h = metadataHex.trim();
  if (!/^0x6d657461[0-9a-fA-F]{2}/.test(h)) throw new Error('metadata must start with the "meta" magic (0x6d657461)');
  return parseInt(h.slice(10, 12), 16);
}

const cache = new Map<string, LoadedRuntime>();

export function loadRuntimeCore(metadataHex: string, typesBundle?: string | null): LoadedRuntime {
  const version = metadataVersion(metadataHex);
  const legacy = version <= 13;
  if (legacy && (typeof typesBundle !== 'string' || typesBundle.length === 0)) {
    throw new Error(`metadata V${version} is not self-describing; a pinned types file is required`);
  }
  const metaBytes = hexToU8a(metadataHex.trim());
  const metadataHash = blake2AsHex(metaBytes, 256) as Hex;
  const typesBundleHash = legacy ? (blake2AsHex(stringToU8a(typesBundle!), 256) as Hex) : null;
  const key = `${metadataHash}:${typesBundleHash}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pinned = legacy ? parsePinned(typesBundle!) : parsePinned(NO_PINNED_TYPES);
  if (legacy && pinned.metadataVersion !== undefined && pinned.metadataVersion !== version) {
    throw new Error(`the pinned types file is for metadata V${pinned.metadataVersion}, this runtime serves V${version}`);
  }
  const registry = new TypeRegistry();
  registry.register(pinned.types as Record<string, string>);
  let metadata!: Metadata;
  quietly(() => {
    metadata = new Metadata(registry, metaBytes);
    registry.setMetadata(metadata);
  });
  const loaded = { registry, metadata, metadataHash, typesBundleHash, pinned, metadataVersion: version } as unknown as LoadedRuntime;
  cache.set(key, loaded);
  return loaded;
}
