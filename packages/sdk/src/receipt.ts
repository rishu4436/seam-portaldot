import { digestJson } from "@seam/compiler";
import type { Hex, Plan, PlanStep } from "@seam/compiler";
import {
  isObservedV3,
  nftsShapeFor,
  verifyNftsMintOutcome,
  verifyReviveCallV3Outcome,
} from "./outcomes.js";
import type { EffectBasis, NftsRuntime, OutcomeVerdict } from "./outcomes.js";
import {
  verifyMapAccountOutcome,
  verifyReviveInstantiateOutcome,
  type OriginalAccountRead,
} from "./deploy-outcomes.js";

/** Step kinds with a default V3 verdict (spec 3002 only for the revive ones). */
const VERDICT_KINDS = [
  "nfts.mint",
  "revive.call",
  "revive.instantiate_with_code",
  "revive.map_account",
];
import { overallResult, type ReceiptStep, type StepStatus } from "@seam/policy";

/**
 * Step status as the SDK reports it. `uncertain` means a broadcast may or may not have happened (RPC timeout after the
 * approval was consumed): never retried automatically, never verified. Same as the policy package's StepStatus.
 */
export type SdkStepStatus = StepStatus;

/**
 * How much of a step the chain has actually shown, lowest to highest:
 * none < call_dispatched (in a block, ExtrinsicSuccess, not final) < extrinsic_finalized (final, ExtrinsicSuccess)
 * < contract_emitted (final, and the addressed contract emitted some event) < effect_proven (the requested effect itself:
 * the exact expected decoded event, or a state readback that matches).
 * Only `effect_proven` (or the pallet's own exact event for Assets) may be called verified.
 */
export type VerifierCoverage =
  "none" | "call_dispatched" | "extrinsic_finalized" | "contract_emitted" | "effect_proven";

/** Why a step is unknown / not verified, in a form code can switch on. */
export type StepCode =
  | "unsupported_runtime"
  | "v3_shape_unobserved"
  | "effect_unproven"
  | "effect_mismatch"
  | "not_finalized"
  | "tx_failed"
  | "no_trace"
  | "uncertain"
  | "not_run";

/** A receipt step: the policy package's ReceiptStep plus how much the chain showed and why it is unknown or not verified. */
export type SdkReceiptStep = ReceiptStep & {
  coverage: VerifierCoverage;
  code?: StepCode;
  /** Set on revive.call steps judged by `verifyReviveCallV3Outcome`: what the result rests on. */
  basis?: EffectBasis;
};

/** What the caller expects a contracts.call to have done, committed before the run. SEAM does not guess this from the ABI. */
export interface ContractEffect {
  /** Exact `data` bytes of the ContractEmitted event the call must produce (event selector and arguments included). */
  emittedData?: Hex;
  /** A value read back from the contract after the call. `actual` undefined/null means it could not be read. */
  stateReadback?: { expected: string; actual?: string | null };
  /** revive.call on V3 only: exact topics of the expected `Revive.ContractEmitted`, in order. Checked only when given. */
  emittedTopics?: Hex[];
  /** revive.map_account on V3 only: a `Revive.OriginalAccount` read after the call. Without it the mapping is not proven. */
  originalAccount?: OriginalAccountRead;
}

/**
 * One event read back from the chain for a step's transaction. Args are positional, as the runtime defines them
 * (spec 1002 uses metadata v13, which has no field names): accounts as 0x AccountId32 hex, numbers as decimal strings.
 */
export interface ChainEvent {
  pallet: string;
  name: string;
  args: string[];
}

/** What the chain layer reports for one step after submitting and tracking it. */
export interface StepOutcome {
  actionId: string;
  status: SdkStepStatus;
  txHash?: Hex;
  block?: { number: number; hash: Hex };
  events: ChainEvent[];
  /** Decoded dispatch error, when the transaction failed. */
  error?: string;
  /** The call bytes of the extrinsic as signed and included. The V3 revive.call check needs them; without them it is unknown. */
  callHex?: Hex;
}

export interface Receipt {
  receiptVersion: 1;
  manifestDigest: Hex;
  planDigest: Hex;
  fingerprintDigest: Hex;
  policyDigest: Hex | null;
  approvalHash: Hex | null;
  mode: Plan["mode"];
  steps: SdkReceiptStep[];
  result: "verified" | "partial" | "not_verified";
  /** How many steps were confirmed against the chain, out of how many the plan had. */
  coverage: { verified: number; expected: number };
  receiptDigest: Hex;
}

