import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexToU8a } from '@polkadot/util';
import { blake2AsHex } from '@polkadot/util-crypto';
import {
  computeFingerprintDigest,
  factsFromMetadata,
  loadRuntime,
  readPinnedTypes,
  type AtomicRollbackProof,
  type BatchAllRollback,
  type Hex,
  type RuntimeFacts,
  type RuntimeFingerprint
} from '@seam/compiler';
import { SeamChainError } from './errors.js';
import { quietly } from './quiet.js';
import { endpointLabel, rpc, toSafeNumber, withClient, type ConnectOptions, type Endpoint, type RpcClient } from './rpc.js';
import type { BlockRef, ChainInputs, ChainPropertiesJson, FreshFingerprint, RuntimeVersionJson, SnapshotJson } from './types.js';

export interface DiscoverOptions extends ConnectOptions {
  /** Exact text of the pinned types file. Default: the compiler's Portaldot spec 1002 file. */
  typesBundle?: string;
  /** Behaviour metadata cannot show. Default 'unknown' (see @seam/compiler). */
  batchAllRollback?: BatchAllRollback;
  /** Evidence for batchAllRollback 'verified' (a rollback test run on this runtime). Without a matching proof the compiler will not plan atomic_verified. */
  batchAllRollbackProof?: AtomicRollbackProof;
  /**
   * Token symbol/decimals declared by the caller for a chain whose system_properties omit them
   * (e.g. substrate-contracts-node --dev returns {}). Used only when the node reports nothing;
   * if the node does report a value and it differs, discovery fails. Never filled in by SEAM itself.
   */
  declaredToken?: { tokenSymbol: string; tokenDecimals: number };
}

/** Options that shape the facts (everything except connection settings). */
export type FactsOptions = Omit<DiscoverOptions, keyof ConnectOptions>;

const HASH_RE = /^0x[0-9a-f]{64}$/;

function asHash(v: unknown, what: string): Hex {
  if (typeof v !== 'string' || !HASH_RE.test(v.toLowerCase())) {
    throw new SeamChainError('NODE_MISSING_VALUE', `node returned no valid ${what} (got ${JSON.stringify(v)})`);
  }
  return v.toLowerCase() as Hex;
}

/** Best block hash and number. */
export async function readHead(client: RpcClient): Promise<BlockRef> {
  const hash = asHash(await rpc(client, 'chain_getBlockHash', []), 'best block hash');
  const header = await rpc<{ number: unknown } | null>(client, 'chain_getHeader', [hash]);
  if (!header) throw new SeamChainError('NODE_MISSING_VALUE', `no header for best block ${hash}`);
  return { number: toSafeNumber(header.number), hash };
}

/** Finalized head: the block to use as the era checkpoint in a signing envelope. */
export async function readCheckpoint(endpoint: Endpoint, opts: ConnectOptions = {}): Promise<BlockRef> {
  return withClient(endpoint, async (client) => {
    const hash = asHash(await rpc(client, 'chain_getFinalizedHead', []), 'finalized head');
    const header = await rpc<{ number: unknown } | null>(client, 'chain_getHeader', [hash]);
    if (!header) throw new SeamChainError('NODE_MISSING_VALUE', `no header for finalized block ${hash}`);
    return { number: toSafeNumber(header.number), hash };
  }, opts);
}

/**
 * Era checkpoint for a signing envelope: the finalized head, or its parent when the finalized head is also the
 * best block. Why: system_dryRun applies the extrinsic on top of the best block's state without initializing a
 * new block, and System.BlockHash has no entry for the current block yet, so a transaction born at the best block
 * dry-runs as Invalid(AncientBirthBlock) although the pool would accept it. That happens whenever finality keeps
 * up with the head (instant-seal dev nodes). The parent is finalized too, so nothing is lost.
 */
export async function readSigningCheckpoint(endpoint: Endpoint, opts: ConnectOptions = {}): Promise<BlockRef> {
  return withClient(endpoint, async (client) => {
    const hash = asHash(await rpc(client, 'chain_getFinalizedHead', []), 'finalized head');
    const header = await rpc<{ number: unknown; parentHash: unknown } | null>(client, 'chain_getHeader', [hash]);
    if (!header) throw new SeamChainError('NODE_MISSING_VALUE', `no header for finalized block ${hash}`);
    const finalized = { number: toSafeNumber(header.number), hash };
    const best = await readHead(client);
    const parent = typeof header.parentHash === 'string' ? header.parentHash.toLowerCase() : '';
    if (best.hash !== finalized.hash || finalized.number === 0 || !HASH_RE.test(parent) || /^0x0+$/.test(parent)) return finalized;
    return { number: finalized.number - 1, hash: parent as Hex };
  }, opts);
}

