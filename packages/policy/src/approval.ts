import type {
  Approval, RuntimeFingerprint, SignedDryRun, Hex, Plan, PolicyResult, PreflightResult, ReceiptStep, SigningEnvelope,
} from "./types.js";
import { digest } from "./digest.js";
import { checkRuntimeLock, fingerprintDigest } from "./runtimeLock.js";
import { type Policy, policyDigest, planDigest } from "./policy.js";
import { normalizeAccount } from "./address.js";

/** Everything an approval commits to. Change any of it and the approval no longer matches. */
export interface ApprovalBinding {
  manifestDigest: Hex;
  planDigest: Hex;
  /** Digest of the whole plan object, so edits that skip recomputing plan.digest are still caught. */
  planContentDigest: Hex;
  /** Digest of the exact encoded calls the wallet must sign, in order. */
  callsDigest: Hex;
  fingerprintDigest: Hex;
  policyDigest: Hex;
  policyResultDigest: Hex;
  envelopeDigest: Hex;
  preflightDigest: Hex;
  signer: string;
  nonce: number;
  mortalityBlocks: number;
  expiresAt: string;
}

export interface BoundApproval extends Approval { binding: ApprovalBinding }

export interface ApprovalInput {
  manifestDigest: Hex;
  plan: Plan;
  envelope: SigningEnvelope;
  preflight: PreflightResult;
  policy: Policy;
  policyResult: PolicyResult;
  fingerprint: RuntimeFingerprint;
  now: Date;
}

const COVERS = ["manifest", "plan", "encoded calls", "runtime fingerprint", "policy", "policy result", "signing envelope", "preflight"];

/** The exact call bytes the wallet must sign: the one batch_all for atomic plans, otherwise each step in order. */
export function callsToSign(plan: Plan): (Hex | null)[] {
  if (plan.mode === "atomic_verified" || plan.mode === "atomic_unverified") return [plan.outerCall?.encodedCall ?? null];
  return plan.steps.map((s) => s.encodedCall);
}

export function callsDigest(plan: Plan): Hex {
  return digest("seam/calls/v1", callsToSign(plan));
}

const sameAccount = (a: string, b: string) => (normalizeAccount(a) ?? a.toLowerCase()) === (normalizeAccount(b) ?? b.toLowerCase());

function buildBinding(i: Omit<ApprovalInput, "now">, expiresAt: string): ApprovalBinding {
  return {
    manifestDigest: i.manifestDigest,
    planDigest: i.plan.planDigest,
    planContentDigest: digest("seam/plan-content/v1", i.plan),
    callsDigest: callsDigest(i.plan),
    fingerprintDigest: fingerprintDigest(i.fingerprint),
    policyDigest: policyDigest(i.policy),
    policyResultDigest: digest("seam/policy-result/v1", i.policyResult),
    envelopeDigest: digest("seam/envelope/v1", i.envelope),
    preflightDigest: digest("seam/preflight/v1", i.preflight),
    signer: i.envelope.signer,
    nonce: i.envelope.nonce,
    mortalityBlocks: i.envelope.mortalityBlocks,
    expiresAt,
  };
}

export type ApprovalOutcome = { ok: true; approval: BoundApproval } | { ok: false; reason: string };

