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
import { sealReceipt, type CoverageLevel, type EvidenceCoverage } from "./receiptintegrity";

export type ReceiptResult = "verified" | "partial" | "not_verified";

export interface ConsoleLiveReceipt {
  receiptKind: "seam/console-live-receipt/v1";
  /** SDK Receipt.result values only. */
  result: ReceiptResult;
  /**
   * The LIVE run's raw status as the submit/finality watcher reported it at finalization, BEFORE the effect check.
   * It is not updated by verification and is not the verdict; `result` is.
   */
  liveStatusAtFinalization: LiveOutcome["status"];
  liveStatusNote: string;
  txHash: string | null;
  block: { number: number; hash: string } | null;
  planDigest: string | null;
  manifestDigest: string | null;
  fingerprintDigest: string | null;
  /** The policy engine's createApproval hash bound at preSign (never the plan digest); null when none was bound. */
  approvalHash: string | null;
  /**
   * Everything createApproval (@seam/policy) took, so approvalHash can be recomputed:
   * createApproval({ ...approvalInputs, now: new Date(approvalInputs.now) }).approval.hash === approvalHash.
   * manifestDigest, plan, envelope (unsigned signing envelope), preflight (dry-run before signing), policy,
   * policyResult, fingerprint, now, and acknowledgedDowngrade when set. No signed bytes, no keys. null when none bound.
   */
  approvalInputs: (Record<string, unknown> & { now: string }) | null;
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
  /** Submit-gate runtime lock basis and hashes from the policy result; omitted when not reported. Never metadata bytes. */
  runtimeLock?: import("./signflow").RuntimeLockInfo;
  /** Submit-gate block detail (signed dry run) as reported; omitted when none. */
  blockDetail?: import("./signflow").BlockDetail;
  /** policyDigest(approvalInputs.policy) (@seam/policy); null when no policy was bound. */
  policyDigest: string | null;
  evidenceCoverage: EvidenceCoverage;
  integrityAlgo: string;
  /** Hash over every other field (see integrityAlgo). No signed bytes, no metadata. */
  integrityHash: string;
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
  /** preSign's approvalInput plus its `now` (ISO). */
  approvalInputs?: Record<string, unknown> & { now: string };
}): ConsoleLiveReceipt {
  const { out, plan, effect } = a;
  const steps = (effect?.steps ?? []).map((s) => ({ ...s }));
  // Every step must be verified by verifyStep; a transfer-only legacy check (no steps) never makes the result verified.
  const result: ReceiptResult =
    effect?.verdict === "effect_proven" && steps.length ? overallResult(steps) : "not_verified";
  const body = {
    receiptKind: "seam/console-live-receipt/v1" as const,
    result,
    liveStatusAtFinalization: out.status,
    liveStatusNote:
      "Raw submit/finality status before the effect check; not updated by verification. The verdict is `result`.",
    txHash: out.txHash ?? null,
    block: out.block ?? null,
    planDigest: plan?.digest ?? null,
    manifestDigest: plan?.manifestDigest ?? null,
    fingerprintDigest: plan?.fingerprintDigest ?? null,
    approvalHash: a.engineApprovalHash ?? null,
    approvalInputs: a.engineApprovalHash && a.approvalInputs ? a.approvalInputs : null,
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
    verification: (result === "verified"
      ? "effect_proven"
      : "unverified") as ConsoleLiveReceipt["verification"],
    verificationBasis: steps.length
      ? "verifyStep (@seam/sdk/browser) on the extrinsic's events read back from its finalized block; not chain_verified (that needs the Node verifyReceiptLive re-read)"
      : "no verifyStep verdict",
    ...(out.runtimeLock ? { runtimeLock: { ...out.runtimeLock } } : {}),
    ...(out.blockDetail ? { blockDetail: structuredClone(out.blockDetail) } : {}),
  };
  const lvl = (b: boolean | undefined): CoverageLevel => (b ? "reported" : "unknown");
  return sealReceipt(body, {
    feeEstimate: lvl(!!out.fee),
    // Sent only after checkBeforeSubmit passed, which needs the signed dry run to be ok.
    signedDryRun: out.submitted ? "reported" : out.blockDetail ? "failed" : "unknown",
    dispatchResult:
      out.txState === "finalized"
        ? "reported"
        : out.txState === "failed" || out.txState === "rejected"
          ? "failed"
          : "unknown",
    verifiedEffect: result === "verified" ? "proven" : "unknown",
    basis:
      "reported = as the node/gate returned it in this run; proven = verifyStep checked the effect from the finalized block's events; unknown = not checked. Not chain_verified.",
  });
}