/** Reads the raw inputs discovery needs, all pinned to the current best block. */
export async function readChainInputs(endpoint: Endpoint, opts: ConnectOptions = {}): Promise<ChainInputs> {
  return withClient(endpoint, async (client) => {
    const head = await readHead(client);
    const [metadataHex, runtimeVersion, properties, genesis] = await Promise.all([
      rpc<string>(client, 'state_getMetadata', [head.hash]),
      rpc<RuntimeVersionJson>(client, 'state_getRuntimeVersion', [head.hash]),
      rpc<ChainPropertiesJson>(client, 'system_properties', []),
      rpc<string>(client, 'chain_getBlockHash', [0])
    ]);
    if (typeof metadataHex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(metadataHex)) {
      throw new SeamChainError('NODE_MISSING_VALUE', 'state_getMetadata returned no metadata bytes');
    }
    if (!runtimeVersion || typeof runtimeVersion.specVersion !== 'number' || typeof runtimeVersion.transactionVersion !== 'number') {
      throw new SeamChainError('NODE_MISSING_VALUE', 'state_getRuntimeVersion returned no spec/transaction version');
    }
    const inputs: ChainInputs = {
      metadataHex: metadataHex.toLowerCase() as Hex,
      genesisHash: asHash(genesis, 'genesis hash'),
      runtimeVersion,
      properties: properties ?? {},
      head
    };
    const label = endpointLabel(endpoint);
    if (label) inputs.endpoint = label;
    return inputs;
  }, opts);
}

