import { compile, type CompileOptions, type Hex, type Manifest, type Plan, type RuntimeFacts, type RuntimeFingerprint } from '@seam/compiler';
import {
  callsToSign, checkBeforeSubmit, createApproval, evaluatePolicy, InMemoryApprovalStore,
  type ApprovalStore, type BoundApproval, type Policy, type PolicyResult, type PreflightResult, type SignedDryRun, type SigningEnvelope, type SubmitCheck,
} from '@seam/policy';
import { buildReceipt, type Receipt, type StepOutcome } from './receipt.js';

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
}

/** The user's wallet. SEAM never holds keys: it hands over exact call bytes and gets signed transactions back. */
export interface WalletSigner {
  /** Returns, for each call, the signed transaction plus the call bytes the wallet actually signed. */
  sign(calls: Hex[], envelope: SigningEnvelope): Promise<{ signedTx: Hex; signedCall: Hex }[]>;
}

export type RunResult =
  | { ok: true; receipt: Receipt }
  | { ok: false; stage: 'policy' | 'approval' | 'submit_gate'; reason: string; policyResult?: PolicyResult; check?: SubmitCheck };

export class Seam {
  constructor(private chain: ChainAdapter, private store: ApprovalStore = new InMemoryApprovalStore()) {}

  discover() { return this.chain.discover(); }

  compile(manifest: Manifest, facts: RuntimeFacts, options?: CompileOptions) { return compile(manifest, facts, options); }

  async prepare(manifest: Manifest, facts: RuntimeFacts, policy: Policy) {
    const plan = compile(manifest, facts);
    const { preflight, envelope } = await this.chain.preflight(plan);
    const policyResult = evaluatePolicy({ policy, plan, facts, preflight, manifest });
    return { plan, preflight, envelope, policyResult };
  }

  approve(p: { plan: Plan; preflight: PreflightResult; envelope: SigningEnvelope; policy: Policy; policyResult: PolicyResult; facts: RuntimeFacts; now?: Date }) {
    return createApproval({ manifestDigest: p.plan.manifestDigest, plan: p.plan, envelope: p.envelope, preflight: p.preflight, policy: p.policy,
      policyResult: p.policyResult, fingerprint: p.facts.fingerprint, now: p.now ?? new Date() });
  }

  /**
   * Signs, re-checks everything at the last moment, submits, and verifies. Sequential plans stop at the first
   * step that fails or doesn't verify; the receipt then says partial.
   */
  async execute(p: { plan: Plan; preflight: PreflightResult; envelope: SigningEnvelope; policy: Policy; policyResult: PolicyResult;
    facts: RuntimeFacts; approval: BoundApproval; wallet: WalletSigner; now?: () => Date }): Promise<RunResult> {
    const now = p.now ?? (() => new Date());
    const calls = callsToSign(p.plan).filter((c): c is Hex => !!c);
    const signed = await p.wallet.sign(calls, p.envelope);
    const signedDryRun = await this.chain.dryRunSigned(signed.map((s) => s.signedTx));
    const check = checkBeforeSubmit({
      manifestDigest: p.plan.manifestDigest, plan: p.plan, envelope: p.envelope, preflight: p.preflight, policy: p.policy,
      policyResult: p.policyResult, approval: p.approval, preparedFingerprint: p.facts.fingerprint,
      currentFingerprint: await this.chain.readFingerprint(), signedCalls: signed.map((s) => s.signedCall), signedDryRun, now: now(), store: this.store,
    });
    if (!check.ok) return { ok: false, stage: 'submit_gate', reason: check.reasons.map((r) => r.message).join(' '), check };
    this.store.markUsed(p.approval.hash);

    const atomic = p.plan.mode === 'atomic_verified' || p.plan.mode === 'atomic_unverified';
    const ids = atomic ? ['batch'] : p.plan.steps.map((s) => s.actionId);
    const outcomes: StepOutcome[] = [];
    for (let i = 0; i < signed.length; i++) {
      const o = await this.chain.submit(signed[i]!.signedTx, ids[i]!);
      outcomes.push(o);
      if (o.status !== 'finalized' && o.status !== 'included') break;
      const partial = buildReceipt({ plan: p.plan, outcomes });
      if (partial.steps.find((s) => s.actionId === ids[i])?.verification === 'not_verified') break;
    }
    return { ok: true, receipt: buildReceipt({ plan: p.plan, outcomes, policyDigest: p.policyResult.policyDigest, approvalHash: p.approval.hash }) };
  }
}
