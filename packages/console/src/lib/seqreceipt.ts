// The console LIVE receipt for a sequential multi-step run: ONE object, shown in the panel and downloaded as is.
// approvalHash is the single engine createApproval hash that bound the whole plan (preSign), never the plan digest;
// approvalInputs (same shape as the single-transaction receipt, with `now`) let anyone rerun createApproval.
// result is "verified" only when every plan step was sent, finalized and verified by verifyStep; anything else
// (a failed check, an unknown verdict, or a run stopped at step k) is "not_verified". Never chain_verified.
// No signed bytes: only read-back outcomes (txHash, block, decoded events) are used.
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
  /** verifyStep verdict; "not_sent" when the step never ran. */
  verification: "verified" | "not_verified" | "unknown" | "not_sent";
  reason: string;
}

export interface SequentialReceipt {
  receiptKind: "seam/console-live-receipt/v1";
  mode: "sequential";
  result: "verified" | "not_verified";
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
      status: s.receipt?.status ?? (sent ? s.status : "not_run"),
      txHash: o?.txHash ?? s.receipt?.txHash ?? null,
      block: o?.block ?? s.receipt?.block ?? null,
      extrinsicIndex: typeof o?.extrinsicIndex === "number" ? o.extrinsicIndex : null,
      fee: o ? (feePaidOf(o) ?? null) : null,
      event,
      verification: s.receipt?.verification ?? (sent ? "unknown" : "not_sent"),
      reason: s.message,
    };
  });
  const allVerified =
    steps.length > 0 &&
    steps.every((s) => s.sent && s.status === "finalized" && s.verification === "verified");
  const partialRun = steps.some((s) => !s.sent);
  const stopped = r.stoppedAt !== undefined ? r.stoppedAt : null;
  return {
    receiptKind: "seam/console-live-receipt/v1",
    mode: "sequential",
    result: allVerified ? "verified" : "not_verified",
    resultBasis: allVerified
      ? "every step sent, finalized and verified by verifyStep (@seam/sdk/browser); not chain_verified"
      : partialRun
        ? "not every step was sent, so the plan is not verified"
        : "at least one step is not finalized and verified",
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
