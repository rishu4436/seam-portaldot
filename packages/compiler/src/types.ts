/** Shared shapes agreed by the SEAM team (design draft). */

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
  typesBundleHash: Hex;
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

export interface CompileOptions {
  /** Allow Utility.batch_all even when its rollback behaviour is not verified. Default false. */
  allowAtomicUnverified?: boolean;
}

export interface CompileIssue {
  code: CompileErrorCode;
  message: string;
  /** Where the problem is, e.g. 'actions[1].args.amount'. */
  path?: string;
}

export type CompileErrorCode =
  | 'MANIFEST_INVALID'
  | 'NOT_CANONICAL'
  | 'AMOUNT_INVALID'
  | 'ADDRESS_INVALID'
  | 'ADDRESS_TYPE'
  | 'SS58_PREFIX'
  | 'CHAIN_MISMATCH'
  | 'FACTS_INVALID'
  | 'ENCODE_FAILED';

export class SeamCompileError extends Error {
  readonly issues: CompileIssue[];
  constructor(issues: CompileIssue[]) {
    super(issues.map((i) => `${i.code}${i.path ? ` at ${i.path}` : ''}: ${i.message}`).join('; '));
    this.name = 'SeamCompileError';
    this.issues = issues;
  }
  get codes(): CompileErrorCode[] {
    return this.issues.map((i) => i.code);
  }
}
