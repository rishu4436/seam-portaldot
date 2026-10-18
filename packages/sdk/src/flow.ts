import { compile, type CompileOptions, type Hex, type Manifest, type Plan, type RuntimeFacts, type RuntimeFingerprint } from '@seam/compiler';
import {
  callsToSign, checkBeforeSubmit, createApproval, evaluatePolicy, InMemoryApprovalStore,
  usageKey, canRunNextStep, isReservableStore, type ApprovalStore, type BoundApproval, type ReceiptStep, type Policy, type PolicyResult, type PreflightResult, type DecodedSignedExtrinsic, type SignedDryRun, type SigningEnvelope, type SubmitCheck,
} from '@seam/policy';
import { FileApprovalStore } from './fileStore.js';
import { buildReceipt, type ContractEffect, type Receipt, type StepOutcome } from './receipt.js';

/** What SEAM needs from the chain layer (Bot 4's @seam/chain implements this). */
export interface ChainAdapter {
  discover(): Promise<RuntimeFacts>;
  /** Fingerprint read fresh from the node, used right before submitting. */
  readFingerprint(): Promise<RuntimeFingerprint>;
  preflight(plan: Plan): Promise<{ preflight: PreflightResult; envelope: SigningEnvelope }>;
  /** system_dryRun of each signed transaction, in order, run after signing and before the submit gate. */
  dryRunSigned(signedTxs: Hex[]): Promise<SignedDryRun[]>;
  /** Broadcast one signed transaction and track it to finality, returning its events. */
  submit(signedTx: Hex, actionId: string): Promise<SubmitOutcome>;
  /**
   * SEAM-005 reconcile: where is this transaction? Used only after a send ended uncertain. Must never report
   * `not_found` with `definitive: true` unless the node was reachable and the transaction can no longer land.
   */
  lookupTx?(txHash: Hex): Promise<TxLookup>;
  /**
   * SEAM-001: decode every signed transaction and check it against the signing requests for `calls` (same envelope).
   * `signedCalls` must come from the transactions' own bytes. Fewer, extra, reordered or altered transactions: ok false.
   */
  verifySigned(signedTxs: Hex[], calls: Hex[], envelope: SigningEnvelope): { ok: boolean; signedCalls: Hex[]; reasons: string[] } | Promise<{ ok: boolean; signedCalls: Hex[]; reasons: string[] }>;
  /** The trusted decoder handed to checkBeforeSubmit, bound to the approved requests for `calls`. Returns null for anything it cannot fully decode. */
  signedDecoder(calls: Hex[], envelope: SigningEnvelope): (extrinsic: Hex) => DecodedSignedExtrinsic | null;
}

/**
 * What the adapter knows about delivery. 'not_sent': refused/failed before broadcast. 'rejected': the node refused it
 * outright (not in the pool). 'accepted': the node took it (hash acknowledged). 'uncertain': ambiguous (timeout, lost
 * connection, no acknowledgement). Missing means: 'not_sent' for failed/not_run without a hash, otherwise 'accepted'.
 */
export type SubmitDelivery = 'not_sent' | 'rejected' | 'accepted' | 'uncertain';
export type SubmitOutcome = StepOutcome & { delivery?: SubmitDelivery };

export type TxLookup =
  | { state: 'found_finalized' | 'found_included'; block: { number: number; hash: Hex } }
  | { state: 'not_found'; /** true only when the transaction can no longer land (e.g. its era has passed) */ definitive: boolean; detail?: string }
  | { state: 'unknown'; detail: string };

/** A send whose outcome is ambiguous. Local type: swap for Bot 5's receipt type if one lands. Never retry blindly: reconcile. */
export interface UncertainSend {
  actionId: string;
  index: number;
  sendIndex?: number;
  usageKey: string;
  idempotencyKey: string;
  txHash?: Hex;
  reason: string;
}

/** The user's wallet. SEAM never holds keys: it hands over exact call bytes and gets signed transactions back. */
export interface WalletSigner {
  /** Returns, for each call, the signed transaction plus the call bytes the wallet actually signed. */
  sign(calls: Hex[], envelope: SigningEnvelope): Promise<{ signedTx: Hex; signedCall: Hex }[]>;
}

export type RunResult =
  | { ok: true; receipt: Receipt; /** Set when a send's outcome is ambiguous: nothing more was sent; call `reconcile`. */ uncertain?: UncertainSend; /** Set when a sequential run stopped early; the receipt is then partial. */ stoppedReason?: string }
  | { ok: false; stage: 'policy' | 'approval' | 'submit_gate'; reason: string; policyResult?: PolicyResult; check?: SubmitCheck };

