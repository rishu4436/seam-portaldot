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
 *
 * The original interface (has / markUsed) is kept so existing callers keep working. markUsed is "reserve and commit
 * in one go, before broadcasting": safe against duplicates, but an RPC failure after it burns the approval.
 * Prefer ReservableApprovalStore (reserve -> broadcast -> commit | release | markUncertain).
 */
export interface ApprovalStore { has(key: string): boolean; markUsed(key: string): void }

export type ReservationState = "reserved" | "committed" | "uncertain";
export interface ReservationRecord {
  key: string;
  state: ReservationState;
  /** Caller-chosen id for this send attempt; persist it so a retry after a crash can be matched to the attempt. */
  idempotencyKey: string;
  txHash?: Hex;
  note?: string;
  at: string;
}
export type ReserveResult =
  | { ok: true; record: ReservationRecord }
  | { ok: false; reason: ReservationState; record: ReservationRecord; txHash?: Hex };

/**
 * Atomic reserve / commit / release / uncertain lifecycle for one send (one usageKey).
 *
 *   reserve(key)            -> before signing/broadcasting. Fails if the key is reserved, committed or uncertain.
 *   commit(key, {txHash})   -> the node accepted the transaction (acknowledged hash).
 *   release(key)            -> it was definitely NOT broadcast (e.g. validation failed locally); key becomes reservable again.
 *   markUncertain(key, ..)  -> broadcast outcome ambiguous (timeout, crash after send). Blocks reuse AND release until
 *                              reconcile() records what really happened. Never blindly retry: first look the tx hash/nonce up.
 *   reconcile(key, outcome) -> uncertain -> committed (outcome "broadcast", with txHash) or removed (outcome "not_broadcast").
 *
 * InMemoryApprovalStore gives at-most-once semantics inside ONE process. It forgets everything on restart, so a
 * restarted process can send the same approval again; hosted / multi-user deployments must implement this
 * interface on durable storage with an atomic compare-and-set in reserve() and persist idempotencyKey + txHash.
 */
export interface ReservableApprovalStore extends ApprovalStore {
  reserve(key: string, opts: { idempotencyKey: string; now?: Date }): ReserveResult;
  commit(key: string, opts: { txHash: Hex }): void;
  release(key: string): void;
  markUncertain(key: string, opts: { txHash?: Hex; note?: string }): void;
  reconcile(key: string, opts: { outcome: "broadcast"; txHash: Hex } | { outcome: "not_broadcast" }): void;
  stateOf(key: string): ReservationRecord | undefined;
}

export function isReservableStore(s: ApprovalStore): s is ReservableApprovalStore {
  return typeof (s as ReservableApprovalStore).reserve === "function" && typeof (s as ReservableApprovalStore).stateOf === "function";
}

export class InMemoryApprovalStore implements ReservableApprovalStore {
  private records = new Map<string, ReservationRecord>();
  /** Reserved, committed and uncertain keys all count as "not available" (conservative: never a second send). */
  has(key: string) { return this.records.has(key); }
  /** Legacy: reserve + commit in one step. Final. */
  markUsed(key: string) {
    const prev = this.records.get(key);
    this.records.set(key, { key, state: "committed", idempotencyKey: prev?.idempotencyKey ?? key, txHash: prev?.txHash, at: new Date().toISOString() });
  }
  stateOf(key: string) { const r = this.records.get(key); return r ? { ...r } : undefined; }
  reserve(key: string, opts: { idempotencyKey: string; now?: Date }): ReserveResult {
    const existing = this.records.get(key);
    if (existing) return { ok: false, reason: existing.state, record: { ...existing }, txHash: existing.txHash };
    const record: ReservationRecord = { key, state: "reserved", idempotencyKey: opts.idempotencyKey, at: (opts.now ?? new Date()).toISOString() };
    this.records.set(key, record);
    return { ok: true, record: { ...record } };
  }
  private need(key: string, op: string, allowed: ReservationState[]): ReservationRecord {
    const r = this.records.get(key);
    if (!r) throw new Error(`${op}: ${key} has no reservation`);
    if (!allowed.includes(r.state)) throw new Error(`${op}: ${key} is ${r.state}${r.state === "uncertain" ? " and must be reconciled first" : ""}`);
    return r;
  }
  commit(key: string, opts: { txHash: Hex }) { const r = this.need(key, "commit", ["reserved", "uncertain"]); r.state = "committed"; r.txHash = opts.txHash; }
  release(key: string) { this.need(key, "release", ["reserved"]); this.records.delete(key); }
  markUncertain(key: string, opts: { txHash?: Hex; note?: string }) {
    const r = this.need(key, "markUncertain", ["reserved", "uncertain"]);
    r.state = "uncertain"; r.txHash = opts.txHash ?? r.txHash; r.note = opts.note ?? r.note;
  }
  reconcile(key: string, opts: { outcome: "broadcast"; txHash: Hex } | { outcome: "not_broadcast" }) {
    const r = this.need(key, "reconcile", ["uncertain"]);
    if (opts.outcome === "broadcast") { r.state = "committed"; r.txHash = opts.txHash; }
    else this.records.delete(key);
  }
}