/** Creates an approval only for an allowed, fully consistent plan. Expiry is the earlier of the envelope's and the policy's limit. */
export function createApproval(input: ApprovalInput): ApprovalOutcome {
  const { plan, envelope, policy, policyResult, fingerprint, now } = input;
  if (!policyResult.allowed) {
    const why = policyResult.rules.find((r) => r.outcome !== "pass")?.reason ?? "the policy check did not pass";
    return { ok: false, reason: `Can't approve: ${why}` };
  }
  if (planDigest(plan) !== plan.planDigest) return { ok: false, reason: "Can't approve: the plan was changed after it was compiled." };
  if (policyResult.policyDigest !== policyDigest(policy)) return { ok: false, reason: "Can't approve: the policy result was made with a different policy." };
  if (plan.fingerprintDigest !== fingerprintDigest(fingerprint)) return { ok: false, reason: "Can't approve: the plan was compiled for a different runtime." };
  if (!sameAccount(envelope.signer, plan.signer.publicKey)) {
    return { ok: false, reason: "Can't approve: the signing envelope's signer is not the plan's signer." };
  }
  if (callsToSign(plan).some((c) => !c)) return { ok: false, reason: "Can't approve: a call has no encoded bytes, so there is nothing exact to sign." };
  const envelopeExpiry = Date.parse(envelope.expiresAt);
  if (!envelope.checkpoint || !Number.isSafeInteger(envelope.checkpoint.number) || !/^0x[0-9a-fA-F]{64}$/.test(envelope.checkpoint.hash ?? "")) {
    return { ok: false, reason: "Can't approve: the signing envelope has no checkpoint block, so the wallet can't sign it." };
  }
  if (Number.isNaN(envelopeExpiry)) return { ok: false, reason: "Can't approve: the signing envelope has no valid expiry time." };
  if (envelopeExpiry <= now.getTime()) return { ok: false, reason: "Can't approve: the signing envelope has already expired." };
  const expiresAt = new Date(Math.min(envelopeExpiry, now.getTime() + policy.maxApprovalSeconds * 1000)).toISOString();

  const binding = buildBinding(input, expiresAt);
  const hash = digest("seam/approval/v1", binding);
  return { ok: true, approval: { hash, covers: COVERS, expiresAt, used: false, binding } };
}

/**
 * Remembers what was already submitted, so nothing can be replayed. Keys come from usageKey(): the approval hash
 * for a single submission (atomic, or one call), or "<hash>#<step>" for each step of a sequential plan.
 */
export interface ApprovalStore { has(key: string): boolean; markUsed(key: string): void }
export class InMemoryApprovalStore implements ApprovalStore {
  private used = new Set<string>();
  has(key: string) { return this.used.has(key); }
  markUsed(key: string) { this.used.add(key); }
}

/** The key to mark used after a submission: pass the same sendIndex you gave checkBeforeSubmit. */
export function usageKey(approvalHash: Hex, sendIndex?: number): string {
  return sendIndex === undefined ? approvalHash : `${approvalHash}#${sendIndex}`;
}

export interface SubmitCheckInput extends Omit<ApprovalInput, "now" | "fingerprint"> {
  approval: BoundApproval;
  /** Fingerprint the plan was prepared against. */
  preparedFingerprint: RuntimeFingerprint;
  /** Fingerprint read from the node right before submission. */
  currentFingerprint: RuntimeFingerprint;
  /** The encoded calls the wallet actually signed, in order. */
  signedCalls: Hex[];
  /** system_dryRun result for each signed transaction, in the same order. */
  signedDryRun?: SignedDryRun[];
  /**
   * Sequential plans: the index of the one transaction about to be sent. Call the gate again before every step,
   * after the previous one finalized, with a fresh fingerprint and dry run. Then only this transaction's dry run
   * must be ok (later ones can't pass yet because their nonce is in the future).
   */
  sendIndex?: number;
  /** Sequential plans: receipt steps for every earlier step; all must have completed and verified. */
  previousSteps?: ReceiptStep[];
  now: Date;
  store: ApprovalStore;
}

export interface SubmitCheck { ok: boolean; reasons: { code: string; message: string }[] }

/**
 * The last gate before broadcasting. Recomputes the binding from what is about to be sent and blocks on any
 * mismatch, an expired or reused approval, a runtime change, or signed bytes that differ from the approved calls.
 * Call store.markUsed(usageKey(approval.hash, sendIndex)) once the transaction is submitted.
 */