const lc = (s: string | undefined) => (s ?? "").toLowerCase();
const fmt = (e: ChainEvent) => `${e.pallet}.${e.name}(${e.args.join(", ")})`;
const sameArgs = (got: string[], want: string[]) =>
  got.length === want.length && want.every((w, i) => lc(got[i]) === lc(w));

/** What the chain must show for a step to count as verified. */
export function expectedEvent(step: PlanStep, signerAccountId: Hex): ChainEvent | null {
  const a = step.decodedArgs;
  switch (step.kind) {
    case "assets.transfer":
      return {
        pallet: "Assets",
        name: "Transferred",
        args: [a.assetId!, signerAccountId, a.recipientAccountId!, a.amount!],
      };
    case "assets.mint":
      return {
        pallet: "Assets",
        name: "Issued",
        args: [a.assetId!, a.recipientAccountId!, a.amount!],
      };
    case "contracts.call":
      // The contract itself must emit an event; a successful extrinsic alone doesn't prove what the contract did.
      return { pallet: "Contracts", name: "ContractEmitted", args: [a.contractAccountId!] };
    default:
      return null;
  }
}

/** Checks one step's outcome against the plan. Missing evidence is never reported as success. */
export function verifyStep(
  step: PlanStep,
  signerAccountId: Hex,
  outcome: StepOutcome | undefined,
  effect?: ContractEffect,
  verdict?: OutcomeVerdict,
  runtime?: NftsRuntime,
): SdkReceiptStep {
  const base = { actionId: step.actionId };
  if (!outcome || outcome.status === "not_run") {
    return {
      ...base,
      status: "not_run",
      events: [],
      verification: "unknown",
      coverage: "none",
      code: "not_run",
      reason: "Not run, because an earlier step did not complete.",
    };
  }
  const events = outcome.events.map(fmt);
  const r = (
    verification: ReceiptStep["verification"],
    coverage: VerifierCoverage,
    reason: string,
    code?: StepCode,
  ): SdkReceiptStep => ({
    ...base,
    status: outcome.status,
    txHash: outcome.txHash,
    block: outcome.block,
    events,
    verification,
    coverage,
    reason,
    ...(code ? { code } : {}),
  });
  if (
    outcome.status === "failed" ||
    outcome.events.some((e) => e.pallet === "System" && e.name === "ExtrinsicFailed")
  ) {
    return r(
      "not_verified",
      "none",
      `The transaction failed on chain${outcome.error ? `: ${outcome.error}` : ""}.`,
      "tx_failed",
    );
  }
  if (outcome.status === "uncertain")
    return r(
      "unknown",
      "none",
      "SEAM could not tell whether this transaction was broadcast. It was not retried; check the chain for the transaction before doing anything else.",
      "uncertain",
    );
  if (outcome.status === "submitted")
    return r(
      "unknown",
      "none",
      "Submitted but not yet in a block, so nothing can be checked yet.",
      "not_finalized",
    );
  if (!outcome.txHash || !outcome.block) {
    // A finalized step must carry its tx hash and block; one that doesn't is malformed evidence, not merely unknown.
    return r(
      outcome.status === "finalized" ? "not_verified" : "unknown",
      "none",
      "No transaction hash or block was reported, so the result cannot be traced.",
      "no_trace",
    );
  }
  if (!outcome.events.some((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess")) {
    return r(
      "not_verified",
      "none",
      "The block has no success event for this transaction.",
      "tx_failed",
    );
  }
  const final = outcome.status === "finalized";
  const base1: VerifierCoverage = final ? "extrinsic_finalized" : "call_dispatched";
  const want = expectedEvent(step, signerAccountId);
  if (!want) {
    // An explicit verdict wins. Otherwise nfts.mint and revive.call get their default checks (observed spec 3002 only).
    const v =
      verdict ??
      (step.kind === "nfts.mint"
        ? defaultNftsVerdict(step, outcome, runtime)
        : step.kind === "revive.call"
          ? defaultReviveVerdict(step, outcome, effect, runtime)
          : (step.kind as string) === "revive.instantiate_with_code"
            ? defaultInstantiateVerdict(step, signerAccountId, outcome, runtime)
            : (step.kind as string) === "revive.map_account"
              ? defaultMapAccountVerdict(signerAccountId, outcome, effect, runtime)
              : undefined);
    if (v && VERDICT_KINDS.includes(step.kind as string))
      return applyVerdict(r, outcome, v, final, base1);
    return r(
      "unknown",
      base1,
      `SEAM has no check for ${step.kind} on this runtime (unsupported_runtime). The extrinsic succeeded, but its effect was not checked.`,
      "unsupported_runtime",
    );
  }
  if (step.kind === "contracts.call")
    return verifyContractCall(r, outcome, want, final, base1, effect);
  const hit = outcome.events.some(
    (e) => e.pallet === want.pallet && e.name === want.name && sameArgs(e.args, want.args),
  );
  if (hit) {
    const what = step.kind === "assets.transfer" ? "Transfer" : "Mint";
    return final
      ? r(
          "verified",
          "effect_proven",
          `${what} confirmed: asset, amount and account all match the plan.`,
        )
      : r("unknown", base1, `${what} found in a block that isn't finalized yet.`, "not_finalized");
  }
  return r(
    "not_verified",
    base1,
    `Expected ${fmt(want)} but the chain did not show it. The transaction succeeded, but not as planned.`,
    "effect_mismatch",
  );
}

/**
 * Takes a verifier's verdict for revive.call / nfts.mint, but never trusts it past what the receipt itself shows:
 * `verified` needs a finalized step whose own events contain the verdict's matchedEvent; otherwise it is downgraded.
 */
/** The default nfts.mint verdict from the step's own events and its planned collection, item and recipient. */
function defaultNftsVerdict(
  step: PlanStep,
  outcome: StepOutcome,
  runtime: NftsRuntime | undefined,
): OutcomeVerdict | undefined {
  const a = step.decodedArgs as Record<string, unknown>;
  const { collection, item, recipientAccountId } = a;
  if (typeof collection !== "string" || typeof item !== "string") return undefined;
  if (typeof recipientAccountId !== "string") return undefined;
  if (outcome.status !== "finalized" && outcome.status !== "included") return undefined;
  const { shape, observed } = nftsShapeFor(runtime);
  return verifyNftsMintOutcome(
    {
      status: outcome.status,
      events: outcome.events,
      shape,
      observedShape: observed,
      ...(runtime?.ss58Prefix !== undefined ? { ss58Prefix: runtime.ss58Prefix } : {}),
    },
    { collection, item, mintTo: recipientAccountId as Hex },
  );
}

/**
 * The default revive.call verdict on V3 spec 3002 (`verifyReviveCallV3Outcome`). On any other runtime there is none, so
 * the step stays `unsupported_runtime`. `effect.emittedData`/`emittedTopics` give the expected contract event;
 * `effect.stateReadback` is not used for revive.call.
 */
function defaultReviveVerdict(
  step: PlanStep,
  outcome: StepOutcome,
  effect: ContractEffect | undefined,
  runtime: NftsRuntime | undefined,
): OutcomeVerdict | undefined {
  if (!isObservedV3(runtime)) return undefined;
  if (outcome.status !== "finalized" && outcome.status !== "included") return undefined;
  const a = step.decodedArgs as Record<string, string | null | undefined>;
  return verifyReviveCallV3Outcome(
    {
      status: outcome.status,
      events: outcome.events,
      ...(outcome.callHex ? { callHex: outcome.callHex } : {}),
      ...(runtime ? { runtime } : {}),
    },
    {
      palletIndex: step.palletIndex,
      callIndex: step.callIndex,
      contract: a.contract as string,
      value: a.value as string,
      data: a.data as string,
      gasLimit: a.gasLimit as string,
      proofSize: a.proofSize as string,
      storageDepositLimit: a.storageDepositLimit ?? null,
      ...(effect?.emittedData !== undefined ? { emittedData: effect.emittedData } : {}),
      ...(effect?.emittedTopics ? { emittedTopics: effect.emittedTopics } : {}),
    },
  );
}

/**
 * The default revive.instantiate_with_code verdict on V3 spec 3002 (`verifyReviveInstantiateOutcome`). On any other
 * runtime there is none, so the step stays `unsupported_runtime`.
 */
function defaultInstantiateVerdict(
  step: PlanStep,
  signerAccountId: Hex,
  outcome: StepOutcome,
  runtime: NftsRuntime | undefined,
): OutcomeVerdict | undefined {
  if (!isObservedV3(runtime)) return undefined;
  if (outcome.status !== "finalized" && outcome.status !== "included") return undefined;
  const a = step.decodedArgs as Record<string, string | null | undefined>;
  return verifyReviveInstantiateOutcome(
    {
      status: outcome.status,
      events: outcome.events,
      signerAccountId,
      ...(outcome.callHex ? { callHex: outcome.callHex } : {}),
      ...(runtime ? { runtime } : {}),
    },
    {
      palletIndex: step.palletIndex,
      callIndex: step.callIndex,
      codeHash: a.codeHash ?? undefined,
      value: a.value ?? undefined,
      gasLimit: a.gasLimit ?? undefined,
      proofSize: a.proofSize ?? undefined,
      storageDepositLimit: a.storageDepositLimit,
    },
  );
}

/**
 * The default revive.map_account verdict on V3 spec 3002 (`verifyMapAccountOutcome`). V3 emits no event for it, so it is
 * `unknown` unless `effect.originalAccount` supplies a Revive.OriginalAccount read. Other runtimes: none.
 */
function defaultMapAccountVerdict(
  signerAccountId: Hex,
  outcome: StepOutcome,
  effect: ContractEffect | undefined,
  runtime: NftsRuntime | undefined,
): OutcomeVerdict | undefined {
  if (!isObservedV3(runtime)) return undefined;
  if (outcome.status !== "finalized" && outcome.status !== "included") return undefined;
  return verifyMapAccountOutcome({
    status: outcome.status,
    events: outcome.events,
    signerAccountId,
    ...(runtime ? { runtime } : {}),
    ...(effect?.originalAccount ? { originalAccount: effect.originalAccount } : {}),
  });
}

function applyVerdict(
  r: (
    v: ReceiptStep["verification"],
    c: VerifierCoverage,
    reason: string,
    code?: StepCode,
  ) => SdkReceiptStep,
  outcome: StepOutcome,
  v: OutcomeVerdict,
  final: boolean,
  base1: VerifierCoverage,
): SdkReceiptStep {
  if (v.verification === "verified") {
    // A state-read verdict (map_account) has no event to match; it still needs a finalized step and effect_proven.
    const matched =
      v.basis === "original_account_readback" ||
      (!!v.matchedEvent && outcome.events.some((e) => fmt(e) === v.matchedEvent));
    if (!final || !matched || v.coverage !== "effect_proven") {
      return r(
        "unknown",
        base1,
        "A verdict claimed this effect was proven, but the receipt's own events do not back it, so it is not verified.",
        "effect_unproven",
      );
    }
    return withBasis(r("verified", "effect_proven", v.reason), v);
  }
  return withBasis(
    r(v.verification, v.coverage === "effect_proven" ? base1 : v.coverage, v.reason, v.code),
    v,
  );
}

const withBasis = (s: SdkReceiptStep, v: OutcomeVerdict): SdkReceiptStep =>
  v.basis ? { ...s, basis: v.basis } : s;

function verifyContractCall(
  r: (
    v: ReceiptStep["verification"],
    c: VerifierCoverage,
    reason: string,
    code?: StepCode,
  ) => SdkReceiptStep,
  outcome: StepOutcome,
  want: ChainEvent,
  final: boolean,
  base1: VerifierCoverage,
  effect?: ContractEffect,
): SdkReceiptStep {
  const emitted = outcome.events.filter(
    (e) =>
      e.pallet === "Contracts" &&
      e.name === "ContractEmitted" &&
      lc(e.args[0]) === lc(want.args[0]),
  );
  const cov: VerifierCoverage = final && emitted.length ? "contract_emitted" : base1;
  if (!final)
    return r(
      "unknown",
      cov,
      "The call is in a block that isn't finalized yet, so its effect cannot be proven.",
      "not_finalized",
    );
  if (!effect || (effect.emittedData === undefined && !effect.stateReadback)) {
    return r(
      "unknown",
      cov,
      emitted.length
        ? "The call succeeded and the contract emitted an event, but SEAM was given no expected event or state to compare, so the requested effect is not proven."
        : "The call succeeded, but the contract emitted no event and no state was checked, so its effect was not confirmed.",
      "effect_unproven",
    );
  }
  const checks: ("pass" | "fail" | "unknown")[] = [];
  const why: string[] = [];
  if (effect.emittedData !== undefined) {
    if (emitted.some((e) => lc(e.args[1]) === lc(effect.emittedData))) checks.push("pass");
    else if (emitted.length) {
      checks.push("fail");
      why.push("the contract emitted an event, but not the expected one");
    } else {
      checks.push("unknown");
      why.push("the expected contract event is missing");
    }
  }
  if (effect.stateReadback) {
    const { expected, actual } = effect.stateReadback;
    if (actual === undefined || actual === null) {
      checks.push("unknown");
      why.push("the contract state could not be read back");
    } else if (actual === expected) checks.push("pass");
    else {
      checks.push("fail");
      why.push(`contract state reads ${actual}, expected ${expected}`);
    }
  }
  if (checks.includes("fail"))
    return r(
      "not_verified",
      cov,
      `The call succeeded, but the requested effect is not on chain: ${why.join("; ")}.`,
      "effect_mismatch",
    );
  if (checks.includes("unknown"))
    return r(
      "unknown",
      cov,
      `The requested effect could not be confirmed: ${why.join("; ")}.`,
      "effect_unproven",
    );
  return r(
    "verified",
    "effect_proven",
    "The call succeeded and the expected contract event and/or state readback match.",
  );
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
  /**
   * Per actionId: a verdict from verifyReviveCallOutcome / verifyNftsMintOutcome. An explicit verdict wins. Without one,
   * revive.call and nfts.mint get the default checks (see `runtime`).
   */
  verdicts?: Record<string, OutcomeVerdict>;
  /**
   * The runtime the plan ran on (a RuntimeFingerprint fits). nfts.mint can reach `verified` by default only when this is
   * `portaldot-v3` spec 3002, where `Nfts.Issued(collection, item, owner)` was observed. Without it, or on any other
   * runtime, a matching Nfts.Issued is capped at `contract_emitted` ("not verified on V3"). revive.call gets its default
   * (`verifyReviveCallV3Outcome`) only on that runtime, and needs each outcome's `callHex`.
   */
  runtime?: NftsRuntime;
}

export function buildReceipt({
  plan,
  outcomes,
  policyDigest,
  approvalHash,
  stoppedReason,
  effects,
  verdicts,
  runtime,
}: ReceiptInput): Receipt {
  const byId = new Map(outcomes.map((o) => [o.actionId, o]));
  const atomic = plan.mode === "atomic_verified" || plan.mode === "atomic_unverified";
  const steps = plan.steps.map((s) =>
    verifyStep(
      s,
      plan.signer.publicKey,
      atomic ? (byId.get(s.actionId) ?? byId.get("batch")) : byId.get(s.actionId),
      effects?.[s.actionId],
      verdicts?.[s.actionId],
      runtime,
    ),
  );
  const firstNotRun = steps.find((s) => s.status === "not_run");
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
    coverage: {
      verified: steps.filter((s) => s.verification === "verified").length,
      expected: plan.steps.length,
    },
  };
  return { ...body, receiptDigest: receiptDigest(body) };
}

export function receiptDigest(r: Omit<Receipt, "receiptDigest"> | Receipt): Hex {
  const { receiptDigest: _x, ...rest } = r as Receipt;
  return digestJson("seam/receipt/v1", rest);
}

/**
 * Why a value is not a SEAM receipt that can be checked, or `undefined` when it has the receipt's shape. Every receipt
 * check runs this first, so a file that is not a receipt (for example a whole run record) is a clear failure, never a crash.
 */
export function receiptShapeProblem(r: unknown): string | undefined {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "it is not a JSON object";
  const o = r as Record<string, unknown>;
  if (o.receiptVersion !== 1) return 'it has no "receiptVersion": 1';
  if (!Array.isArray(o.steps)) return 'it has no "steps" list';
  const i = o.steps.findIndex(
    (s) =>
      !s || typeof s !== "object" || typeof (s as { actionId?: unknown }).actionId !== "string",
  );
  if (i >= 0) return `step ${i} has no "actionId"`;
  if (!o.coverage || typeof o.coverage !== "object") return 'it has no "coverage"';
  if (typeof o.receiptDigest !== "string") return 'it has no "receiptDigest"';
  return undefined;
}

/** True when nobody edited the receipt after SEAM produced it. False for anything that is not a receipt. */
export function checkReceipt(r: Receipt): boolean {
  if (receiptShapeProblem(r)) return false;
  return receiptDigest(r) === r.receiptDigest;
}

export type ReceiptCheckStatus = "integrity_checked" | "chain_verified" | "unknown" | "failed";

export const INTEGRITY_ONLY_NOTE =
  "integrity only, not on-chain proof: this checks that the receipt was not edited after it was written. Anyone can recompute that digest, so it does not show that any transaction exists. Use live verification (seam verify --endpoint) for that.";

/**
 * Offline check. The only possible answers are `integrity_checked` (the receipt's own digest matches) or `failed`.
 * It can never return `chain_verified`.
 */
export function receiptIntegrity(r: Receipt): {
  status: "integrity_checked" | "failed";
  note: string;
} {
  const shape = receiptShapeProblem(r);
  if (shape) return { status: "failed", note: `This is not a SEAM receipt (${shape}).` };
  const bad = r.steps.find((x) => x.status === "finalized" && (!x.txHash || !x.block));
  if (bad)
    return {
      status: "failed",
      note: `Step ${bad.actionId} is marked finalized but has no transaction hash or block: the receipt is malformed.`,
    };
  return checkReceipt(r)
    ? { status: "integrity_checked", note: INTEGRITY_ONLY_NOTE }
    : {
        status: "failed",
        note: "The receipt does not match its own digest: it was edited after SEAM produced it.",
      };
}