/** The key to mark used after a submission: pass the same sendIndex you gave checkBeforeSubmit. */
export function usageKey(approvalHash: Hex, sendIndex?: number): string {
  return sendIndex === undefined ? approvalHash : `${approvalHash}#${sendIndex}`;
}

/** What a trusted decoder reports about one signed extrinsic. Optional fields are only checked when present. */
export interface DecodedSignedExtrinsic {
  /** SCALE-encoded call inside the extrinsic (pallet index, call index, args), as 0x hex. */
  call: Hex;
  signer: string;
  nonce?: number;
  tip?: string;
  /** Genesis hash the signature commits to, if the decoder can recover it. */
  genesisHash?: Hex;
  /** True only if the signature verifies for the signer over this payload. */
  signatureValid: boolean;
}

export interface SubmitCheckInput extends Omit<ApprovalInput, "now" | "fingerprint"> {
  approval: BoundApproval;
  /** Fingerprint the plan was prepared against. */
  preparedFingerprint: RuntimeFingerprint;
  /** Fingerprint read from the node right before submission. */
  currentFingerprint: RuntimeFingerprint;
  /**
   * The encoded calls the wallet REPORTED it signed, in order. Wallet-controlled: only used when no trusted decoder
   * is given. Prefer signedExtrinsics + decodeSignedExtrinsic (SEAM-001).
   */
  signedCalls: Hex[];
  /** The raw signed extrinsic bytes, in order, exactly as they will be submitted. */
  signedExtrinsics?: Hex[];
  /**
   * A trusted decoder (e.g. @seam/chain's signed-extrinsic parser) that returns the call actually inside the bytes,
   * its signer, nonce and whether the signature verifies. When given together with signedExtrinsics, signedCalls is
   * IGNORED and the decoded calls are what get compared with the approved plan. Must return null (or throw) for
   * anything it can't fully decode; the gate then fails closed.
   */
  decodeSignedExtrinsic?: (extrinsic: Hex) => DecodedSignedExtrinsic | null;
  /** Block (fail closed) unless signedExtrinsics + decodeSignedExtrinsic are provided. Hosted deployments should set this. */
  requireTrustedDecoder?: boolean;
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

export interface SubmitCheck {
  ok: boolean;
  /** Why it was blocked. Empty when ok. */
  reasons: { code: string; message: string }[];
  /** Checks that passed, in the order they ran, so recordings can show what was verified. Stable codes. */
  passed: { code: string; detail: string }[];
}

/**
 * The last gate before broadcasting. Recomputes the binding from what is about to be sent and blocks on any
 * mismatch, an expired or reused approval, a runtime change, or signed bytes that differ from the approved calls.
 * Call store.markUsed(usageKey(approval.hash, sendIndex)) once the transaction is submitted.
 */
export function checkBeforeSubmit(input: SubmitCheckInput): SubmitCheck {
  const reasons: SubmitCheck["reasons"] = [];
  const passed: SubmitCheck["passed"] = [];
  const ok = (code: string, detail: string) => passed.push({ code, detail });
  const { approval, now, store, plan } = input;

  const i = input.sendIndex;
  const sequential = plan.mode === "sequential";
  if (i !== undefined) {
    const n = callsToSign(plan).length;
    if (!sequential) reasons.push({ code: "send_index_invalid", message: "Blocked: only sequential plans are sent one step at a time; an atomic plan is one transaction." });
    else if (!Number.isInteger(i) || i < 0 || i >= n) reasons.push({ code: "send_index_invalid", message: `Blocked: step ${i} doesn't exist in this ${n}-step plan.` });
    else {
      for (let j = 0; j < i; j++) {
        const rec = isReservableStore(store) ? store.stateOf(usageKey(approval.hash, j)) : undefined;
        const sent = isReservableStore(store) ? rec?.state === "committed" : store.has(usageKey(approval.hash, j));
        if (!sent) {
          reasons.push({ code: "out_of_order", message: `Blocked: step ${j + 1} hasn't been sent yet, so step ${i + 1} can't go first.` });
          break;
        }
      }
      if (!reasons.some((x) => x.code === "out_of_order")) ok("step_order", `step ${i + 1} is next in order`);
      const prev = input.previousSteps ?? [];
      if (prev.length !== i) reasons.push({ code: "previous_steps_missing", message: `Blocked: results for the ${i} earlier step(s) are needed before step ${i + 1}.` });
      else {
        const gate = canRunNextStep(prev);
        if (!gate.ok) {
          reasons.push({ code: "previous_step_failed", message: `Blocked: ${gate.reason}` });
          if (gate.code) reasons.push({ code: gate.code, message: `Blocked: ${gate.reason}` });
        }
        else if (i > 0) ok("previous_steps_ok", `the ${i} earlier step(s) finalized and verified`);
      }
    }
  } else if (sequential && callsToSign(plan).length > 1 && input.previousSteps?.length) {
    reasons.push({ code: "send_index_invalid", message: "Blocked: say which step is being sent (sendIndex) when sending a sequential plan step by step." });
  }
  const keys = [usageKey(approval.hash, i), approval.hash];
  const recs = isReservableStore(store) ? keys.map((k) => store.stateOf(k)).filter((r): r is ReservationRecord => !!r) : [];
  const uncertain = recs.find((r) => r.state === "uncertain");
  const reserved = recs.find((r) => r.state === "reserved");
  if (uncertain) {
    reasons.push({ code: "approval_uncertain", message: "Blocked: an earlier send of this approval has an unknown outcome (it may have been broadcast). Look up its transaction hash / nonce and reconcile before doing anything else." });
  } else if (reserved) {
    reasons.push({ code: "approval_reserved", message: "Blocked: another send of this approval is already in progress." });
  } else if (keys.some((k) => store.has(k)) || approval.used) {
    reasons.push({ code: "approval_reused", message: i === undefined
      ? "Blocked: this approval was already used. Each approval allows exactly one submission."
      : `Blocked: step ${i + 1} of this approval was already sent. Each step can be sent once.` });
  } else ok("approval_unused", i === undefined ? "this approval hasn't been used" : `step ${i + 1} of this approval hasn't been sent`);
  // The hash covers binding.expiresAt, not the top-level copy, so the bound value is the one that counts.
  const boundExpiry = Date.parse(approval.binding.expiresAt);
  if (approval.expiresAt !== approval.binding.expiresAt) {
    reasons.push({ code: "approval_tampered", message: "Blocked: the approval's expiry was changed after it was approved." });
  } else if (Number.isNaN(boundExpiry)) {
    reasons.push({ code: "approval_expired", message: "Blocked: this approval has no valid expiry time. Approve again." });
  } else if (boundExpiry <= now.getTime()) {
    reasons.push({ code: "approval_expired", message: `Blocked: this approval expired at ${approval.binding.expiresAt}. Approve again.` });
  } else ok("approval_valid_time", `the approval is valid until ${approval.binding.expiresAt}`);

  const recomputed = buildBinding({ ...input, fingerprint: input.preparedFingerprint }, approval.binding.expiresAt);
  if (digest("seam/approval/v1", approval.binding) !== approval.hash) {
    reasons.push({ code: "approval_tampered", message: "Blocked: the approval's contents don't match its hash." });
  } else ok("approval_intact", "the approval's contents match its hash");
  const changed = (Object.keys(recomputed) as (keyof ApprovalBinding)[]).filter((k) => recomputed[k] !== approval.binding[k]);
  if (changed.length) {
    reasons.push({
      code: "approval_mismatch",
      message: `Blocked: what's about to be sent differs from what was approved (${changed.join(", ")}). Review and approve again.`,
    });
  } else ok("approval_matches", "what is about to be sent is exactly what was approved (plan, policy, runtime, envelope, preflight)");

  const lock = checkRuntimeLock(input.preparedFingerprint, input.currentFingerprint);
  if (!lock.ok) reasons.push({ code: "runtime_changed", message: lock.reason });
  else ok("runtime_unchanged", "the runtime is the one the plan was prepared for");

  const expected = callsToSign(plan).map((c) => (c ?? "").toLowerCase());
  let signed = input.signedCalls.map((c) => c.toLowerCase());
  let trusted = false;
  if (input.decodeSignedExtrinsic && input.signedExtrinsics) {
    const decoded: (DecodedSignedExtrinsic | null)[] = input.signedExtrinsics.map((x) => {
      try { return input.decodeSignedExtrinsic!(x); } catch { return null; }
    });
    if (decoded.some((d) => !d)) {
      reasons.push({ code: "signed_extrinsic_undecodable", message: "Blocked: a signed transaction couldn't be fully decoded, so what it does can't be checked." });
      signed = [];
    } else {
      trusted = true;
      const ds = decoded as DecodedSignedExtrinsic[];
      signed = ds.map((d) => d.call.toLowerCase());
      const wantSigner = normalizeAccount(input.envelope.signer) ?? input.envelope.signer.toLowerCase();
      ds.forEach((d, n) => {
        if ((normalizeAccount(d.signer) ?? d.signer.toLowerCase()) !== wantSigner) reasons.push({ code: "signed_signer_mismatch", message: `Blocked: signed transaction ${n + 1} was signed by a different account from the approved signer.` });
        if (!d.signatureValid) reasons.push({ code: "signed_signature_invalid", message: `Blocked: the signature on signed transaction ${n + 1} is not valid.` });
        if (d.nonce !== undefined && d.nonce !== input.envelope.nonce + n) reasons.push({ code: "signed_nonce_mismatch", message: `Blocked: signed transaction ${n + 1} uses nonce ${d.nonce}, not the approved ${input.envelope.nonce + n}.` });
        if (d.genesisHash !== undefined && d.genesisHash.toLowerCase() !== input.preparedFingerprint.genesisHash.toLowerCase()) reasons.push({ code: "signed_chain_mismatch", message: `Blocked: signed transaction ${n + 1} was signed for a different chain.` });
      });
    }
  }
  if (input.requireTrustedDecoder && !trusted && !reasons.some((r) => r.code === "signed_extrinsic_undecodable")) {
    reasons.push({ code: "trusted_decoder_required", message: "Blocked: this deployment only accepts signed transactions that SEAM decodes itself from the raw bytes, and no decoder/bytes were given. Wallet-reported call data is not trusted." });
  }
  if (expected.length !== signed.length || expected.some((c, n) => c !== signed[n])) {
    if (!reasons.some((r) => r.code === "signed_extrinsic_undecodable")) reasons.push({ code: "signed_bytes_mismatch", message: trusted ? "Blocked: the signed transactions contain different call data from the approved plan." : "Blocked: the wallet signed different call data from the approved plan." });
  } else ok("signed_bytes_match", trusted
    ? `the ${signed.length} call(s) decoded from the signed transaction bytes are exactly the approved calls`
    : `the ${signed.length} signed call(s) are byte-for-byte the approved calls (as reported by the wallet; not independently decoded)`);

  const dry = input.signedDryRun ?? [];
  const relevant = i === undefined ? dry : [dry[i]];
  const needed = i === undefined ? signed.length : 1;
  if (relevant.includes("failed")) {
    reasons.push({ code: "signed_dry_run_failed", message: "Blocked: the dry run of the signed transaction failed, so it would fail on chain." });
  } else if (input.policy.requireSignedDryRun && (relevant.filter((d) => d !== undefined).length !== needed || relevant.some((d) => d !== "ok"))) {
    reasons.push({ code: "signed_dry_run_missing", message: i === undefined
      ? "Blocked: the policy needs a successful dry run of each signed transaction before sending, and one is missing or unknown. For sequential plans, check each step just before sending it (sendIndex)."
      : `Blocked: the policy needs a successful dry run of step ${i + 1} just before sending it, and it's missing or unknown.` });
  } else if (!input.policy.requireSignedDryRun && relevant.filter((d) => d !== undefined).length === 0) {
    ok("signed_dry_run_not_checked", "no dry run of the signed transaction was done; only pre-sign estimates back this send (weaker proof)");
  } else if (relevant.length > 0 && relevant.filter((d) => d !== undefined).length === needed && relevant.every((d) => d === "ok")) {
    ok("signed_dry_run_ok", i === undefined ? "the dry run of the signed transaction(s) succeeded" : `the dry run of signed step ${i + 1} succeeded`);
  }

  return { ok: reasons.length === 0, reasons, passed };
}

export type NextStepCode =
  | "step_failed" | "step_not_finalized" | "verification_failed" | "verification_unknown"
  | "receipt_data_missing" | "contract_outcome_failed";

const FAILURE_EVENTS = ["System.ExtrinsicFailed", "Contracts.ContractTrapped", "Revive.ContractReverted", "Contracts.ContractReverted"];

/**
 * Sequential runs: a dependent step may only start if EVERY earlier step is finalized AND verified, has a tx hash and
 * block, and shows no failure event. Anything else blocks: included (not final), submitted, unknown verification
 * (e.g. an unsupported verifier), not_verified, failed, missing receipt data. SEAM stops there and later steps are
 * reported as not_run (see markNotRun). There is deliberately no relaxed mode; if one is ever added it must be a
 * separate, visibly weaker policy and must never be called "verified".
 */
export function canRunNextStep(previous: ReceiptStep[]): { ok: boolean; reason: string; code?: NextStepCode } {
  for (const s of previous) {
    const stop = (code: NextStepCode, why: string) => ({ ok: false as const, code, reason: `Stopped: step ${s.actionId} ${why}, so later steps were not run.` });
    if (s.status === "failed") return stop("step_failed", "failed");
    if (s.status !== "finalized") return stop("step_not_finalized", `is ${s.status}, not finalized yet`);
    if (s.verification === "not_verified") return stop("verification_failed", "did not verify");
    if (s.verification !== "verified") return stop("verification_unknown", "finalized but its effect could not be verified");
    if (!s.txHash || !s.block) return stop("receipt_data_missing", "has no transaction hash or block in its receipt");
    const failed = (s.events ?? []).find((e) => FAILURE_EVENTS.includes(e));
    if (failed) return stop("contract_outcome_failed", `reported ${failed}`);
  }
  return { ok: true, reason: "all earlier steps finalized and verified" };
}

/** Appends a not_run step (with the stop reason) for every planned action that has no receipt step yet. */
export function markNotRun(done: ReceiptStep[], plannedActionIds: string[], reason: string): ReceiptStep[] {
  const have = new Set(done.map((s) => s.actionId));
  return [...done, ...plannedActionIds.filter((id) => !have.has(id)).map((actionId): ReceiptStep => ({ actionId, status: "not_run", events: [], verification: "unknown", reason }))];
}

/** Overall receipt result: verified only when every step finalized and verified; partial if something didn't run. */
export function overallResult(steps: ReceiptStep[]): "verified" | "partial" | "not_verified" {
  if (steps.length > 0 && steps.every((s) => s.status === "finalized" && s.verification === "verified")) return "verified";
  if (steps.some((s) => s.status === "not_run")) return "partial";
  return "not_verified";
}
