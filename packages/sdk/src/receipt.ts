import { digestJson } from '@seam/compiler';
import type { Hex, Plan, PlanStep } from '@seam/compiler';
import { overallResult, type ReceiptStep, type StepStatus } from '@seam/policy';

/**
 * Step status as the SDK reports it. `uncertain` means a broadcast may or may not have happened (RPC timeout after the
 * approval was consumed): never retried automatically, never verified. The policy package's StepStatus has no such word.
 */
export type SdkStepStatus = StepStatus | 'uncertain';

/**
 * How much of a step the chain has actually shown, lowest to highest:
 * none < call_dispatched (in a block, ExtrinsicSuccess, not final) < extrinsic_finalized (final, ExtrinsicSuccess)
 * < contract_emitted (final, and the addressed contract emitted some event) < effect_proven (the requested effect itself:
 * the exact expected decoded event, or a state readback that matches).
 * Only `effect_proven` (or the pallet's own exact event for Assets) may be called verified.
 */
export type VerifierCoverage = 'none' | 'call_dispatched' | 'extrinsic_finalized' | 'contract_emitted' | 'effect_proven';

/** Why a step is unknown / not verified, in a form code can switch on. */
export type StepCode =
  | 'unsupported_runtime' | 'effect_unproven' | 'effect_mismatch' | 'not_finalized' | 'tx_failed' | 'no_trace' | 'uncertain' | 'not_run';

/**
 * A receipt step. Its `status` can be 'uncertain' at runtime (see SdkStepStatus) but is typed as the policy package's
 * StepStatus until Bot 3 widens it there, so flow.ts and the submit gate keep compiling. Compare against SdkStepStatus.
 */
export type SdkReceiptStep = ReceiptStep & { coverage: VerifierCoverage; code?: StepCode };

/** What the caller expects a contracts.call to have done, committed before the run. SEAM does not guess this from the ABI. */
export interface ContractEffect {
  /** Exact `data` bytes of the ContractEmitted event the call must produce (event selector and arguments included). */
  emittedData?: Hex;
  /** A value read back from the contract after the call. `actual` undefined/null means it could not be read. */
  stateReadback?: { expected: string; actual?: string | null };
}

/**
 * One event read back from the chain for a step's transaction. Args are positional, as the runtime defines them
 * (spec 1002 uses metadata v13, which has no field names): accounts as 0x AccountId32 hex, numbers as decimal strings.
 */
export interface ChainEvent { pallet: string; name: string; args: string[] }

/** What the chain layer reports for one step after submitting and tracking it. */
export interface StepOutcome {
  actionId: string;
  status: SdkStepStatus;
  txHash?: Hex;
  block?: { number: number; hash: Hex };
  events: ChainEvent[];
  /** Decoded dispatch error, when the transaction failed. */
  error?: string;
}

export interface Receipt {
  receiptVersion: 1;
  manifestDigest: Hex;
  planDigest: Hex;
  fingerprintDigest: Hex;
  policyDigest: Hex | null;
  approvalHash: Hex | null;
  mode: Plan['mode'];
  steps: SdkReceiptStep[];
  result: 'verified' | 'partial' | 'not_verified';
  /** How many steps were confirmed against the chain, out of how many the plan had. */
  coverage: { verified: number; expected: number };
  receiptDigest: Hex;
}

const lc = (s: string | undefined) => (s ?? '').toLowerCase();
const fmt = (e: ChainEvent) => `${e.pallet}.${e.name}(${e.args.join(', ')})`;
const sameArgs = (got: string[], want: string[]) => got.length === want.length && want.every((w, i) => lc(got[i]) === lc(w));

/** What the chain must show for a step to count as verified. */
export function expectedEvent(step: PlanStep, signerAccountId: Hex): ChainEvent | null {
  const a = step.decodedArgs;
  switch (step.kind) {
    case 'assets.transfer':
      return { pallet: 'Assets', name: 'Transferred', args: [a.assetId!, signerAccountId, a.recipientAccountId!, a.amount!] };
    case 'assets.mint':
      return { pallet: 'Assets', name: 'Issued', args: [a.assetId!, a.recipientAccountId!, a.amount!] };
    case 'contracts.call':
      // The contract itself must emit an event; a successful extrinsic alone doesn't prove what the contract did.
      return { pallet: 'Contracts', name: 'ContractEmitted', args: [a.contractAccountId!] };
    default:
      return null;
  }
}

