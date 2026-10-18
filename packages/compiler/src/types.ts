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
  /**
   * blake2b-256 of the raw bytes of the pinned type-definitions file (metadata V13 runtimes such as Portaldot
   * spec 1002). null for metadata V14+ runtimes, which are self-describing and use no pinned types.
   */
  typesBundleHash: Hex | null;
}

export type CapabilityStatus = "observed" | "not_observed" | "unknown";

export interface CapabilityArg {
  name: string;
  type: string;
}

export interface Capability {
  status: CapabilityStatus;
  palletIndex?: number;
  callIndex?: number;
  args?: CapabilityArg[];
  argTypesConfidence?: "full" | "partial";
}

export type BatchAllRollback = "verified" | "unknown" | "not_supported";

/**
 * Evidence that Utility.batch_all rolled back on a specific runtime (SEAM-012). A bare 'verified' string is
 * NOT enough to reach atomic_verified; the proof must match the facts' genesis + metadata hash + spec version and
 * cover every call kind in the plan.
 */
export interface AtomicRollbackProof {
  genesisHash: Hex;
  /** Must equal facts.fingerprint.metadataHash (the runtime fingerprint the test ran against). */
  metadataHash: Hex;
  specVersion: number;
  /** Optional extra binding: must equal facts.fingerprintDigest when present. */
  fingerprintDigest?: Hex;
  /** Hash of the extrinsic/block where the failing batch was observed. At least one is required. */
  txHash?: Hex;
  blockHash?: Hex;
  /** Evidence of state before and after the failing batch (non-empty; e.g. balances/asset supply readings). */
  preState: unknown;
  postState: unknown;
  /** Action kinds that were part of the tested batch, e.g. ['assets.transfer','contracts.call']. */
  composition: ActionKind[];
}

export interface RuntimeBehaviour {
  batchAllRollback: BatchAllRollback;
  /** Required (and checked) for 'verified' to promote a plan to atomic_verified. */
  batchAllRollbackProof?: AtomicRollbackProof;
}

export interface RuntimeFacts {
  fingerprint: RuntimeFingerprint;
  fingerprintDigest: Hex;
  /** 'Pallet.call_name' -> capability. */
  capabilities: Record<string, Capability>;
  behaviour: RuntimeBehaviour;
  /** Informational only, not part of the fingerprint (nor of fingerprintDigest, which stays schema V1). */
  endpoint?: string;
  /** state_version from RuntimeVersion, when the caller supplied it. Not in the fingerprint. */
  stateVersion?: number;
  /** Metadata version (13, 14, ...) read from the metadata bytes. Not in the fingerprint. */
  metadataVersion?: number;
  /** Where tokenSymbol/tokenDecimals came from: 'declared' by the caller or 'observed' from the chain (system_properties). */
  tokenProvenance?: {
    tokenSymbol: "declared" | "observed";
    tokenDecimals: "declared" | "observed";
  };
  /** Byte length of the account that signs extrinsics on this runtime: 32 (AccountId32, default) or 20 (H160). */
  signingAccountBytes?: 20 | 32;
  blockNumber?: number;
  /**
   * Raw material the compiler needs to encode calls. Not part of the fingerprint,
   * but checked against it: blake2b-256(metadata) must equal fingerprint.metadataHash
   * and blake2b-256(typesBundle) must equal fingerprint.typesBundleHash.
   */
  source: {
    metadataHex: Hex;
    /** Exact text of the pinned type-definitions file (V13), or NO_PINNED_TYPES for V14+ runtimes. */
    typesBundle: string;
  };
}

export type ActionKind =
  "assets.transfer" | "assets.mint" | "contracts.call" | "revive.call" | "nfts.mint";

export type SignerType = "ss58" | "accountId32" | "h160";

export interface ManifestSigner {
  type: SignerType;
  value: string;
  ss58Prefix?: number;
}

export interface ManifestAction {
  id: string;
  kind: ActionKind;
  args: Record<string, unknown>;
  preferredMode?: "atomic" | "sequential";
}

export interface Manifest {
  version: 1;
  /**
   * When true the plan must run atomically (atomic_verified, or atomic_unverified only if allowAtomicUnverified);
   * otherwise mode is 'unavailable' and no step carries an executable call. Distinct from preferredMode, which
   * only prefers atomic and may fall back to sequential (flagged by Plan.modeDowngrade). Absent = old behaviour.
   */
  atomicRequired?: boolean;
  chain?: { genesisHash: string; specVersion: number };
  signer: ManifestSigner;
  actions: ManifestAction[];
}