function first<T>(v: T | T[] | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Token symbol and decimals from system_properties. Missing values are an error, never guessed,
 * unless the caller explicitly declares them (declared values must agree with anything the node reports).
 */
export function tokenInfo(
  properties: ChainPropertiesJson,
  declared?: { tokenSymbol: string; tokenDecimals: number }
): { tokenSymbol: string; tokenDecimals: number } {
  const reportedSymbol = first(properties.tokenSymbol);
  const reportedDecimals = first(properties.tokenDecimals);
  if (declared) {
    if (reportedSymbol !== undefined && reportedSymbol !== declared.tokenSymbol) {
      throw new SeamChainError('FACTS_MISMATCH', `declared tokenSymbol ${declared.tokenSymbol} but the node reports ${String(reportedSymbol)}`);
    }
    if (reportedDecimals !== undefined && reportedDecimals !== declared.tokenDecimals) {
      throw new SeamChainError('FACTS_MISMATCH', `declared tokenDecimals ${declared.tokenDecimals} but the node reports ${String(reportedDecimals)}`);
    }
  }
  const tokenSymbol = reportedSymbol ?? declared?.tokenSymbol;
  const tokenDecimals = reportedDecimals ?? declared?.tokenDecimals;
  if (typeof tokenSymbol !== 'string' || tokenSymbol.length === 0) {
    throw new SeamChainError('NODE_MISSING_VALUE', 'system_properties has no tokenSymbol; SEAM will not guess it');
  }
  if (typeof tokenDecimals !== 'number' || !Number.isSafeInteger(tokenDecimals)) {
    throw new SeamChainError('NODE_MISSING_VALUE', 'system_properties has no tokenDecimals; SEAM will not guess it');
  }
  return { tokenSymbol, tokenDecimals };
}

/** Whether each token fact came from the node ('observed') or only from the caller's declaration. */
export function tokenProvenanceOf(properties: ChainPropertiesJson): { tokenSymbol: 'declared' | 'observed'; tokenDecimals: 'declared' | 'observed' } {
  return {
    tokenSymbol: first(properties.tokenSymbol) !== undefined ? 'observed' : 'declared',
    tokenDecimals: first(properties.tokenDecimals) !== undefined ? 'observed' : 'declared'
  };
}

/**
 * Pure: chain inputs -> the compiler's RuntimeFacts. specName/specVersion/transactionVersion/ss58Prefix
 * from the node are passed to factsFromMetadata, which throws if they disagree with the metadata itself.
 */
export function factsFromChainInputs(inputs: ChainInputs, opts: FactsOptions = {}): RuntimeFacts {
  const { tokenSymbol, tokenDecimals } = tokenInfo(inputs.properties, opts.declaredToken);
  const input: Parameters<typeof factsFromMetadata>[0] = {
    metadataHex: inputs.metadataHex,
    typesBundle: opts.typesBundle ?? readPinnedTypes(),
    genesisHash: inputs.genesisHash,
    tokenSymbol,
    tokenDecimals,
    specName: inputs.runtimeVersion.specName,
    specVersion: inputs.runtimeVersion.specVersion,
    transactionVersion: inputs.runtimeVersion.transactionVersion,
    blockNumber: inputs.head.number,
    // Recorded so the compiler's audit checks can see how each fact was learned. Substrate-style chains sign with AccountId32.
    tokenProvenance: tokenProvenanceOf(inputs.properties),
    signingAccountBytes: 32
  };
  const sv = (inputs.runtimeVersion as { stateVersion?: unknown }).stateVersion;
  if (typeof sv === 'number' && Number.isInteger(sv) && sv >= 0) input.stateVersion = sv;
  if (typeof inputs.properties.ss58Format === 'number') input.ss58Prefix = inputs.properties.ss58Format;
  if (opts.batchAllRollback) input.batchAllRollback = opts.batchAllRollback;
  if (opts.batchAllRollbackProof) input.batchAllRollbackProof = opts.batchAllRollbackProof;
  if (inputs.endpoint) input.endpoint = inputs.endpoint;
  try {
    return quietly(() => factsFromMetadata(input));
  } catch (e) {
    throw new SeamChainError('FACTS_MISMATCH', (e as Error).message);
  }
}

/** Pure: chain inputs -> the nine-field fingerprint, via the compiler (so digests match byte for byte). */
export function fingerprintFromChainInputs(inputs: ChainInputs, typesBundleOrOpts?: string | FactsOptions): FreshFingerprint {
  const opts: FactsOptions = typeof typesBundleOrOpts === 'string' ? { typesBundle: typesBundleOrOpts } : typesBundleOrOpts ?? {};
  const facts = factsFromChainInputs(inputs, opts);
  return { fingerprint: facts.fingerprint, fingerprintDigest: computeFingerprintDigest(facts.fingerprint), atBlock: inputs.head };
}

/** Live discovery: connects, reads raw metadata, runtime version, genesis, properties and head, returns RuntimeFacts. */
export async function discover(endpoint: Endpoint, opts: DiscoverOptions = {}): Promise<RuntimeFacts> {
  const inputs = await readChainInputs(endpoint, opts);
  return factsFromChainInputs(inputs, opts);
}

/** Fresh fingerprint plus the block it was read at. */
export async function readFingerprint(endpoint: Endpoint, opts: DiscoverOptions = {}): Promise<FreshFingerprint> {
  const inputs = await readChainInputs(endpoint, opts);
  return fingerprintFromChainInputs(inputs, factsOptionsOf(opts));
}

function factsOptionsOf(opts: DiscoverOptions): FactsOptions {
  const out: FactsOptions = {};
  if (opts.typesBundle !== undefined) out.typesBundle = opts.typesBundle;
  if (opts.batchAllRollback !== undefined) out.batchAllRollback = opts.batchAllRollback;
  if (opts.batchAllRollbackProof !== undefined) out.batchAllRollbackProof = opts.batchAllRollbackProof;
  if (opts.declaredToken !== undefined) out.declaredToken = opts.declaredToken;
  return out;
}

/**
 * Re-reads the runtime right before submission. Pass the result as `currentFingerprint` to
 * @seam/policy's checkBeforeSubmit (it compares the nine fields with the prepared fingerprint).
 */
export async function refetchFingerprint(endpoint: Endpoint, opts: DiscoverOptions = {}): Promise<RuntimeFingerprint> {
  return (await readFingerprint(endpoint, opts)).fingerprint;
}

export async function listRpcMethods(endpoint: Endpoint, opts: ConnectOptions = {}): Promise<string[]> {
  return withClient(endpoint, async (client) => {
    const res = await rpc<{ methods?: string[] }>(client, 'rpc_methods', []);
    return [...(res?.methods ?? [])].sort();
  }, opts);
}

/** Signed extensions listed in the metadata, in order. */
export function signedExtensionsOf(metadataHex: string, typesBundle: string = readPinnedTypes()): string[] {
  return [...loadRuntime(metadataHex, typesBundle).registry.signedExtensions];
}

/** Pure: chain inputs -> snapshot JSON in the same format as the first mainnet snapshot. */
export interface SnapshotExtra {
  rpcMethods?: string[];
  fetchedAt?: string;
  typesBundle?: string;
  /** Recorded in the snapshot as `declaredToken` so a replay can see the values did not come from the node. */
  declaredToken?: { tokenSymbol: string; tokenDecimals: number };
}

export function snapshotFromChainInputs(inputs: ChainInputs, extra: SnapshotExtra = {}): SnapshotJson {
  const fpOpts: FactsOptions = {};
  if (extra.typesBundle !== undefined) fpOpts.typesBundle = extra.typesBundle;
  if (extra.declaredToken !== undefined) fpOpts.declaredToken = extra.declaredToken;
  const fp = fingerprintFromChainInputs(inputs, fpOpts);
  const snap: SnapshotJson = {
    endpoint: inputs.endpoint ?? '',
    block: inputs.head.number,
    block_hash: inputs.head.hash,
    genesis: inputs.genesisHash,
    runtime: inputs.runtimeVersion,
    metadata_blake2b256: blake2AsHex(hexToU8a(inputs.metadataHex), 256).slice(2),
    properties: inputs.properties,
    signedExtensions: signedExtensionsOf(inputs.metadataHex, extra.typesBundle),
    fingerprintDigest: fp.fingerprintDigest
  };
  if (extra.fetchedAt) snap.fetchedAt = extra.fetchedAt;
  if (extra.rpcMethods) snap.rpcMethods = extra.rpcMethods;
  if (extra.declaredToken) snap.declaredToken = { ...extra.declaredToken, source: 'declared by the caller; system_properties did not report it' };
  return snap;
}

/** Pure: the reverse, for replaying a saved snapshot (e.g. the mainnet evidence files) offline. */
export function chainInputsFromSnapshot(snapshot: SnapshotJson, metadataHex: string): ChainInputs {
  const meta = metadataHex.trim().toLowerCase() as Hex;
  const hash = blake2AsHex(hexToU8a(meta), 256).slice(2);
  if (snapshot.metadata_blake2b256 && snapshot.metadata_blake2b256.toLowerCase() !== hash) {
    throw new SeamChainError('FACTS_MISMATCH', `metadata file does not match the snapshot (blake2b-256 ${hash} vs ${snapshot.metadata_blake2b256})`);
  }
  const inputs: ChainInputs = {
    metadataHex: meta,
    genesisHash: snapshot.genesis,
    runtimeVersion: snapshot.runtime,
    properties: snapshot.properties,
    head: { number: snapshot.block, hash: snapshot.block_hash }
  };
  if (snapshot.endpoint) inputs.endpoint = snapshot.endpoint;
  return inputs;
}

export interface SnapshotFiles { metadataPath: string; snapshotPath: string; snapshot: SnapshotJson }

/**
 * Writes `<name>-metadata.hex` and `<name>-snapshot.json` into outDir, the same evidence files as the
 * first mainnet snapshot (plus signed extensions, RPC methods, fetch time and fingerprint digest).
 * Read-only on the node. Meant for the V3 testnet once its RPC address is known.
 */
export async function snapshotFromNode(endpoint: Endpoint, outDir: string, opts: DiscoverOptions & { name?: string } = {}): Promise<SnapshotFiles> {
  const { inputs, rpcMethods } = await withClient(endpoint, async (client) => ({
    inputs: await readChainInputs(client),
    rpcMethods: await listRpcMethods(client).catch(() => undefined)
  }), opts);
  const label = endpointLabel(endpoint);
  if (label) inputs.endpoint = label;
  const extra: SnapshotExtra = { fetchedAt: new Date().toISOString() };
  if (rpcMethods) extra.rpcMethods = rpcMethods;
  if (opts.typesBundle) extra.typesBundle = opts.typesBundle;
  if (opts.declaredToken) extra.declaredToken = opts.declaredToken;
  const snapshot = snapshotFromChainInputs(inputs, extra);
  const name = opts.name ?? `${inputs.runtimeVersion.specName}-spec${inputs.runtimeVersion.specVersion}`;
  mkdirSync(outDir, { recursive: true });
  const metadataPath = join(outDir, `${name}-metadata.hex`);
  const snapshotPath = join(outDir, `${name}-snapshot.json`);
  writeFileSync(metadataPath, inputs.metadataHex);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 1) + '\n');
  return { metadataPath, snapshotPath, snapshot };
}
