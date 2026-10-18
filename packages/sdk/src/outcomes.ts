import type { Hex } from '@seam/compiler';
import type { Verification } from '@seam/policy';
import type { ChainEvent, StepCode, VerifierCoverage } from './receipt.js';

/**
 * Outcome verifiers for `revive.call` and `nfts.mint`. They read the decoded events of ONE step's transaction and
 * compare them with the exact binding the caller expected. They fail closed: `effect_proven` / `verified` is returned only
 * when the step finalized, succeeded, an event of the declared shape carries exactly the expected arguments, AND the
 * caller says that event shape was `observedShape` (read from real runtime metadata). Anything else is capped below
 * `effect_proven` and says "not verified on V3".
 *
 * Nothing in this file knows the real Portaldot V3 event layouts: they have not been observed. The `SYNTHETIC_*` shapes
 * exist only so tests can exercise the logic. Callers must pass the shape they read from real metadata, and set
 * `observedShape: true` only for that.
 */

/** Where in an event's positional args each bound value sits. */
export interface NftsEventShape { pallet: string; name: string; args: { collection: number; item: number; mintTo: number } }
export interface ReviveEventShape { pallet: string; name: string; args: { dest: number; data: number; value?: number } }

/** SYNTHETIC. Not observed on Portaldot V3. For tests only; do not pass these with `observedShape: true` in real use. */
export const SYNTHETIC_NFTS_SHAPE: NftsEventShape = { pallet: 'Nfts', name: 'Issued', args: { collection: 0, item: 1, mintTo: 2 } };
/** SYNTHETIC. Not observed on Portaldot V3. For tests only. */
export const SYNTHETIC_REVIVE_SHAPE: ReviveEventShape = { pallet: 'Revive', name: 'Called', args: { dest: 0, value: 1, data: 2 } };

export interface NftsMintExpectation { collection: string; item: string; mintTo: Hex }
export interface ReviveCallExpectation { dest: Hex; value: string; data: Hex }

export interface OutcomeInput<S> {
  /** Status of the step's transaction as the chain layer reported it. */
  status: 'finalized' | 'included' | 'submitted' | 'failed';
  /** Decoded events of that transaction only. */
  events: ChainEvent[];
  /** True only if `shape` was read from real runtime metadata for the target chain. Default false: capped. */
  observedShape?: boolean;
  shape: S;
}

/** What a verifier concluded. Feed it to `buildReceipt({ verdicts: { [actionId]: verdict } })`. */
export interface OutcomeVerdict {
  verification: Verification;
  coverage: VerifierCoverage;
  reason: string;
  code?: StepCode;
  /** The event (as `Pallet.name(args)`) that matched the binding. Required for `verified`; the receipt re-checks it is in the step's events. */
  matchedEvent?: string;
}

const lc = (s: string | undefined) => (s ?? '').toLowerCase();
const fmt = (e: ChainEvent) => `${e.pallet}.${e.name}(${e.args.join(', ')})`;

export const NOT_VERIFIED_ON_V3 = 'A matching event was found, but its shape has not been observed from real V3 metadata, so this is not verified on V3.';

type Bound = { index: number; expected: string }[];

/** Shared fail-closed logic: dispatch errors, finality, event presence, exact match, then the observed-shape cap. */
function judge(input: OutcomeInput<{ pallet: string; name: string }>, bound: Bound, arity: number, what: string): OutcomeVerdict {
  const { status, events } = input;
  const failedEvent = events.some((e) => e.pallet === 'System' && e.name === 'ExtrinsicFailed');
  if (status === 'failed' || failedEvent) {
    return { verification: 'not_verified', coverage: 'none', code: 'tx_failed', reason: `The ${what} transaction failed on chain.` };
  }
  const ok = events.some((e) => e.pallet === 'System' && e.name === 'ExtrinsicSuccess');
  if (!ok) return { verification: 'unknown', coverage: 'none', code: 'no_trace', reason: `No success event was found for the ${what} transaction.` };
  if (status !== 'finalized') {
    return { verification: 'unknown', coverage: 'call_dispatched', code: 'not_finalized', reason: `The ${what} is in a block that isn't finalized yet, so its effect cannot be proven.` };
  }
  const named = events.filter((e) => e.pallet === input.shape.pallet && e.name === input.shape.name);
  if (!named.length) {
    return { verification: 'unknown', coverage: 'extrinsic_finalized', code: 'effect_unproven', reason: `The ${what} finalized, but no ${input.shape.pallet}.${input.shape.name} event was found, so its effect is not proven.` };
  }
  const wellFormed = named.filter((e) => e.args.length === arity);
  if (!wellFormed.length) {
    return { verification: 'unknown', coverage: 'contract_emitted', code: 'effect_unproven', reason: `An ${input.shape.pallet}.${input.shape.name} event was found but its arguments do not have the expected shape, so it was not used as proof.` };
  }
  const hit = wellFormed.find((e) => bound.every((b) => lc(e.args[b.index]) === lc(b.expected)));
  if (!hit) {
    return { verification: 'not_verified', coverage: 'contract_emitted', code: 'effect_mismatch', reason: `The ${what} emitted ${input.shape.pallet}.${input.shape.name}, but not with the arguments that were requested.` };
  }
  if (input.observedShape !== true) {
    return { verification: 'unknown', coverage: 'contract_emitted', code: 'v3_shape_unobserved', reason: NOT_VERIFIED_ON_V3, matchedEvent: fmt(hit) };
  }
  return { verification: 'verified', coverage: 'effect_proven', reason: `The ${what} finalized and the chain shows exactly the requested arguments.`, matchedEvent: fmt(hit) };
}

/** Verifies an `nfts.mint` step: collection, item and owner must all match exactly. */
export function verifyNftsMintOutcome(input: OutcomeInput<NftsEventShape>, want: NftsMintExpectation): OutcomeVerdict {
  const a = input.shape.args;
  return judge(input, [
    { index: a.collection, expected: want.collection }, { index: a.item, expected: want.item }, { index: a.mintTo, expected: want.mintTo },
  ], Math.max(a.collection, a.item, a.mintTo) + 1, 'NFT mint');
}

/**
 * Verifies a `revive.call` step: destination, value and call data must all match exactly. If the shape has no `value`
 * position, a non-zero expected value cannot be proven and the result is capped at `contract_emitted`.
 */
export function verifyReviveCallOutcome(input: OutcomeInput<ReviveEventShape>, want: ReviveCallExpectation): OutcomeVerdict {
  const a = input.shape.args;
  const bound: Bound = [{ index: a.dest, expected: want.dest }, { index: a.data, expected: want.data }];
  if (a.value !== undefined) bound.push({ index: a.value, expected: want.value });
  const v = judge(input, bound, Math.max(a.dest, a.data, a.value ?? 0) + 1, 'Revive call');
  if (v.verification === 'verified' && a.value === undefined && want.value !== '0') {
    return { verification: 'unknown', coverage: 'contract_emitted', code: 'effect_unproven', reason: 'The event does not carry the transferred value, so the requested value was not proven.', matchedEvent: v.matchedEvent };
  }
  return v;
}