export type PlanMode = "atomic_verified" | "atomic_unverified" | "sequential" | "unavailable";

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
  /**
   * Normalised arguments as base-unit / SS58 / hex strings. contracts.call on Weight-v2 runtimes also has
   * proofSize (string) and storageDepositLimit (string, or **null** = the manifest explicitly chose no limit).
   * NOTE: typed Record<string, string> so existing consumers keep compiling; storageDepositLimit is the one
   * key that can be null at runtime (policy reads it that way).
   */
  decodedArgs: Record<string, string>;
  encodedCall: Hex | null;
  status: "ok" | "unavailable";
  reason?: string;
  /** Stable machine-readable code for why the step is unavailable (only set for capability blockers SEAM can name). */
  reasonCode?: StepReasonCode;
  /**
   * Present only for a contracts.call written with `message` (ink! ABI form). Covered by planDigest.
   * The raw-`data` form never has it, so its plans and digests are unchanged.
   */
  contractMessage?: ContractMessage;
}

/** JSON value of an ink! message argument after normalisation (integers as strings, accounts as SS58, bytes as hex). */
export type InkArgValue = string | boolean | null | InkArgValue[] | { [k: string]: InkArgValue };

export interface ContractMessage {
  /** blake2b-256("seam/abi/v1" || 0x00 || canonicalJSON(abi)). */
  abiHash: Hex;
  /** The manifest's abiRef, when the ABI came from options.abis rather than inline. */
  abiRef?: string;
  /** ink! message label, e.g. "settle". */
  message: string;
  /** 4-byte selector; always equal to the first 4 bytes of decodedArgs.data. */
  selector: Hex;
  /** Arguments keyed by ABI label, decoded back from the encoded bytes. */
  args: Record<string, InkArgValue>;
}

/** Stable strings; never rename. */
export type StepReasonCode =
  "NO_OBSERVED_V3_METADATA" | "V3_ARG_SHAPE_MISMATCH" | "ATOMIC_REQUIRED_UNAVAILABLE";

export interface ModeDowngrade {
  from: "atomic";
  to: "sequential";
  requiresApproval: true;
  partialExecutionRisk: string;
}

export interface Plan {
  planVersion: 1;
  manifestDigest: Hex;
  fingerprintDigest: Hex;
  signer: PlanSigner;
  mode: PlanMode;
  /** Plain-language reason for the chosen mode. */
  modeReason: string;
  /** Present only when an atomic preference fell back to sequential. A person must approve it. */
  modeDowngrade?: ModeDowngrade;
  steps: PlanStep[];
  /** Utility.batch_all wrapping every step, present only when mode is atomic_*. */
  outerCall?: { capability: string; palletIndex: number; callIndex: number; encodedCall: Hex };
  planDigest: Hex;
}

export interface CompileOptions {
  /** Allow Utility.batch_all even when its rollback behaviour is not verified. Default false. */
  allowAtomicUnverified?: boolean;
  /**
   * ink! ABIs (metadata.json objects) that contracts.call actions can name with `abiRef` instead of
   * inlining `abi`. Only the referenced ABI's hash goes into the plan.
   */
  abis?: Record<string, unknown>;
}

export interface CompileIssue {
  code: CompileErrorCode;
  message: string;
  /** Where the problem is, e.g. 'actions[1].args.amount'. */
  path?: string;
}

export type CompileErrorCode =
  | "MANIFEST_INVALID"
  | "NOT_CANONICAL"
  | "AMOUNT_INVALID"
  | "ADDRESS_INVALID"
  | "ADDRESS_TYPE"
  | "SS58_PREFIX"
  | "CHAIN_MISMATCH"
  | "FACTS_INVALID"
  | "ENCODE_FAILED"
  | "ABI_INVALID"
  | "ABI_HASH_MISMATCH"
  | "ABI_MESSAGE_UNKNOWN"
  | "ABI_ARGS_INVALID"
  | "SIGNER_DOMAIN_MISMATCH";

export class SeamCompileError extends Error {
  readonly issues: CompileIssue[];
  constructor(issues: CompileIssue[]) {
    super(issues.map((i) => `${i.code}${i.path ? ` at ${i.path}` : ""}: ${i.message}`).join("; "));
    this.name = "SeamCompileError";
    this.issues = issues;
  }
  get codes(): CompileErrorCode[] {
    return this.issues.map((i) => i.code);
  }
}
