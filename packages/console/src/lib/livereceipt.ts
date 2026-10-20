// The console LIVE receipt: ONE object, shown in the panel and downloaded as is.
// result uses the SDK Receipt schema's values ("verified" | "partial" | "not_verified", @seam/sdk Receipt.result), computed
// by the same overallResult (@seam/policy) the SDK uses: "verified" only when every step is finalized AND verifyStep
// verified it. It is never "chain_verified": that provenance comes only from the Node verifyReceiptLive re-read.
// The per-step verdicts are verifyStep's output (atomic: perStepOfBatch, "per-step from batch outcome"). No signed bytes
// or call bytes are in it.
import { overallResult } from "@seam/policy/browser";
import type { SdkReceiptStep } from "@seam/sdk/browser";
import type { EffectVerdict } from "./effectcheck";
import type { LiveOutcome } from "./live";
import type { Approval, Plan } from "./types";

export type ReceiptResult = "verified" | "partial" | "not_verified";

export interface ConsoleLiveReceipt {
  receiptKind: "seam/console-live-receipt/v1";
  /** SDK Receipt.result values only. */
  result: ReceiptResult;
  /** The LIVE run's own status (transport + finality), kept separately from the verdict. */
  liveStatus: LiveOutcome["status"];
  txHash: string | null;
  block: { number: number; hash: string } | null;
  planDigest: string | null;
  manifestDigest: string | null;
  fingerprintDigest: string | null;
  /** The policy engine's createApproval hash bound at preSign (never the plan digest); null when none was bound. */
  approvalHash: string | null;
  signer: string | null;
  /** Actual fee paid, from this extrinsic's TransactionPayment.TransactionFeePaid event; null when not read. */
  fee: string | null;
  feeBasis: string;
  /** payment_queryInfo estimate read before signing (not the paid fee). */
  feeEstimate: string | null;
  /** The compiled plan (encoded calls, mode, digests, signer) so planDigest can be recomputed; no signed bytes. */
  plan: unknown;
  coverage: LiveOutcome["coverage"];
  effect: EffectVerdict | { verdict: "not_verified"; reason: string };
  /** verifyStep output per plan step; empty when no verifyStep check ran. */
  steps: SdkReceiptStep[];
  verification: "effect_proven" | "unverified";
  verificationBasis: string;
}

export function buildLiveReceipt(a: {
  out: LiveOutcome;
  plan?: Plan;
  approval?: Approval;
  effect?: EffectVerdict;
  checked: boolean;
  /** Engine approval hash (preSign's createApproval). */
  engineApprovalHash?: string;
  /** The compiled plan (compiler Plan) the run signed. */
  compiledPlan?: unknown;
}): ConsoleLiveReceipt {
  const { out, plan, effect } = a;
  const steps = (effect?.steps ?? []).map((s) => ({ ...s }));
  // Every step must be verified by verifyStep; a transfer-only legacy check (no steps) never makes the result verified.
  const result: ReceiptResult =
    effect?.verdict === "effect_proven" && steps.length ? overallResult(steps) : "not_verified";
  return {
    receiptKind: "seam/console-live-receipt/v1",
    result,
    liveStatus: out.status,
    txHash: out.txHash ?? null,
    block: out.block ?? null,
    planDigest: plan?.digest ?? null,
    manifestDigest: plan?.manifestDigest ?? null,
    fingerprintDigest: plan?.fingerprintDigest ?? null,
    approvalHash: a.engineApprovalHash ?? null,
    signer: plan?.signer ?? null,
    fee: effect?.feePaid ?? null,
    feeBasis: effect?.feePaid
      ? "actual fee: TransactionPayment.TransactionFeePaid of this extrinsic"
      : "actual fee not read",
    feeEstimate: out.fee ?? null,
    plan: a.compiledPlan ?? null,
    coverage: out.coverage,
    effect: effect ?? {
      verdict: "not_verified",
      reason: a.checked ? "not checked yet" : "no effect check for this plan",
    },
    steps,
    verification: result === "verified" ? "effect_proven" : "unverified",
    verificationBasis: steps.length
      ? "verifyStep (@seam/sdk/browser) on the extrinsic's events read back from its finalized block; not chain_verified (that needs the Node verifyReceiptLive re-read)"
      : "no verifyStep verdict",
  };
}
