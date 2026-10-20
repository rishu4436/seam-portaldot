// The console LIVE receipt for a sequential multi-step run: ONE object, shown in the panel and downloaded as is.
// approvalHash is the single engine createApproval hash that bound the whole plan (preSign), never the plan digest;
// approvalInputs (same shape as the single-transaction receipt, with `now`) let anyone rerun createApproval.
// result is overallResult(steps) from @seam/policy/browser (the SDK's own rule, so console and SDK can't drift):
// "verified" only when every step is finalized and verified; "partial" when any step did not run (a stopped run);
// otherwise "not_verified". Never chain_verified. A step that was never sent has the SDK's status "not_run".
// No signed bytes: only read-back outcomes (txHash, block, decoded events) are used.
import { overallResult } from "@seam/policy/browser";
import type { MultiStepResult } from "./multistep";
import { feePaidOf, matchedEvent } from "./stepverify";

export interface SequentialReceiptStep {
  index: number;
  actionId: string;
  sent: boolean;
  /** Broadcast order (0-based); null when never sent. */
  sendIndex: number | null;
  status: string;
  txHash: string | null;
  block: { number: number; hash: string } | null;
  extrinsicIndex: number | null;
  /** Actual fee from this extrinsic's TransactionFeePaid event; null when not read. */
  fee: string | null;
  /** The plan's expected effect event as found in this extrinsic's events; {} when none matched. */
  event: Record<string, string>;
  /** verifyStep verdict; "unknown" when the step never ran (status "not_run", as in the SDK ReceiptStep). */
  verification: "verified" | "not_verified" | "unknown";
  reason: string;
  /** Submit-gate runtime lock basis and hashes for this step, from the policy result; omitted when not reported. */
  runtimeLock?: import("./signflow").RuntimeLockInfo;
  /** Why the submit gate blocked this step (signed dry run), as reported; omitted when none. */
  blockDetail?: import("./signflow").BlockDetail;
  /** Nonce this step was actually signed with (receipt metadata; not in approvalInputs). Omitted when unknown. */
  nonce?: number;
  nonceSource?: "decoded" | "signing_request";
}

export interface SequentialReceipt {
  receiptKind: "seam/console-live-receipt/v1";
  mode: "sequential";
  result: "verified" | "partial" | "not_verified";
  resultBasis: string;
  approvalHash: string | null;
  approvalInputs: (Record<string, unknown> & { now: string }) | null;
  planDigest: string | null;
  manifestDigest: string | null;
  fingerprintDigest: string | null;
  plan: unknown;
  steps: SequentialReceiptStep[];
  /** True when the run stopped before every step was sent. */
  partialRun: boolean;
  /** 0-based index of the step that stopped the run, or null. */
  stoppedAt: number | null;
  stopReason: string | null;
}

export function buildSequentialReceipt(r: MultiStepResult): SequentialReceipt {
  const plan = (r.plan ?? null) as {
    planDigest?: string;
    manifestDigest?: string;
    fingerprintDigest?: string;
    signer?: { publicKey?: string };
    steps?: unknown[];
  } | null;
  const signerAccountId = plan?.signer?.publicKey;
  const steps: SequentialReceiptStep[] = r.steps.map((s) => {
    const o = s.outcome;
    const sent = s.sendIndex !== undefined;
    const event =
      o && signerAccountId
        ? matchedEvent({ step: plan?.steps?.[s.index], signerAccountId } as never, o)
        : {};
    return {
      index: s.index,
      actionId: s.actionId,
      sent,
      sendIndex: sent ? s.sendIndex! : null,
      status: sent ? (s.receipt?.status ?? "uncertain") : "not_run",
      txHash: o?.txHash ?? s.receipt?.txHash ?? null,
      block: o?.block ?? s.receipt?.block ?? null,
      extrinsicIndex: typeof o?.extrinsicIndex === "number" ? o.extrinsicIndex : null,
      fee: o ? (feePaidOf(o) ?? null) : null,
      event,
      verification: (sent && s.receipt?.verification) || "unknown",
      reason: s.message,
      ...(s.runtimeLock ? { runtimeLock: { ...s.runtimeLock } } : {}),
      ...(s.blockDetail ? { blockDetail: structuredClone(s.blockDetail) } : {}),
      ...(typeof s.nonce === "number" ? { nonce: s.nonce, nonceSource: s.nonceSource } : {}),
    };
  });
  const result = overallResult(
    steps.map((s) => ({
      actionId: s.actionId,
      status: s.status as never,
      events: [],
      verification: s.verification,
      reason: s.reason,
    })),
  );
  const partialRun = steps.some((s) => !s.sent);
  const stopped = r.stoppedAt !== undefined ? r.stoppedAt : null;
  return {
    receiptKind: "seam/console-live-receipt/v1",
    mode: "sequential",
    result,
    resultBasis:
      "overallResult (@seam/policy/browser) over the per-step verifyStep verdicts: verified only if every step is finalized and verified, partial if any step did not run; not chain_verified",
    approvalHash: r.approval?.hash ?? null,
    approvalInputs: r.approval?.inputs ?? null,
    planDigest: plan?.planDigest ?? null,
    manifestDigest: plan?.manifestDigest ?? null,
    fingerprintDigest: plan?.fingerprintDigest ?? null,
    plan,
    steps,
    partialRun,
    stoppedAt: stopped,
    stopReason: r.ok ? null : r.message,
  };
}
