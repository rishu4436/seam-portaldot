import { expandMetadata } from '@polkadot/types';
import { DOMAIN, digestJson } from './canonical.js';
import { loadRuntime, withoutLookupWarning, type LoadedRuntime } from './runtime.js';
import type {
  BatchAllRollback,
  Capability,
  CapabilityArg,
  Hex,
  RuntimeFacts,
  RuntimeFingerprint
} from './types.js';

/** Capabilities SEAM can compile to, plus the batching call. Always present in facts. */
export const SEAM_CAPABILITIES = [
  'Assets.transfer_keep_alive',
  'Assets.mint',
  'Contracts.call',
  'Revive.call',
  'Nfts.mint',
  'Utility.batch_all'
] as const;

const PRIMITIVES = new Set([
  'u8', 'u16', 'u32', 'u64', 'u128', 'u256', 'i8', 'i16', 'i32', 'i64', 'i128', 'i256',
  'bool', 'Bytes', 'Text', 'H160', 'H256', 'Call'
]);
const WRAPPERS = new Set(['Compact', 'Vec', 'Box', 'Option']);

export interface FactsFromMetadataInput {
  /** 0x-prefixed raw metadata bytes, exactly as returned by state_getMetadata. */
  metadataHex: string;
  /** Exact text of the pinned type-definitions file (see readPinnedTypes()). */
  typesBundle: string;
  genesisHash: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Optional; when given they must match the values inside the metadata (System.Version / System.SS58Prefix). */
  specName?: string;
  specVersion?: number;
  transactionVersion?: number;
  ss58Prefix?: number;
  /** Behaviour that metadata cannot show. Defaults to 'unknown' (or 'not_supported' when Utility.batch_all is absent). */
  batchAllRollback?: BatchAllRollback;
  endpoint?: string;
  blockNumber?: number;
}

export function computeFingerprintDigest(fp: RuntimeFingerprint): Hex {
  // Exactly these nine fields, nothing else, so extra properties cannot change the digest.
  const canonical: RuntimeFingerprint = {
    genesisHash: fp.genesisHash,
    specName: fp.specName,
    specVersion: fp.specVersion,
    transactionVersion: fp.transactionVersion,
    metadataHash: fp.metadataHash,
    ss58Prefix: fp.ss58Prefix,
    tokenSymbol: fp.tokenSymbol,
    tokenDecimals: fp.tokenDecimals,
    typesBundleHash: fp.typesBundleHash
  };
  return digestJson(DOMAIN.fingerprint, canonical);
}

function argConfidence(types: string[], trusted: Set<string>): 'full' | 'partial' {
  for (const t of types) {
    const names = t.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    for (const n of names) {
      if (WRAPPERS.has(n) || PRIMITIVES.has(n) || trusted.has(n)) continue;
      return 'partial';
    }
  }
  return 'full';
}

/** Lists every call in the metadata as an observed capability. */
export function readCapabilities(rt: LoadedRuntime): Record<string, Capability> {
  const { registry, metadata, pinned } = rt;
  const trusted = new Set(Object.keys(pinned.verified ?? {}));
  const caps: Record<string, Capability> = {};
  for (const pallet of metadata.asLatest.pallets) {
    if (pallet.calls.isNone) continue;
    const palletIndex = pallet.index.toNumber();
    const variants = registry.lookup.getSiType(pallet.calls.unwrap().type).def.asVariant.variants;
    for (const v of variants) {
      const callIndex = v.index.toNumber();
      const { meta } = registry.findMetaCall(new Uint8Array([palletIndex, callIndex]));
      // Names as written in the runtime (snake_case); types as sanitised by polkadot.js.
      const args: CapabilityArg[] = meta.args.map((a, i) => {
        const field = v.fields[i];
        const name = field && field.name.isSome ? field.name.unwrap().toString() : a.name.toString();
        return { name, type: a.type.toString() };
      });
      caps[`${pallet.name.toString()}.${meta.name.toString()}`] = {
        status: 'observed',
        palletIndex,
        callIndex,
        args,
        argTypesConfidence: argConfidence(args.map((a) => a.type), trusted)
      };
    }
  }
  for (const name of SEAM_CAPABILITIES) {
    if (!caps[name]) caps[name] = { status: 'not_observed' };
  }
  // Stable key order so the facts object serialises identically every time.
  return Object.fromEntries(Object.keys(caps).sort().map((k) => [k, caps[k]!]));
}

/**
 * Builds RuntimeFacts from raw metadata (offline). Spec name/version, transaction
 * version and SS58 prefix are read from the metadata's System constants; any
 * caller-supplied value that disagrees is an error.
 */
export function factsFromMetadata(input: FactsFromMetadataInput): RuntimeFacts {
  const rt = loadRuntime(input.metadataHex, input.typesBundle);
  const consts = withoutLookupWarning(() => expandMetadata(rt.registry, rt.metadata)).consts as any;
  const version = consts.system?.version;
  if (!version) throw new Error('metadata has no System.Version constant');
  const specName = version.specName.toString() as string;
  const specVersion = version.specVersion.toNumber() as number;
  const transactionVersion = version.transactionVersion.toNumber() as number;
  const ss58Prefix = consts.system?.ss58Prefix ? (consts.system.ss58Prefix.toNumber() as number) : input.ss58Prefix;
  if (ss58Prefix === undefined) throw new Error('ss58Prefix not in metadata; pass it explicitly');

  const check = (field: string, given: unknown, actual: unknown) => {
    if (given !== undefined && given !== actual) {
      throw new Error(`${field} mismatch: input says ${String(given)}, metadata says ${String(actual)}`);
    }
  };
  check('specName', input.specName, specName);
  check('specVersion', input.specVersion, specVersion);
  check('transactionVersion', input.transactionVersion, transactionVersion);
  check('ss58Prefix', input.ss58Prefix, ss58Prefix);
  if (!/^0x[0-9a-f]{64}$/.test(input.genesisHash)) throw new Error('genesisHash must be 0x + 64 lowercase hex chars');
  if (!Number.isSafeInteger(input.tokenDecimals) || input.tokenDecimals < 0) throw new Error('tokenDecimals must be a non-negative integer');

  const fingerprint: RuntimeFingerprint = {
    genesisHash: input.genesisHash as Hex,
    specName,
    specVersion,
    transactionVersion,
    metadataHash: rt.metadataHash,
    ss58Prefix,
    tokenSymbol: input.tokenSymbol,
    tokenDecimals: input.tokenDecimals,
    typesBundleHash: rt.typesBundleHash
  };
  const capabilities = readCapabilities(rt);
  const batchAllObserved = capabilities['Utility.batch_all']?.status === 'observed';
  const batchAllRollback: BatchAllRollback = batchAllObserved ? input.batchAllRollback ?? 'unknown' : 'not_supported';

  const facts: RuntimeFacts = {
    fingerprint,
    fingerprintDigest: computeFingerprintDigest(fingerprint),
    capabilities,
    behaviour: { batchAllRollback },
    source: { metadataHex: input.metadataHex.trim() as Hex, typesBundle: input.typesBundle }
  };
  if (input.endpoint !== undefined) facts.endpoint = input.endpoint;
  if (input.blockNumber !== undefined) facts.blockNumber = input.blockNumber;
  return facts;
}
