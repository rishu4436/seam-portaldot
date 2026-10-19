import type { Hex } from "@seam/compiler";

export type { Hex };

// ---------------------------------------------------------------------------------------------------------
// Shapes owned by Bot 3's policy package (/workspace/seam-policy/src/types.ts @ fddfee3).
// Mirrored here field-for-field so @seam/chain output plugs straight into evaluatePolicy, createApproval
// and checkBeforeSubmit. Replace with an import once the monorepo exists. tests/policy.test.ts checks
// that they really plug in.
// ---------------------------------------------------------------------------------------------------------

/** A value the node reported (`value`, base units as a decimal string) or `unknown: true`. Never both. */
export interface Estimate {
  value?: string;
  unknown?: boolean;
}
export interface PreflightStep {
  actionId: string;
  weight: Estimate;
  fee: Estimate;
  storageDeposit: Estimate;
  /**
   * Proof size (PoV) part of the weight, from payment_queryInfo on two-part-weight (Weight V2) runtimes.
   * Unknown on Weight V1 runtimes (Portaldot spec 1002), which have no proof size. Optional in @seam/policy's
   * type (bot3/policy-file 71daa3b); @seam/chain always sets it.
   */
  proofSize?: Estimate;
  dryRun: "ok" | "failed" | "unknown";
  note?: string;
}
export interface PreflightResult {
  steps: PreflightStep[];
  totalFee: Estimate;
}

export interface SigningEnvelope {
  signer: string;
  nonce: number;
  mortalityBlocks: number;
  /** The block the mortality window starts from; the wallet signs against its hash. */
  checkpoint: { number: number; hash: Hex };
  expiresAt: string;
}

/** Result of system_dryRun on the actually signed transaction(s), one per signed call. */
export type SignedDryRun = "ok" | "failed" | "unknown";

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

export interface BlockRef {
  number: number;
  hash: Hex;
}

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
  /**
   * Set when the node's metadata differed from the caller's pinned metadata only in storage default values:
   * `metadataHex` then holds the pinned bytes, and this records the live hash (see metadata-layout.ts).
   */
  metadataDrift?: import("./metadata-layout.js").MetadataDrift;
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
  /** Token values the caller declared because system_properties had none (see DiscoverOptions.declaredToken). */
  declaredToken?: { tokenSymbol: string; tokenDecimals: number; source: string };
}

export interface FreshFingerprint {
  fingerprint: import("@seam/compiler").RuntimeFingerprint;
  fingerprintDigest: Hex;
  /** Block the fingerprint was read at. */
  atBlock: BlockRef;
  /** Layout hash of the metadata behind the fingerprint (storage defaults blanked; see metadataLayoutHash). */
  metadataLayoutHash?: Hex;
  /** Present when the live metadata differed from the pinned one only in storage defaults. */
  metadataDrift?: import("./metadata-layout.js").MetadataDrift;
}
