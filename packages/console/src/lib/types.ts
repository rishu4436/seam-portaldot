// Shapes agreed by the SEAM team on Oct 11, 2026 (Bot 2 runtime facts + plan,
// Bot 3 policy + approval, Bot 5 manifest + receipt). Keep in sync with the
// shared packages once the monorepo exists.

export type Tri = "observed" | "not_observed" | "unknown";
export type Hex = `0x${string}`;

export interface Fingerprint {
  genesisHash: Hex;
  specName: string;
  specVersion: number;
  transactionVersion: number;
  metadataHash: Hex;
  metadataVersion: number;
  typesFileHash?: Hex;
  ss58Prefix: number;
  tokenSymbol: string;
  tokenDecimals: number;
  digest: Hex;
}

export interface Capability {
  id: string; // e.g. "Assets.transfer_keep_alive"
  status: Tri;
  pallet?: string;
  callIndex?: [number, number];
  argTypes?: string[];
  argTypesPartial?: boolean;
}

export interface BehaviourFact {
  id: "batch_all_rollback" | "fee_estimate" | "contract_dry_run" | "storage_deposit";
  status: "confirmed" | "failed" | "unknown";
  note?: string;
}

export interface RuntimeFacts {
  fingerprint: Fingerprint;
  capabilities: Capability[];
  behaviour: BehaviourFact[];
  endpoint: string;
  discoveredAtBlock: number;
}

export type AddressType = "SS58" | "AccountId32" | "H160";
export interface TypedAddress { type: AddressType; value: string; ss58Prefix?: number }

export type ActionKind = "assets.transfer" | "assets.mint" | "contracts.call" | "revive.call" | "nfts.mint";

export interface ManifestAction {
  id: string;
  kind: ActionKind;
  requires: string; // capability id
  args: Record<string, string | TypedAddress>;
}

export interface Manifest {
  version: "seam/manifest/v1";
  expectedChain?: { genesisHash: Hex; specVersion: number };
  signer: TypedAddress;
  preferredMode?: ExecutionMode;
  actions: ManifestAction[];
}

export type ExecutionMode = "atomic_verified" | "atomic_unverified" | "sequential" | "unavailable";

export interface PlanStep {
  actionId: string;
  capability: string;
  callIndex?: [number, number];
  encodedCall?: Hex;
  decoded: { assetId?: string; amount?: string; recipient?: string; contract?: string; value?: string; message?: string; selector?: string; abiHash?: string; args?: string };
  status: "ok" | "unavailable";
  reason?: string;
  /** Set when a run script filled this step by hand because the compiler can't encode it on this runtime yet. */
  shim?: string;
}

export interface Plan {
  manifestDigest: Hex;
  fingerprintDigest: Hex;
  signer: string;
  mode: ExecutionMode;
  steps: PlanStep[];
  digest: Hex;
  modeReason?: string;
  explain?: string;
}

export interface Estimate { value?: string; unknown?: boolean }
export interface PreflightStep { actionId: string; weight: Estimate; /** Weight V2 proof_size (bytes). Unknown on runtimes that don't report it (e.g. Portaldot spec 1002), never 0. */ proofSize?: Estimate; fee: Estimate; storageDeposit: Estimate; dryRun: "ok" | "failed" | "unknown"; note?: string }
export interface PreflightResult { steps: PreflightStep[]; totalFee: Estimate }

export interface SigningEnvelope { signer: string; nonce: number; mortalityBlocks: number; expiresAt: string }

export interface PolicyRuleResult { rule: string; outcome: "pass" | "block" | "unknown"; reason: string; actionId?: string }
export interface PolicyResult { allowed: boolean; rules: PolicyRuleResult[]; policyDigest: Hex; explain?: string }

export interface Approval { hash: Hex; covers: string[]; expiresAt: string; used: boolean }

export type StepStatus = "finalized" | "included" | "submitted" | "failed" | "not_run" | "checking" | "blocked";
export type Verification = "verified" | "not_verified" | "unknown";

export interface ReceiptStep {
  actionId: string;
  status: StepStatus;
  txHash?: Hex;
  block?: { number: number; hash: Hex };
  events: string[];
  verification: Verification;
  reason: string;
}

export interface Receipt {
  manifestDigest: Hex;
  planDigest: Hex;
  fingerprintDigest: Hex;
  policyDigest: Hex;
  approvalHash: Hex;
  mode: ExecutionMode;
  steps: ReceiptStep[];
  overall: "verified" | "partial" | "not_verified";
  checks: { confirmed: number; expected: number };
  digest: Hex;
  explain?: string;
}