/** Progress event from `execute`. `check` is the submit-gate result for this step (present on sending, done and blocked). */
export interface StepEvent {
  index: number;
  actionId: string;
  phase: 'checking' | 'sending' | 'done' | 'blocked';
  detail?: string;
  check?: SubmitCheck;
}

export class Seam {
  /**
   * `defaults` are compile options used by `compile` and `prepare` unless the call passes its own. Put `abis` here
   * once so every Manifest that names an ABI with `abiRef` compiles.
   */
  /**
   * `store` may be an ApprovalStore or a file path: a path gives a durable FileApprovalStore, so a reserved or
   * uncertain send survives a restart and still blocks reuse until reconciled.
   */
  private store: ApprovalStore;
  constructor(private chain: ChainAdapter, store: ApprovalStore | string = new InMemoryApprovalStore(), private defaults: CompileOptions = {}) {
    this.store = typeof store === 'string' ? new FileApprovalStore(store) : store;
  }

  private opts(options?: CompileOptions): CompileOptions {
    return { ...this.defaults, ...options, ...(this.defaults.abis || options?.abis ? { abis: { ...this.defaults.abis, ...options?.abis } } : {}) };
  }

  discover() { return this.chain.discover(); }

  compile(manifest: Manifest, facts: RuntimeFacts, options?: CompileOptions) { return compile(manifest, facts, this.opts(options)); }

  async prepare(manifest: Manifest, facts: RuntimeFacts, policy: Policy, options?: CompileOptions) {
    const plan = compile(manifest, facts, this.opts(options));
    const { preflight, envelope } = await this.chain.preflight(plan);
    const policyResult = evaluatePolicy({ policy, plan, facts, preflight, manifest });
    return { plan, preflight, envelope, policyResult };
  }

  approve(p: { plan: Plan; preflight: PreflightResult; envelope: SigningEnvelope; policy: Policy; policyResult: PolicyResult; facts: RuntimeFacts; now?: Date }) {
    return createApproval({ manifestDigest: p.plan.manifestDigest, plan: p.plan, envelope: p.envelope, preflight: p.preflight, policy: p.policy,
      policyResult: p.policyResult, fingerprint: p.facts.fingerprint, now: p.now ?? new Date() });
  }

