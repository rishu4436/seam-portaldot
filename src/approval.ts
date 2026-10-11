import type {
  Approval, Fingerprint, Hex, Plan, PolicyResult, PreflightResult, ReceiptStep, SigningEnvelope,
} from "./types.js";
import { digest } from "./digest.js";
import { checkRuntimeLock } from "./runtimeLock.js";
import { type Policy, policyDigest } from "./policy.js";
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
  fingerprint: Fingerprint;
  now: Date;
}

const COVERS = ["manifest", "plan", "encoded calls", "runtime fingerprint", "policy", "policy result", "signing envelope", "preflight"];

export function callsDigest(plan: Plan): Hex {
  return digest("seam/calls/v1", plan.steps.map((s) => s.encodedCall ?? null));
}

function buildBinding(i: Omit<ApprovalInput, "now">, expiresAt: string): ApprovalBinding {
  return {
    manifestDigest: i.manifestDigest,
    planDigest: i.plan.digest,
    planContentDigest: digest("seam/plan-content/v1", i.plan),
    callsDigest: callsDigest(i.plan),
    fingerprintDigest: i.fingerprint.digest,
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
  if (policyResult.policyDigest !== policyDigest(policy)) return { ok: false, reason: "Can't approve: the policy result was made with a different policy." };
  if (plan.fingerprintDigest !== fingerprint.digest) return { ok: false, reason: "Can't approve: the plan was compiled for a different runtime." };
  if ((normalizeAccount(envelope.signer) ?? envelope.signer) !== (normalizeAccount(plan.signer) ?? plan.signer)) {
    return { ok: false, reason: "Can't approve: the signing envelope's signer is not the plan's signer." };
  }
  if (plan.steps.some((s) => !s.encodedCall)) return { ok: false, reason: "Can't approve: a step has no encoded call, so there is nothing exact to sign." };
  const envelopeExpiry = Date.parse(envelope.expiresAt);
  if (Number.isNaN(envelopeExpiry)) return { ok: false, reason: "Can't approve: the signing envelope has no valid expiry time." };
  if (envelopeExpiry <= now.getTime()) return { ok: false, reason: "Can't approve: the signing envelope has already expired." };
  const expiresAt = new Date(Math.min(envelopeExpiry, now.getTime() + policy.maxApprovalSeconds * 1000)).toISOString();

  const binding = buildBinding(input, expiresAt);
  const hash = digest("seam/approval/v1", binding);
  return { ok: true, approval: { hash, covers: COVERS, expiresAt, used: false, binding } };
}

/** Remembers approvals that were already submitted, so none can be replayed. */
export interface ApprovalStore { has(hash: Hex): boolean; markUsed(hash: Hex): void }
export class InMemoryApprovalStore implements ApprovalStore {
  private used = new Set<string>();
  has(hash: Hex) { return this.used.has(hash); }
  markUsed(hash: Hex) { this.used.add(hash); }
}

export interface SubmitCheckInput extends Omit<ApprovalInput, "now" | "fingerprint"> {
  approval: BoundApproval;
  /** Fingerprint the plan was prepared against. */
  preparedFingerprint: Fingerprint;
  /** Fingerprint read from the node right before submission. */
  currentFingerprint: Fingerprint;
  /** The encoded calls the wallet actually signed, in order. */
  signedCalls: Hex[];
  now: Date;
  store: ApprovalStore;
}

export interface SubmitCheck { ok: boolean; reasons: { code: string; message: string }[] }

/**
 * The last gate before broadcasting. Recomputes the binding from what is about to be sent and blocks on any
 * mismatch, an expired or reused approval, a runtime change, or signed bytes that differ from the approved calls.
 * Call store.markUsed(approval.hash) once the transaction is submitted.
 */
export function checkBeforeSubmit(input: SubmitCheckInput): SubmitCheck {
  const reasons: SubmitCheck["reasons"] = [];
  const { approval, now, store, plan } = input;

  if (store.has(approval.hash) || approval.used) {
    reasons.push({ code: "approval_reused", message: "Blocked: this approval was already used. Each approval allows exactly one submission." });
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

  const expected = plan.steps.map((s) => (s.encodedCall ?? "").toLowerCase());
  const signed = input.signedCalls.map((c) => c.toLowerCase());
  if (expected.length !== signed.length || expected.some((c, i) => c !== signed[i])) {
    reasons.push({ code: "signed_bytes_mismatch", message: "Blocked: the wallet signed different call data from the approved plan." });
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