/** Checks one step's outcome against the plan. Missing evidence is never reported as success. */
export function verifyStep(step: PlanStep, signerAccountId: Hex, outcome: StepOutcome | undefined, effect?: ContractEffect): SdkReceiptStep {
  const base = { actionId: step.actionId };
  if (!outcome || outcome.status === 'not_run') {
    return { ...base, status: 'not_run', events: [], verification: 'unknown', coverage: 'none', code: 'not_run', reason: 'Not run, because an earlier step did not complete.' };
  }
  const events = outcome.events.map(fmt);
  const r = (verification: ReceiptStep['verification'], coverage: VerifierCoverage, reason: string, code?: StepCode): SdkReceiptStep => ({
    ...base, status: outcome.status as StepStatus, txHash: outcome.txHash, block: outcome.block, events, verification, coverage, reason, ...(code ? { code } : {}),
  });
  if (outcome.status === 'failed' || outcome.events.some((e) => e.pallet === 'System' && e.name === 'ExtrinsicFailed')) {
    return r('not_verified', 'none', `The transaction failed on chain${outcome.error ? `: ${outcome.error}` : ''}.`, 'tx_failed');
  }
  if (outcome.status === 'uncertain') return r('unknown', 'none', 'SEAM could not tell whether this transaction was broadcast. It was not retried; check the chain for the transaction before doing anything else.', 'uncertain');
  if (outcome.status === 'submitted') return r('unknown', 'none', 'Submitted but not yet in a block, so nothing can be checked yet.', 'not_finalized');
  if (!outcome.txHash || !outcome.block) {
    // A finalized step must carry its tx hash and block; one that doesn't is malformed evidence, not merely unknown.
    return r(outcome.status === 'finalized' ? 'not_verified' : 'unknown', 'none', 'No transaction hash or block was reported, so the result cannot be traced.', 'no_trace');
  }
  if (!outcome.events.some((e) => e.pallet === 'System' && e.name === 'ExtrinsicSuccess')) {
    return r('not_verified', 'none', 'The block has no success event for this transaction.', 'tx_failed');
  }
  const final = outcome.status === 'finalized';
  const base1: VerifierCoverage = final ? 'extrinsic_finalized' : 'call_dispatched';
  const want = expectedEvent(step, signerAccountId);
  if (!want) {
    return r('unknown', base1, `SEAM has no check for ${step.kind} on this runtime (unsupported_runtime). The extrinsic succeeded, but its effect was not checked.`, 'unsupported_runtime');
  }
  if (step.kind === 'contracts.call') return verifyContractCall(r, outcome, want, final, base1, effect);
  const hit = outcome.events.some((e) => e.pallet === want.pallet && e.name === want.name && sameArgs(e.args, want.args));
  if (hit) {
    const what = step.kind === 'assets.transfer' ? 'Transfer' : 'Mint';
    return final
      ? r('verified', 'effect_proven', `${what} confirmed: asset, amount and account all match the plan.`)
      : r('unknown', base1, `${what} found in a block that isn't finalized yet.`, 'not_finalized');
  }
  return r('not_verified', base1, `Expected ${fmt(want)} but the chain did not show it. The transaction succeeded, but not as planned.`, 'effect_mismatch');
}