  /**
   * Signs, re-checks everything at the last moment, submits, and verifies.
   * Atomic plans: one gate check, one transaction. Sequential plans: before every step SEAM reads the runtime
   * fingerprint again, dry-runs that step's signed transaction, and runs the gate for that step (sendIndex), after
   * the previous step finalized and verified. It stops at the first step that fails, doesn't verify, or is blocked;
   * the receipt then says partial and `stoppedReason` says why.
   */
  async execute(p: { plan: Plan; preflight: PreflightResult; envelope: SigningEnvelope; policy: Policy; policyResult: PolicyResult;
    facts: RuntimeFacts; approval: BoundApproval; wallet: WalletSigner; now?: () => Date;
    /** What each contracts.call must have done (by actionId), committed before the run. Without one a contract step stays unproven. */
    effects?: Record<string, ContractEffect>;
    onStep?: (e: StepEvent) => void }): Promise<RunResult> {
    const now = p.now ?? (() => new Date());
    const calls = callsToSign(p.plan).filter((c): c is Hex => !!c);
    const signed = await p.wallet.sign(calls, p.envelope);
    // SEAM-001: the wallet's own `signedCall` is never used. Decode what was actually signed and bind it to the approved
    // calls before anything else (no dry run, no gate, no submit) happens.
    const blockedSigned = (reason: string): RunResult => {
      const check: SubmitCheck = { ok: false, reasons: [{ code: 'signed_binding_failed', message: reason }], passed: [] };
      p.onStep?.({ index: 0, actionId: 'sign', phase: 'blocked', detail: reason, check });
      return { ok: false, stage: 'submit_gate', reason, check };
    };
    if (typeof this.chain.verifySigned !== 'function' || typeof this.chain.signedDecoder !== 'function') {
      return blockedSigned('Blocked: the chain adapter cannot verify or decode signed transactions, so SEAM will not send what the wallet signed.');
    }
    const signedExtrinsics = signed.map((s) => s.signedTx);
    let verified;
    try { verified = await this.chain.verifySigned(signedExtrinsics, calls, p.envelope); } catch (e) { return blockedSigned(`Blocked: the signed transactions could not be verified (${(e as Error).message}).`); }
    if (!verified.ok) return blockedSigned(`Blocked: the signed transactions are not exactly what was approved (${verified.reasons.join(', ')}).`);
    const signedCalls = verified.signedCalls; // decoded from the transactions' bytes
    const decodeSignedExtrinsic = this.chain.signedDecoder(calls, p.envelope);
    const atomic = p.plan.mode === 'atomic_verified' || p.plan.mode === 'atomic_unverified';
    const ids = atomic ? ['batch'] : p.plan.steps.map((s) => s.actionId);
    const gate = async (sendIndex: number | undefined, signedDryRun: SignedDryRun[], previousSteps?: ReceiptStep[]) => checkBeforeSubmit({
      manifestDigest: p.plan.manifestDigest, plan: p.plan, envelope: p.envelope, preflight: p.preflight, policy: p.policy,
      policyResult: p.policyResult, approval: p.approval, preparedFingerprint: p.facts.fingerprint,
      currentFingerprint: await this.chain.readFingerprint(), signedCalls, signedExtrinsics, decodeSignedExtrinsic, requireTrustedDecoder: true, signedDryRun, sendIndex, previousSteps, now: now(), store: this.store,
    });
    const finish = (outcomes: StepOutcome[], stoppedReason?: string, uncertain?: UncertainSend): RunResult => ({
      ok: true, stoppedReason, ...(uncertain ? { uncertain } : {}),
      receipt: buildReceipt({ plan: p.plan, outcomes, policyDigest: p.policyResult.policyDigest, approvalHash: p.approval.hash, stoppedReason, ...(p.effects ? { effects: p.effects } : {}) }),
    });

    // SEAM-005: reserve before broadcasting, commit on acknowledgement, release on definite rejection, uncertain otherwise.
    type Sent = { blocked: string } | { outcome: StepOutcome; uncertain?: UncertainSend };
    const send = async (index: number, sendIndex: number | undefined, id: string, check: SubmitCheck): Promise<Sent> => {
      const key = usageKey(p.approval.hash, sendIndex);
      const idempotencyKey = `${p.approval.hash}:${sendIndex ?? 'all'}`;
      const reservable = isReservableStore(this.store) ? this.store : undefined;
      if (reservable) {
        const r = reservable.reserve(key, { idempotencyKey, now: now() });
        if (!r.ok) return { blocked: `Blocked: this send is already ${r.reason}; SEAM will not send it again.` };
      } else {
        this.store.markUsed(key); // legacy store: burn before broadcasting (cannot release or reconcile)
      }
      p.onStep?.({ index, actionId: id, phase: 'sending', check });
      const uncertainSend = (reason: string, txHash?: Hex): Sent => {
        reservable?.markUncertain(key, { ...(txHash ? { txHash } : {}), note: reason });
        const outcome: StepOutcome = { actionId: id, status: 'uncertain', events: [], ...(txHash ? { txHash } : {}) };
        return { outcome, uncertain: { actionId: id, index, ...(sendIndex !== undefined ? { sendIndex } : {}), usageKey: key, idempotencyKey, ...(txHash ? { txHash } : {}), reason } };
      };
      let o: SubmitOutcome;
      try { o = await this.chain.submit(signed[index]!.signedTx, id); } catch (e) {
        return uncertainSend(`submit threw after the send may have started (${(e as Error).message}); the transaction may or may not be on chain`);
      }
      const delivery: SubmitDelivery = o.delivery ?? ((o.status === 'failed' || o.status === 'not_run') && !o.txHash ? 'not_sent' : 'accepted');
      if (delivery === 'not_sent' || delivery === 'rejected') { reservable?.release(key); return { outcome: o }; }
      if (delivery === 'uncertain') return uncertainSend(o.error ?? 'the node gave no definite answer (timeout or lost connection)', o.txHash);
      if (!o.txHash) return uncertainSend('the node did not acknowledge a transaction hash', undefined);
      reservable?.commit(key, { txHash: o.txHash });
      return { outcome: o };
    };

    if (atomic || signed.length === 1) {
      const sendIndex = atomic ? undefined : 0;
      p.onStep?.({ index: 0, actionId: ids[0]!, phase: 'checking' });
      const check = await gate(sendIndex, await this.chain.dryRunSigned(signed.map((s) => s.signedTx)), atomic ? undefined : []);
      if (!check.ok) return { ok: false, stage: 'submit_gate', reason: check.reasons.map((r) => r.message).join(' '), check };
      const sent = await send(0, sendIndex, ids[0]!, check);
      if ('blocked' in sent) return { ok: false, stage: 'submit_gate', reason: sent.blocked, check: { ok: false, reasons: [{ code: 'approval_reserved', message: sent.blocked }], passed: [] } };
      p.onStep?.({ index: 0, actionId: ids[0]!, phase: 'done', detail: sent.uncertain ? 'uncertain' : sent.outcome.status, check });
      return finish([sent.outcome], sent.uncertain?.reason, sent.uncertain);
    }

    const outcomes: StepOutcome[] = [];
    for (let i = 0; i < signed.length; i++) {
      const id = ids[i]!;
      p.onStep?.({ index: i, actionId: id, phase: 'checking' });
      // Only this step can dry-run now: later steps carry nonces the chain won't accept until this one lands.
      const [mine] = await this.chain.dryRunSigned([signed[i]!.signedTx]);
      const dry: SignedDryRun[] = signed.map((_, j) => (j === i ? (mine ?? 'unknown') : 'unknown'));
      const previousSteps = buildReceipt({ plan: p.plan, outcomes, ...(p.effects ? { effects: p.effects } : {}) }).steps.slice(0, i);
      const check = await gate(i, dry, previousSteps);
      if (!check.ok) {
        const reason = check.reasons.map((r) => r.message).join(' ');
        p.onStep?.({ index: i, actionId: id, phase: 'blocked', detail: reason, check });
        if (i === 0) return { ok: false, stage: 'submit_gate', reason, check };
        return finish(outcomes, `SEAM stopped before sending it: ${reason}`);
      }
      const sent = await send(i, i, id, check);
      if ('blocked' in sent) {
        p.onStep?.({ index: i, actionId: id, phase: 'blocked', detail: sent.blocked, check });
        if (i === 0) return { ok: false, stage: 'submit_gate', reason: sent.blocked, check: { ok: false, reasons: [{ code: 'approval_reserved', message: sent.blocked }], passed: [] } };
        return finish(outcomes, `SEAM stopped before sending it: ${sent.blocked}`);
      }
      outcomes.push(sent.outcome);
      p.onStep?.({ index: i, actionId: id, phase: 'done', detail: sent.uncertain ? 'uncertain' : sent.outcome.status, check });
      if (sent.uncertain) return finish(outcomes, `SEAM stopped: step ${i + 1} (${id}) has an uncertain outcome and must be reconciled before anything else is sent. ${sent.uncertain.reason}`, sent.uncertain);
      // SEAM-002: a dependent step may only start after every earlier step is finalized AND verified (policy's canRunNextStep).
      const steps = buildReceipt({ plan: p.plan, outcomes, ...(p.effects ? { effects: p.effects } : {}) }).steps.slice(0, i + 1);
      const next = canRunNextStep(steps);
      if (!next.ok) {
        return i + 1 < signed.length ? finish(outcomes, `SEAM stopped before step ${i + 2}: ${next.reason}`) : finish(outcomes);
      }
    }
    return finish(outcomes);
  }

