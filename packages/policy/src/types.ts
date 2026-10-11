// Policy-side shapes. Runtime facts, Manifest and Plan come from Bot 2's compiler (compilerTypes.ts);
// preflight, envelope, policy result, approval and receipt shapes are the ones the team agreed on Oct 11, 2026.
export * from "./compilerTypes.js";
import type { Hex } from "./compilerTypes.js";

export interface Estimate { value?: string; unknown?: boolean }
export interface PreflightStep {
  actionId: string;
  weight: Estimate;
  fee: Estimate;
  storageDeposit: Estimate;
  dryRun: "ok" | "failed" | "unknown";
  note?: string;
}
export interface PreflightResult { steps: PreflightStep[]; totalFee: Estimate }

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

export interface PolicyRuleResult { rule: string; outcome: "pass" | "block" | "unknown"; reason: string; actionId?: string }
export interface PolicyResult { allowed: boolean; rules: PolicyRuleResult[]; policyDigest: Hex }

export interface Approval { hash: Hex; covers: string[]; expiresAt: string; used: boolean }

export type StepStatus = "finalized" | "included" | "submitted" | "failed" | "not_run";
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
