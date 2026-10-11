import { digestJson } from '@seam/compiler';
import type { Hex, Plan, PlanStep } from '@seam/compiler';
import { overallResult, type ReceiptStep, type StepStatus } from '@seam/policy';

/**
 * One event read back from the chain for a step's transaction. Args are positional, as the runtime defines them
 * (spec 1002 uses metadata v13, which has no field names): accounts as 0x AccountId32 hex, numbers as decimal strings.
 */
export interface ChainEvent { pallet: string; name: string; args: string[] }

/** What the chain layer reports for one step after submitting and tracking it. */
export interface StepOutcome {
  actionId: string;
  status: StepStatus;
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
  steps: ReceiptStep[];
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
export function verifyStep(step: PlanStep, signerAccountId: Hex, outcome: StepOutcome | undefined): ReceiptStep {
  const base = { actionId: step.actionId };
  if (!outcome || outcome.status === 'not_run') {
    return { ...base, status: 'not_run', events: [], verification: 'unknown', reason: 'Not run, because an earlier step did not complete.' };
  }
  const events = outcome.events.map(fmt);
  const r = (verification: ReceiptStep['verification'], reason: string): ReceiptStep => ({
    ...base, status: outcome.status, txHash: outcome.txHash, block: outcome.block, events, verification, reason,
  });
  if (outcome.status === 'failed' || outcome.events.some((e) => e.pallet === 'System' && e.name === 'ExtrinsicFailed')) {
    return r('not_verified', `The transaction failed on chain${outcome.error ? `: ${outcome.error}` : ''}.`);
  }
  if (outcome.status === 'submitted') return r('unknown', 'Submitted but not yet in a block, so nothing can be checked yet.');
  if (!outcome.txHash || !outcome.block) return r('unknown', 'No transaction hash or block was reported, so the result cannot be traced.');
  if (!outcome.events.some((e) => e.pallet === 'System' && e.name === 'ExtrinsicSuccess')) {
    return r('not_verified', 'The block has no success event for this transaction.');
  }
  const want = expectedEvent(step, signerAccountId);
  if (!want) return r('unknown', `SEAM has no check yet for ${step.kind}.`);
  if (step.kind === 'contracts.call') {
    const hit = outcome.events.some((e) => e.pallet === 'Contracts' && e.name === 'ContractEmitted' && lc(e.args[0]) === lc(want.args[0]));
    return hit
      ? r('verified', 'The call succeeded and the contract emitted an event.')
      : r('unknown', "The call succeeded, but the contract emitted no event, so its effect wasn't confirmed.");
  }
  const hit = outcome.events.some((e) => e.pallet === want.pallet && e.name === want.name && sameArgs(e.args, want.args));
  if (hit) {
    const what = step.kind === 'assets.transfer' ? 'Transfer' : 'Mint';
    return r(outcome.status === 'finalized' ? 'verified' : 'unknown',
      outcome.status === 'finalized' ? `${what} confirmed: asset, amount and account all match the plan.` : `${what} found in a block that isn't finalized yet.`);
  }
  return r('not_verified', `Expected ${fmt(want)} but the chain did not show it. The transaction succeeded, but not as planned.`);
}

export interface ReceiptInput {
  plan: Plan;
  outcomes: StepOutcome[];
  policyDigest?: Hex;
  approvalHash?: Hex;
}

export function buildReceipt({ plan, outcomes, policyDigest, approvalHash }: ReceiptInput): Receipt {
  const byId = new Map(outcomes.map((o) => [o.actionId, o]));
  const atomic = plan.mode === 'atomic_verified' || plan.mode === 'atomic_unverified';
  const steps = plan.steps.map((s) => verifyStep(s, plan.signer.publicKey, atomic ? (byId.get(s.actionId) ?? byId.get('batch')) : byId.get(s.actionId)));
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