  /**
   * SEAM-005: resolve an uncertain send. Looks the transaction up (never resends). found_*: the reservation is
   * committed. A definitive not_found (transaction can no longer land): the reservation is released so a fresh,
   * newly signed run may happen. Anything else (unknown, RPC unreachable, a plain not_found, a lookup that throws)
   * leaves it uncertain: absence is never claimed without proof.
   */
  async reconcile(p: { uncertain: UncertainSend; txHash?: Hex }): Promise<{ state: 'committed' | 'released' | 'still_uncertain'; lookup?: TxLookup; detail?: string }> {
    const store = this.store;
    if (!isReservableStore(store)) return { state: 'still_uncertain', detail: 'the approval store cannot reconcile' };
    if (typeof this.chain.lookupTx !== 'function') return { state: 'still_uncertain', detail: 'the chain adapter cannot look up transactions' };
    const txHash = p.txHash ?? p.uncertain.txHash;
    if (!txHash) return { state: 'still_uncertain', detail: 'no transaction hash to look up' };
    let lookup: TxLookup;
    try { lookup = await this.chain.lookupTx(txHash); } catch (e) { return { state: 'still_uncertain', detail: `lookup failed: ${(e as Error).message}` }; }
    if (lookup.state === 'found_finalized' || lookup.state === 'found_included') {
      store.reconcile(p.uncertain.usageKey, { outcome: 'broadcast', txHash });
      return { state: 'committed', lookup };
    }
    if (lookup.state === 'not_found' && lookup.definitive) {
      store.reconcile(p.uncertain.usageKey, { outcome: 'not_broadcast' });
      return { state: 'released', lookup };
    }
    return { state: 'still_uncertain', lookup };
  }
}
