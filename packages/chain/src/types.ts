import type { Hex } from '@seam/compiler';

export type { Hex };

// ---------------------------------------------------------------------------------------------------------
// Shapes owned by Bot 3's policy package (/workspace/seam-policy/src/types.ts, agreed Oct 11, 2026).
// Mirrored here field-for-field so @seam/chain output plugs straight into evaluatePolicy, createApproval
// and checkBeforeSubmit. Replace with an import once the monorepo exists. tests/policy.test.ts checks
// that they really plug in.
// ---------------------------------------------------------------------------------------------------------

/** A value the node reported (`value`, base units as a decimal string) or `unknown: true`. Never both. */
export interface Estimate { value?: string; unknown?: boolean }
export interface PreflightStep {
  actionId: string;
  weight: Estimate;
  fee: Estimate;
  storageDeposit: Estimate;
  dryRun: 'ok' | 'failed' | 'unknown';
  note?: string;
}
export interface PreflightResult { steps: PreflightStep[]; totalFee: Estimate }

export interface SigningEnvelope { signer: string; nonce: number; mortalityBlocks: number; expiresAt: string }

// ---------------------------------------------------------------------------------------------------------
// @seam/chain shapes.
// ---------------------------------------------------------------------------------------------------------

/** state_getRuntimeVersion result, exactly as the node returns it. */
export interface RuntimeVersionJson {
  specName: string;
  implName?: string;
  authoringVersion?: number;
  specVersion: number;
  implVersion?: number;
  transactionVersion: number;
  apis?: [string, number][];
  [extra: string]: unknown;
}

/** system_properties result, exactly as the node returns it (fields may be single values or arrays). */
export interface ChainPropertiesJson {
  ss58Format?: number;
  tokenDecimals?: number | number[];
  tokenSymbol?: string | string[];
  [extra: string]: unknown;
}

export interface BlockRef { number: number; hash: Hex }

/** Everything discovery reads from a node, all pinned to one block. Pure data, so it can be saved and replayed. */
export interface ChainInputs {
  endpoint?: string;
  /** state_getMetadata at `head.hash`, raw. */
  metadataHex: Hex;
  /** chain_getBlockHash(0). */
  genesisHash: Hex;
  /** state_getRuntimeVersion at `head.hash`. */
  runtimeVersion: RuntimeVersionJson;
  /** system_properties. */
  properties: ChainPropertiesJson;
  /** Best block the reads were pinned to. */
  head: BlockRef;
}

/** Same format as /workspace/seam-evidence/portaldot-mainnet-snapshot.json, plus a few extra fields. */
export interface SnapshotJson {
  endpoint: string;
  block: number;
  block_hash: Hex;
  genesis: Hex;
  runtime: RuntimeVersionJson;
  /** blake2b-256 of the raw metadata, hex without 0x (as in the original snapshot). */
  metadata_blake2b256: string;
  properties: ChainPropertiesJson;
  /** Extra (not in the first snapshot): */
  fetchedAt?: string;
  signedExtensions?: string[];
  rpcMethods?: string[];
  fingerprintDigest?: Hex;
}

export interface FreshFingerprint {
  fingerprint: import('@seam/compiler').RuntimeFingerprint;
  fingerprintDigest: Hex;
  /** Block the fingerprint was read at. */
  atBlock: BlockRef;
}
