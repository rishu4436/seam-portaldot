import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hexToU8a } from "@polkadot/util";
import { blake2AsHex } from "@polkadot/util-crypto";
import {
  loadRuntime,
  readPinnedTypes,
  type Hex,
  type RuntimeFacts,
  type RuntimeFingerprint,
} from "@seam/compiler";
import { SeamChainError } from "./errors.js";
import {
  factsFromChainInputs as coreFacts,
  fingerprintFromChainInputs as coreFingerprint,
  type FactsOptions,
} from "./facts-core.js";
export { tokenInfo, tokenProvenanceOf, pinnedInputs, type FactsOptions } from "./facts-core.js";
import {
  endpointLabel,
  rpc,
  toSafeNumber,
  withClient,
  type ConnectOptions,
  type Endpoint,
} from "./rpc.js";
import type {
  BlockRef,
  ChainInputs,
  ChainPropertiesJson,
  FreshFingerprint,
  RuntimeVersionJson,
  SnapshotJson,
} from "./types.js";

export interface DiscoverOptions extends ConnectOptions, FactsOptions {}

export { readHead } from "./rpc-core.js";
import { asHash, readHead } from "./rpc-core.js";

const HASH_RE = /^0x[0-9a-f]{64}$/;

/** Finalized head: the block to use as the era checkpoint in a signing envelope. */
export async function readCheckpoint(
  endpoint: Endpoint,
  opts: ConnectOptions = {},
): Promise<BlockRef> {
  return withClient(
    endpoint,
    async (client) => {
      const hash = asHash(await rpc(client, "chain_getFinalizedHead", []), "finalized head");
      const header = await rpc<{ number: unknown } | null>(client, "chain_getHeader", [hash]);
      if (!header)
        throw new SeamChainError("NODE_MISSING_VALUE", `no header for finalized block ${hash}`);
      return { number: toSafeNumber(header.number), hash };
    },
    opts,
  );
}

/**
 * Era checkpoint for a signing envelope: the finalized head, or its parent when the finalized head is also the
 * best block. Why: system_dryRun applies the extrinsic on top of the best block's state without initializing a
 * new block, and System.BlockHash has no entry for the current block yet, so a transaction born at the best block
 * dry-runs as Invalid(AncientBirthBlock) although the pool would accept it. That happens whenever finality keeps
 * up with the head (instant-seal dev nodes). The parent is finalized too, so nothing is lost.
 */
export async function readSigningCheckpoint(
  endpoint: Endpoint,
  opts: ConnectOptions = {},
): Promise<BlockRef> {
  return withClient(
    endpoint,
    async (client) => {
      const hash = asHash(await rpc(client, "chain_getFinalizedHead", []), "finalized head");
      const header = await rpc<{ number: unknown; parentHash: unknown } | null>(
        client,
        "chain_getHeader",
        [hash],
      );
      if (!header)
        throw new SeamChainError("NODE_MISSING_VALUE", `no header for finalized block ${hash}`);
      const finalized = { number: toSafeNumber(header.number), hash };
      const best = await readHead(client);
      const parent = typeof header.parentHash === "string" ? header.parentHash.toLowerCase() : "";
      if (
        best.hash !== finalized.hash ||
        finalized.number === 0 ||
        !HASH_RE.test(parent) ||
        /^0x0+$/.test(parent)
      )
        return finalized;
      return { number: finalized.number - 1, hash: parent as Hex };
    },
    opts,
  );
}