function verifyContractCall(
  r: (v: ReceiptStep['verification'], c: VerifierCoverage, reason: string, code?: StepCode) => SdkReceiptStep,
  outcome: StepOutcome, want: ChainEvent, final: boolean, base1: VerifierCoverage, effect?: ContractEffect,
): SdkReceiptStep {
  const emitted = outcome.events.filter((e) => e.pallet === 'Contracts' && e.name === 'ContractEmitted' && lc(e.args[0]) === lc(want.args[0]));
  const cov: VerifierCoverage = final && emitted.length ? 'contract_emitted' : base1;
  if (!final) return r('unknown', cov, "The call is in a block that isn't finalized yet, so its effect cannot be proven.", 'not_finalized');
  if (!effect || (effect.emittedData === undefined && !effect.stateReadback)) {
    return r('unknown', cov, emitted.length
      ? 'The call succeeded and the contract emitted an event, but SEAM was given no expected event or state to compare, so the requested effect is not proven.'
      : 'The call succeeded, but the contract emitted no event and no state was checked, so its effect was not confirmed.', 'effect_unproven');
  }
  const checks: ('pass' | 'fail' | 'unknown')[] = [];
  const why: string[] = [];
  if (effect.emittedData !== undefined) {
    if (emitted.some((e) => lc(e.args[1]) === lc(effect.emittedData))) checks.push('pass');
    else if (emitted.length) { checks.push('fail'); why.push('the contract emitted an event, but not the expected one'); }
    else { checks.push('unknown'); why.push('the expected contract event is missing'); }
  }
  if (effect.stateReadback) {
    const { expected, actual } = effect.stateReadback;
    if (actual === undefined || actual === null) { checks.push('unknown'); why.push('the contract state could not be read back'); }
    else if (actual === expected) checks.push('pass');
    else { checks.push('fail'); why.push(`contract state reads ${actual}, expected ${expected}`); }
  }
  if (checks.includes('fail')) return r('not_verified', cov, `The call succeeded, but the requested effect is not on chain: ${why.join('; ')}.`, 'effect_mismatch');
  if (checks.includes('unknown')) return r('unknown', cov, `The requested effect could not be confirmed: ${why.join('; ')}.`, 'effect_unproven');
  return r('verified', 'effect_proven', 'The call succeeded and the expected contract event and/or state readback match.');
}

export interface ReceiptInput {
  plan: Plan;
  outcomes: StepOutcome[];
  policyDigest?: Hex;
  approvalHash?: Hex;
  /** Why a sequential run stopped early. Shown on the first step that was not run. */
  stoppedReason?: string;
  /** Per actionId: what a contracts.call must have done. Without it a contract call can reach `contract_emitted` at most, never verified. */
  effects?: Record<string, ContractEffect>;
}

export function buildReceipt({ plan, outcomes, policyDigest, approvalHash, stoppedReason, effects }: ReceiptInput): Receipt {
  const byId = new Map(outcomes.map((o) => [o.actionId, o]));
  const atomic = plan.mode === 'atomic_verified' || plan.mode === 'atomic_unverified';
  const steps = plan.steps.map((s) => verifyStep(s, plan.signer.publicKey, atomic ? (byId.get(s.actionId) ?? byId.get('batch')) : byId.get(s.actionId), effects?.[s.actionId]));
  const firstNotRun = steps.find((s) => s.status === 'not_run');
  if (stoppedReason && firstNotRun) firstNotRun.reason = `Not run. ${stoppedReason}`;
  const body = {
    receiptVersion: 1 as const,
    manifestDigest: plan.manifestDigest,
    planDigest: plan.planDigest,
    fingerprintDigest: plan.fingerprintDigest,
    policyDigest: policyDigest ?? null,
    approvalHash: approvalHash ?? null,
    mode: plan.mode,
    steps,
    result: overallResult(steps),
    coverage: { verified: steps.filter((s) => s.verification === 'verified').length, expected: plan.steps.length },
  };
  return { ...body, receiptDigest: receiptDigest(body) };
}

export function receiptDigest(r: Omit<Receipt, 'receiptDigest'> | Receipt): Hex {
  const { receiptDigest: _x, ...rest } = r as Receipt;
  return digestJson('seam/receipt/v1', rest);
}

/** True when nobody edited the receipt after SEAM produced it. */
export function checkReceipt(r: Receipt): boolean {
  return receiptDigest(r) === r.receiptDigest;
}

export type ReceiptCheckStatus = 'integrity_checked' | 'chain_verified' | 'unknown' | 'failed';

export const INTEGRITY_ONLY_NOTE =
  'integrity only, not on-chain proof: this checks that the receipt was not edited after it was written. Anyone can recompute that digest, so it does not show that any transaction exists. Use live verification (seam verify --endpoint) for that.';

/**
 * Offline check. The only possible answers are `integrity_checked` (the receipt's own digest matches) or `failed`.
 * It can never return `chain_verified`.
 */
export function receiptIntegrity(r: Receipt): { status: 'integrity_checked' | 'failed'; note: string } {
  const bad = r.steps.find((x) => x.status === 'finalized' && (!x.txHash || !x.block));
  if (bad) return { status: 'failed', note: `Step ${bad.actionId} is marked finalized but has no transaction hash or block: the receipt is malformed.` };
  return checkReceipt(r)
    ? { status: 'integrity_checked', note: INTEGRITY_ONLY_NOTE }
    : { status: 'failed', note: 'The receipt does not match its own digest: it was edited after SEAM produced it.' };
}