export function checkBeforeSubmit(input: SubmitCheckInput): SubmitCheck {
  const reasons: SubmitCheck["reasons"] = [];
  const { approval, now, store, plan } = input;

  const i = input.sendIndex;
  const sequential = plan.mode === "sequential";
  if (i !== undefined) {
    const n = callsToSign(plan).length;
    if (!sequential) reasons.push({ code: "send_index_invalid", message: "Blocked: only sequential plans are sent one step at a time; an atomic plan is one transaction." });
    else if (!Number.isInteger(i) || i < 0 || i >= n) reasons.push({ code: "send_index_invalid", message: `Blocked: step ${i} doesn't exist in this ${n}-step plan.` });
    else {
      for (let j = 0; j < i; j++) {
        if (!store.has(usageKey(approval.hash, j))) {
          reasons.push({ code: "out_of_order", message: `Blocked: step ${j + 1} hasn't been sent yet, so step ${i + 1} can't go first.` });
          break;
        }
      }
      const prev = input.previousSteps ?? [];
      if (prev.length !== i) reasons.push({ code: "previous_steps_missing", message: `Blocked: results for the ${i} earlier step(s) are needed before step ${i + 1}.` });
      else {
        const gate = canRunNextStep(prev);
        if (!gate.ok) reasons.push({ code: "previous_step_failed", message: `Blocked: ${gate.reason}` });
      }
    }
  } else if (sequential && callsToSign(plan).length > 1 && input.previousSteps?.length) {
    reasons.push({ code: "send_index_invalid", message: "Blocked: say which step is being sent (sendIndex) when sending a sequential plan step by step." });
  }
  if (store.has(usageKey(approval.hash, i)) || store.has(approval.hash) || approval.used) {
    reasons.push({ code: "approval_reused", message: i === undefined
      ? "Blocked: this approval was already used. Each approval allows exactly one submission."
      : `Blocked: step ${i + 1} of this approval was already sent. Each step can be sent once.` });
  }
  if (Date.parse(approval.expiresAt) <= now.getTime()) {
    reasons.push({ code: "approval_expired", message: `Blocked: this approval expired at ${approval.expiresAt}. Approve again.` });
  }

  const recomputed = buildBinding({ ...input, fingerprint: input.preparedFingerprint }, approval.binding.expiresAt);
  if (digest("seam/approval/v1", approval.binding) !== approval.hash) {
    reasons.push({ code: "approval_tampered", message: "Blocked: the approval's contents don't match its hash." });
  }
  const changed = (Object.keys(recomputed) as (keyof ApprovalBinding)[]).filter((k) => recomputed[k] !== approval.binding[k]);
  if (changed.length) {
    reasons.push({
      code: "approval_mismatch",
      message: `Blocked: what's about to be sent differs from what was approved (${changed.join(", ")}). Review and approve again.`,
    });
  }

  const lock = checkRuntimeLock(input.preparedFingerprint, input.currentFingerprint);
  if (!lock.ok) reasons.push({ code: "runtime_changed", message: lock.reason });

  const expected = callsToSign(plan).map((c) => (c ?? "").toLowerCase());
  const signed = input.signedCalls.map((c) => c.toLowerCase());
  if (expected.length !== signed.length || expected.some((c, i) => c !== signed[i])) {
    reasons.push({ code: "signed_bytes_mismatch", message: "Blocked: the wallet signed different call data from the approved plan." });
  }

  const dry = input.signedDryRun ?? [];
  const relevant = i === undefined ? dry : [dry[i]];
  const needed = i === undefined ? signed.length : 1;
  if (relevant.includes("failed")) {
    reasons.push({ code: "signed_dry_run_failed", message: "Blocked: the dry run of the signed transaction failed, so it would fail on chain." });
  } else if (input.policy.requireSignedDryRun && (relevant.filter((d) => d !== undefined).length !== needed || relevant.some((d) => d !== "ok"))) {
    reasons.push({ code: "signed_dry_run_missing", message: i === undefined
      ? "Blocked: the policy needs a successful dry run of each signed transaction before sending, and one is missing or unknown. For sequential plans, check each step just before sending it (sendIndex)."
      : `Blocked: the policy needs a successful dry run of step ${i + 1} just before sending it, and it's missing or unknown.` });
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Sequential runs: a step may only start if every earlier step finalized (or was included) and wasn't found
 * to be wrong. After a failure SEAM stops, and later steps are reported as not run.
 */
export function canRunNextStep(previous: ReceiptStep[]): { ok: boolean; reason: string } {
  const bad = previous.find((s) => !(s.status === "finalized" || s.status === "included") || s.verification === "not_verified");
  if (!bad) return { ok: true, reason: "all earlier steps completed" };
  return { ok: false, reason: `Stopped: step ${bad.actionId} ${bad.status === "failed" ? "failed" : bad.verification === "not_verified" ? "did not verify" : `is ${bad.status}`}, so later steps were not run.` };
}

/** Overall receipt result: verified only when every step finalized and verified; partial if something didn't run. */
export function overallResult(steps: ReceiptStep[]): "verified" | "partial" | "not_verified" {
  if (steps.length > 0 && steps.every((s) => s.status === "finalized" && s.verification === "verified")) return "verified";
  if (steps.some((s) => s.status === "not_run")) return "partial";
  return "not_verified";
}