/** Reads the raw inputs discovery needs, all pinned to the current best block. */
export async function readChainInputs(
  endpoint: Endpoint,
  opts: ConnectOptions = {},
): Promise<ChainInputs> {
  return withClient(
    endpoint,
    async (client) => {
      const head = await readHead(client);
      const [metadataHex, runtimeVersion, properties, genesis] = await Promise.all([
        rpc<string>(client, "state_getMetadata", [head.hash]),
        rpc<RuntimeVersionJson>(client, "state_getRuntimeVersion", [head.hash]),
        rpc<ChainPropertiesJson>(client, "system_properties", []),
        rpc<string>(client, "chain_getBlockHash", [0]),
      ]);
      if (typeof metadataHex !== "string" || !/^0x[0-9a-fA-F]+$/.test(metadataHex)) {
        throw new SeamChainError(
          "NODE_MISSING_VALUE",
          "state_getMetadata returned no metadata bytes",
        );
      }
      if (
        !runtimeVersion ||
        typeof runtimeVersion.specVersion !== "number" ||
        typeof runtimeVersion.transactionVersion !== "number"
      ) {
        throw new SeamChainError(
          "NODE_MISSING_VALUE",
          "state_getRuntimeVersion returned no spec/transaction version",
        );
      }
      const inputs: ChainInputs = {
        metadataHex: metadataHex.toLowerCase() as Hex,
        genesisHash: asHash(genesis, "genesis hash"),
        runtimeVersion,
        properties: properties ?? {},
        head,
      };
      const label = endpointLabel(endpoint);
      if (label) inputs.endpoint = label;
      return inputs;
    },
    opts,
  );
}

/**
 * Pure: chain inputs -> the compiler's RuntimeFacts (see facts-core.ts). The node default for `typesBundle` is the
 * compiler's pinned Portaldot spec 1002 file, read from disk.
 */
export function factsFromChainInputs(inputs: ChainInputs, opts: FactsOptions = {}): RuntimeFacts {
  return coreFacts(inputs, { ...opts, typesBundle: opts.typesBundle ?? readPinnedTypes() });
}

/** Pure: chain inputs -> the nine-field fingerprint, via the compiler (so digests match byte for byte). */
export function fingerprintFromChainInputs(
  inputs: ChainInputs,
  typesBundleOrOpts?: string | FactsOptions,
): FreshFingerprint {
  const opts: FactsOptions =
    typeof typesBundleOrOpts === "string"
      ? { typesBundle: typesBundleOrOpts }
      : (typesBundleOrOpts ?? {});
  return coreFingerprint(inputs, { ...opts, typesBundle: opts.typesBundle ?? readPinnedTypes() });
}

/** Live discovery: connects, reads raw metadata, runtime version, genesis, properties and head, returns RuntimeFacts. */
export async function discover(
  endpoint: Endpoint,
  opts: DiscoverOptions = {},
): Promise<RuntimeFacts> {
  const inputs = await readChainInputs(endpoint, opts);
  return factsFromChainInputs(inputs, opts);
}

/** Fresh fingerprint plus the block it was read at. */
export async function readFingerprint(
  endpoint: Endpoint,
  opts: DiscoverOptions = {},
): Promise<FreshFingerprint> {
  const inputs = await readChainInputs(endpoint, opts);
  return fingerprintFromChainInputs(inputs, factsOptionsOf(opts));
}

function factsOptionsOf(opts: DiscoverOptions): FactsOptions {
  const out: FactsOptions = {};
  if (opts.typesBundle !== undefined) out.typesBundle = opts.typesBundle;
  if (opts.batchAllRollback !== undefined) out.batchAllRollback = opts.batchAllRollback;
  if (opts.batchAllRollbackProof !== undefined)
    out.batchAllRollbackProof = opts.batchAllRollbackProof;
  if (opts.declaredToken !== undefined) out.declaredToken = opts.declaredToken;
  if (opts.pinnedMetadataHex !== undefined) out.pinnedMetadataHex = opts.pinnedMetadataHex;
  return out;
}

/**
 * Re-reads the runtime right before submission. Pass the result as `currentFingerprint` to
 * @seam/policy's checkBeforeSubmit (it compares the nine fields with the prepared fingerprint).
 */
export async function refetchFingerprint(
  endpoint: Endpoint,
  opts: DiscoverOptions = {},
): Promise<RuntimeFingerprint> {
  return (await readFingerprint(endpoint, opts)).fingerprint;
}

export async function listRpcMethods(
  endpoint: Endpoint,
  opts: ConnectOptions = {},
): Promise<string[]> {
  return withClient(
    endpoint,
    async (client) => {
      const res = await rpc<{ methods?: string[] }>(client, "rpc_methods", []);
      return [...(res?.methods ?? [])].sort();
    },
    opts,
  );
}

