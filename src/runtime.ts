import { Metadata, TypeRegistry, expandMetadata } from '@polkadot/types';
import { hexToU8a } from '@polkadot/util';
import { blake2AsHex } from '@polkadot/util-crypto';
import { loadRuntime, parsePinnedTypes, type Hex, type LoadedRuntime, type RuntimeFacts } from '@seam/compiler';
import { SeamChainError } from './errors.js';
import { quietly } from './quiet.js';

/**
 * Extra type definitions used ONLY to decode what the node sends back (events, dispatch errors, dry-run
 * results) for Portaldot spec 1002 (metadata V13). They are not used to encode calls and are not part
 * of the fingerprint, so the compiler's pinned file (and every fingerprint digest) stays unchanged.
 *
 * polkadot.js 17 defaults to today's DispatchError, whose Module variant is { index: u8, error: [u8; 4] }.
 * A V13-era runtime encodes Module as { index: u8, error: u8 }. Verified against the real node:
 * contracts_call on mainnet returns {"Module":{"index":13,"error":12}}, and decoding the real System.Events
 * of block 2,721,116 with these definitions consumes every byte (tests/events.test.ts).
 * Variants 0-5 have the same order in every Substrate version; Token/Arithmetic (6, 7) follow the
 * Substrate 3.x/4.0-dev order and are an assumption (they would only appear in a failed extrinsic).
 */
export const DECODE_TYPES: Record<string, unknown> = {
  DispatchErrorModule: { index: 'u8', error: 'u8' },
  DispatchError: {
    _enum: {
      Other: 'Null',
      CannotLookup: 'Null',
      BadOrigin: 'Null',
      Module: 'DispatchErrorModule',
      ConsumerRemaining: 'Null',
      NoProviders: 'Null',
      Token: 'TokenError',
      Arithmetic: 'ArithmeticError'
    }
  },
  TokenError: { _enum: ['NoFunds', 'WouldDie', 'BelowMinimum', 'CannotCreate', 'UnknownAsset', 'Frozen', 'Underflow', 'Overflow'] },
  ArithmeticError: { _enum: ['Underflow', 'Overflow', 'DivisionByZero'] }
};

export const SYSTEM_EVENTS_KEY: Hex = '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7';

/** The compiler's pinned runtime (same registry compile() encodes with). Used to build and read extrinsics. */
export function encodeRuntime(facts: RuntimeFacts): LoadedRuntime {
  const rt = loadRuntime(facts.source.metadataHex, facts.source.typesBundle);
  if (rt.metadataHash !== facts.fingerprint.metadataHash || rt.typesBundleHash !== facts.fingerprint.typesBundleHash) {
    throw new SeamChainError('FACTS_MISMATCH', 'facts.source does not hash to the fingerprint (metadata or types file was changed)');
  }
  return rt;
}

export interface DecodeRuntime {
  registry: TypeRegistry;
  metadata: Metadata;
  /** Decorated storage/consts (built lazily, it is the slow part). */
  decorated(): ReturnType<typeof expandMetadata>;
}

const decodeCache = new Map<string, DecodeRuntime>();

/** Pinned types + DECODE_TYPES, on its own registry so encoding is never affected. Cached per fingerprint. */
export function decodeRuntime(facts: RuntimeFacts): DecodeRuntime {
  const key = `${facts.fingerprint.metadataHash}:${facts.fingerprint.typesBundleHash}`;
  const hit = decodeCache.get(key);
  if (hit) return hit;
  encodeRuntime(facts); // integrity check
  const pinned = parsePinnedTypes(facts.source.typesBundle);
  const registry = new TypeRegistry();
  registry.register({ ...(pinned.types as Record<string, string>), ...(DECODE_TYPES as Record<string, string>) });
  const metadata = new Metadata(registry, hexToU8a(facts.source.metadataHex));
  registry.setMetadata(metadata);
  registry.setChainProperties(registry.createType<any>('ChainProperties', {
    ss58Format: facts.fingerprint.ss58Prefix,
    tokenDecimals: [facts.fingerprint.tokenDecimals],
    tokenSymbol: [facts.fingerprint.tokenSymbol]
  }));
  let expanded: ReturnType<typeof expandMetadata> | undefined;
  const rt: DecodeRuntime = {
    registry,
    metadata,
    decorated: () => (expanded ??= quietly(() => expandMetadata(registry, metadata)))
  };
  decodeCache.set(key, rt);
  return rt;
}

/** blake2b-256 of the extrinsic bytes: the tx hash the node reports. */
export function extrinsicHash(extrinsicHex: string): Hex {
  return blake2AsHex(hexToU8a(extrinsicHex), 256) as Hex;
}
