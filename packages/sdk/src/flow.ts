import { compile, type CompileOptions, type Hex, type Manifest, type Plan, type RuntimeFacts, type RuntimeFingerprint } from '@seam/compiler';
import {
  callsToSign, checkBeforeSubmit, createApproval, evaluatePolicy, InMemoryApprovalStore,
  usageKey, type ApprovalStore, type BoundApproval, type ReceiptStep, type Policy, type PolicyResult, type PreflightResult, type DecodedSignedExtrinsic, type SignedDryRun, type SigningEnvelope, type SubmitCheck,
} from '@seam/policy';
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
  submit(signedTx: Hex, actionId: string): Promise<StepOutcome>;
  /**
   * SEAM-001: decode every signed transaction and check it against the signing requests for `calls` (same envelope).
   * `signedCalls` must come from the transactions' own bytes. Fewer, extra, reordered or altered transactions: ok false.
   */
  verifySigned(signedTxs: Hex[], calls: Hex[], envelope: SigningEnvelope): { ok: boolean; signedCalls: Hex[]; reasons: string[] } | Promise<{ ok: boolean; signedCalls: Hex[]; reasons: string[] }>;
  /** The trusted decoder handed to checkBeforeSubmit, bound to the approved requests for `calls`. Returns null for anything it cannot fully decode. */
  signedDecoder(calls: Hex[], envelope: SigningEnvelope): (extrinsic: Hex) => DecodedSignedExtrinsic | null;
}

/** The user's wallet. SEAM never holds keys: it hands over exact call bytes and gets signed transactions back. */
export interface WalletSigner {
  /** Returns, for each call, the signed transaction plus the call bytes the wallet actually signed. */
  sign(calls: Hex[], envelope: SigningEnvelope): Promise<{ signedTx: Hex; signedCall: Hex }[]>;
}

export type RunResult =
  | { ok: true; receipt: Receipt; /** Set when a sequential run stopped early; the receipt is then partial. */ stoppedReason?: string }
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
  constructor(private chain: ChainAdapter, private store: ApprovalStore = new InMemoryApprovalStore(), private defaults: CompileOptions = {}) {}

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
    const finish = (outcomes: StepOutcome[], stoppedReason?: string): RunResult => ({
      ok: true, stoppedReason,
      receipt: buildReceipt({ plan: p.plan, outcomes, policyDigest: p.policyResult.policyDigest, approvalHash: p.approval.hash, stoppedReason, ...(p.effects ? { effects: p.effects } : {}) }),
    });

    if (atomic || signed.length === 1) {
      const sendIndex = atomic ? undefined : 0;
      p.onStep?.({ index: 0, actionId: ids[0]!, phase: 'checking' });
      const check = await gate(sendIndex, await this.chain.dryRunSigned(signed.map((s) => s.signedTx)), atomic ? undefined : []);
      if (!check.ok) return { ok: false, stage: 'submit_gate', reason: check.reasons.map((r) => r.message).join(' '), check };
      this.store.markUsed(usageKey(p.approval.hash, sendIndex));
      p.onStep?.({ index: 0, actionId: ids[0]!, phase: 'sending', check });
      const o = await this.chain.submit(signed[0]!.signedTx, ids[0]!);
      p.onStep?.({ index: 0, actionId: ids[0]!, phase: 'done', detail: o.status, check });
      return finish([o]);
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
      this.store.markUsed(usageKey(p.approval.hash, i));
      p.onStep?.({ index: i, actionId: id, phase: 'sending', check });
      const o = await this.chain.submit(signed[i]!.signedTx, id);
      outcomes.push(o);
      p.onStep?.({ index: i, actionId: id, phase: 'done', detail: o.status, check });
      const step = buildReceipt({ plan: p.plan, outcomes, ...(p.effects ? { effects: p.effects } : {}) }).steps[i]!;
      if (o.status !== 'finalized' || step.verification === 'not_verified') {
        return i + 1 < signed.length ? finish(outcomes, `SEAM stopped because step ${i + 1} (${id}) did not complete and verify: ${step.reason}`) : finish(outcomes);
      }
    }
    return finish(outcomes);
  }
}