/** Signed extensions listed in the metadata, in order. */
export function signedExtensionsOf(
  metadataHex: string,
  typesBundle: string = readPinnedTypes(),
): string[] {
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

export function snapshotFromChainInputs(
  inputs: ChainInputs,
  extra: SnapshotExtra = {},
): SnapshotJson {
  const fpOpts: FactsOptions = {};
  if (extra.typesBundle !== undefined) fpOpts.typesBundle = extra.typesBundle;
  if (extra.declaredToken !== undefined) fpOpts.declaredToken = extra.declaredToken;
  const fp = fingerprintFromChainInputs(inputs, fpOpts);
  const snap: SnapshotJson = {
    endpoint: inputs.endpoint ?? "",
    block: inputs.head.number,
    block_hash: inputs.head.hash,
    genesis: inputs.genesisHash,
    runtime: inputs.runtimeVersion,
    metadata_blake2b256: blake2AsHex(hexToU8a(inputs.metadataHex), 256).slice(2),
    properties: inputs.properties,
    signedExtensions: signedExtensionsOf(inputs.metadataHex, extra.typesBundle),
    fingerprintDigest: fp.fingerprintDigest,
  };
  if (extra.fetchedAt) snap.fetchedAt = extra.fetchedAt;
  if (extra.rpcMethods) snap.rpcMethods = extra.rpcMethods;
  if (extra.declaredToken)
    snap.declaredToken = {
      ...extra.declaredToken,
      source: "declared by the caller; system_properties did not report it",
    };
  return snap;
}

/** Pure: the reverse, for replaying a saved snapshot (e.g. the mainnet evidence files) offline. */
export function chainInputsFromSnapshot(snapshot: SnapshotJson, metadataHex: string): ChainInputs {
  const meta = metadataHex.trim().toLowerCase() as Hex;
  const hash = blake2AsHex(hexToU8a(meta), 256).slice(2);
  if (snapshot.metadata_blake2b256 && snapshot.metadata_blake2b256.toLowerCase() !== hash) {
    throw new SeamChainError(
      "FACTS_MISMATCH",
      `metadata file does not match the snapshot (blake2b-256 ${hash} vs ${snapshot.metadata_blake2b256})`,
    );
  }
  const inputs: ChainInputs = {
    metadataHex: meta,
    genesisHash: snapshot.genesis,
    runtimeVersion: snapshot.runtime,
    properties: snapshot.properties,
    head: { number: snapshot.block, hash: snapshot.block_hash },
  };
  if (snapshot.endpoint) inputs.endpoint = snapshot.endpoint;
  return inputs;
}

export interface SnapshotFiles {
  metadataPath: string;
  snapshotPath: string;
  snapshot: SnapshotJson;
}

/**
 * Writes `<name>-metadata.hex` and `<name>-snapshot.json` into outDir, the same evidence files as the
 * first mainnet snapshot (plus signed extensions, RPC methods, fetch time and fingerprint digest).
 * Read-only on the node. Meant for the V3 testnet once its RPC address is known.
 */
export async function snapshotFromNode(
  endpoint: Endpoint,
  outDir: string,
  opts: DiscoverOptions & { name?: string } = {},
): Promise<SnapshotFiles> {
  const { inputs, rpcMethods } = await withClient(
    endpoint,
    async (client) => ({
      inputs: await readChainInputs(client),
      rpcMethods: await listRpcMethods(client).catch(() => undefined),
    }),
    opts,
  );
  const label = endpointLabel(endpoint);
  if (label) inputs.endpoint = label;
  const extra: SnapshotExtra = { fetchedAt: new Date().toISOString() };
  if (rpcMethods) extra.rpcMethods = rpcMethods;
  if (opts.typesBundle) extra.typesBundle = opts.typesBundle;
  if (opts.declaredToken) extra.declaredToken = opts.declaredToken;
  const snapshot = snapshotFromChainInputs(inputs, extra);
  const name =
    opts.name ?? `${inputs.runtimeVersion.specName}-spec${inputs.runtimeVersion.specVersion}`;
  mkdirSync(outDir, { recursive: true });
  const metadataPath = join(outDir, `${name}-metadata.hex`);
  const snapshotPath = join(outDir, `${name}-snapshot.json`);
  writeFileSync(metadataPath, inputs.metadataHex);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 1) + "\n");
  return { metadataPath, snapshotPath, snapshot };
}
