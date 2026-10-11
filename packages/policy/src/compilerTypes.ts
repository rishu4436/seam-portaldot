/** Copied from Bot 2's compiler (/workspace/seam-compiler/src/types.ts @ 58934d2). Replace with an import once the monorepo exists. */

export type Hex = `0x${string}`;

export interface RuntimeFingerprint {
  genesisHash: Hex;
  specName: string;
  specVersion: number;
  transactionVersion: number;
  /** blake2b-256 of the raw metadata bytes. */
  metadataHash: Hex;
  ss58Prefix: number;
  tokenSymbol: string;
  tokenDecimals: number;
  /** blake2b-256 of the raw bytes of the pinned type-definitions file. */
  typesBundleHash: Hex | null;
}

export type CapabilityStatus = 'observed' | 'not_observed' | 'unknown';

export interface CapabilityArg {
  name: string;
  type: string;
}

export interface Capability {
  status: CapabilityStatus;
  palletIndex?: number;
  callIndex?: number;
  args?: CapabilityArg[];
  argTypesConfidence?: 'full' | 'partial';
}

export type BatchAllRollback = 'verified' | 'unknown' | 'not_supported';

export interface RuntimeBehaviour {
  batchAllRollback: BatchAllRollback;
}

export interface RuntimeFacts {
  fingerprint: RuntimeFingerprint;
  fingerprintDigest: Hex;
  /** 'Pallet.call_name' -> capability. */
  capabilities: Record<string, Capability>;
  behaviour: RuntimeBehaviour;
  /** Informational only, not part of the fingerprint. */
  endpoint?: string;
  blockNumber?: number;
  /**
   * Raw material the compiler needs to encode calls. Not part of the fingerprint,
   * but checked against it: blake2b-256(metadata) must equal fingerprint.metadataHash
   * and blake2b-256(typesBundle) must equal fingerprint.typesBundleHash.
   */
  source: {
    metadataHex: Hex;
    /** Exact text of the pinned type-definitions file. */
    typesBundle: string;
  };
}

export type ActionKind = 'assets.transfer' | 'assets.mint' | 'contracts.call' | 'revive.call' | 'nfts.mint';

export type SignerType = 'ss58' | 'accountId32' | 'h160';

export interface ManifestSigner {
  type: SignerType;
  value: string;
  ss58Prefix?: number;
}

export interface ManifestAction {
  id: string;
  kind: ActionKind;
  args: Record<string, unknown>;
  preferredMode?: 'atomic' | 'sequential';
}

export interface Manifest {
  version: 1;
  chain?: { genesisHash: string; specVersion: number };
  signer: ManifestSigner;
  actions: ManifestAction[];
}

export type PlanMode = 'atomic_verified' | 'atomic_unverified' | 'sequential' | 'unavailable';

export interface PlanSigner {
  type: SignerType;
  value: string;
  /** 0x-prefixed AccountId32 (native signers) or H160 (h160 signers). */
  publicKey: Hex;
}

export interface PlanStep {
  actionId: string;
  kind: ActionKind;
  capability: string;
  palletIndex: number | null;
  callIndex: number | null;
  decodedArgs: Record<string, string>;
  encodedCall: Hex | null;
  status: 'ok' | 'unavailable';
  reason?: string;
}

export interface Plan {
  planVersion: 1;
  manifestDigest: Hex;
  fingerprintDigest: Hex;
  signer: PlanSigner;
  mode: PlanMode;
  /** Plain-language reason for the chosen mode. */
  modeReason: string;
  steps: PlanStep[];
  /** Utility.batch_all wrapping every step, present only when mode is atomic_*. */
  outerCall?: { capability: string; palletIndex: number; callIndex: number; encodedCall: Hex };
  planDigest: Hex;
}

