// Multi-step LIVE, driven by Sentinel's engine:
//  - atomic plan (or a one-step plan): ONE signing request for the single call (the batch_all outer call, or the step's call),
//    one preSign gate + approval, one re-preflight and one checkBeforeSubmit, then submit.
//  - sequential plan with k > 1 steps: one preSign gate binds the approval (envelope nonce n). The engine's
//    checkBeforeSubmit compares ALL signed transactions with the approved calls (step i must carry nonce n + i), so each
//    step is signed in order before the first send. Then for each step i in order: the policy gate runs again on a fresh
//    preflight, re-preflight with the signed bytes, checkBeforeSubmit with sendIndex i and the earlier steps' receipts,
//    mark used, submit, wait for inclusion and finality. Any block or non-final step stops every remaining step.
// Nothing here talks to a wallet itself: sign and submitAndWait are injected (the LivePanel wires the extension signer).
import { usageKey, type ApprovalStore } from "@seam/policy/browser";
import { runPolicyGate, type GateOutcome, type PolicyGateInput } from "./policygate";
import { preSign, preSubmit, type ChainFns, type SigningContext } from "./signflow";

type Send = (method: string, params: unknown[]) => Promise<unknown>;
type Res<T> = { ok: true; value: T } | { ok: false; message: string };

export interface ReceiptStepLike {
  actionId: string;
  status: "finalized" | "included" | "submitted" | "failed" | "not_run" | "uncertain";
  txHash?: string;
  block?: { number: number; hash: string };
  events: string[];
  verification: "verified" | "not_verified" | "unknown";
  reason: string;
}
export interface StepReport {
  index: number;
  actionId: string;
  status: "sent" | "blocked" | "not_run" | "failed";
  message: string;
  receipt?: ReceiptStepLike;
}
export interface MultiStepResult {
  ok: boolean;
  /** How many signing requests went to the wallet. */
  signRequests: number;
  steps: StepReport[];
  /** Index of the step that stopped the run, when one did. */
  stoppedAt?: number;
  gate?: GateOutcome;
  message: string;
}

interface PlanLike {
  mode: string;
  steps: { actionId: string; encodedCall: string | null }[];
  outerCall?: { encodedCall: string };
}

/** The calls to sign: the batch_all outer call for an atomic plan, otherwise each step's call in order. */
export function callsToSignOf(plan: PlanLike): Res<{ actionIds: string[]; callHex: string }[]> {
  if (!plan?.steps?.length) return { ok: false, message: "No compiled plan." };
  if (plan.mode === "unavailable")
    return { ok: false, message: "The plan is unavailable on this runtime." };
  const hex = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-fA-F]+$/.test(x);
  if (plan.mode.startsWith("atomic")) {
    if (!hex(plan.outerCall?.encodedCall))
      return { ok: false, message: "The atomic plan has no encoded batch_all call to sign." };
    return {
      ok: true,
      value: [
        { actionIds: plan.steps.map((s) => s.actionId), callHex: plan.outerCall!.encodedCall },
      ],
    };
  }
  const bad = plan.steps.find((s) => !hex(s.encodedCall));
  if (bad) return { ok: false, message: `Step ${bad.actionId} has no encoded call to sign.` };
  return {
    ok: true,
    value: plan.steps.map((s) => ({ actionIds: [s.actionId], callHex: s.encodedCall! })),
  };
}

export async function runPlanSteps(args: {
  chain: ChainFns;
  send: Send;
  input: PolicyGateInput;
  facts: unknown;
  signer: string;
  ctx: SigningContext;
  now: () => Date;
  store: ApprovalStore;
  freshFingerprint: () => Promise<unknown>;
  /** Asks the wallet to sign one call at the given nonce; returns the signed extrinsic bytes (already binding-checked). */
  sign: (
    i: number,
    call: { actionIds: string[]; callHex: string },
    nonce: number,
  ) => Promise<Res<string>>;
  /** Submits signed bytes and waits for inclusion/finality; returns the receipt step. */
  submitAndWait: (i: number, signedTx: string) => Promise<Res<ReceiptStepLike>>;
  acknowledgedDowngrade?: boolean;
  /** Injectable only for tests; the app always uses the real gates. */
  gates?: {
    preSign: typeof preSign;
    preSubmit: typeof preSubmit;
    policyGate: typeof runPolicyGate;
  };
}): Promise<MultiStepResult> {
  const G = args.gates ?? { preSign, preSubmit, policyGate: runPolicyGate };
  const plan = args.input.plan as PlanLike;
  const calls = callsToSignOf(plan);
  const steps: StepReport[] = (plan?.steps ?? []).map((s, index) => ({
    index,
    actionId: s.actionId,
    status: "not_run",
    message: "Not run.",
  }));
  let signRequests = 0;
  const stop = (i: number, message: string, gate?: GateOutcome): MultiStepResult => {
    const target = steps[i];
    if (target) Object.assign(target, { status: "blocked", message });
    for (const s of steps.slice(i + 1))
      if (s.status === "not_run")
        s.message = `Not run: step ${i + 1} (${target?.actionId ?? "?"}) stopped the plan.`;
    return {
      ok: false,
      signRequests,
      steps,
      stoppedAt: i,
      gate,
      message: `Stopped at step ${i + 1}${target ? ` (${target.actionId})` : ""}: ${message}`,
    };
  };
  if (!calls.ok) return stop(0, calls.message);

  const pre = await G.preSign({
    chain: args.chain,
    send: args.send,
    input: args.input,
    facts: args.facts,
    signer: args.signer,
    ctx: args.ctx,
    now: args.now(),
    acknowledgedDowngrade: args.acknowledgedDowngrade,
  });
  if (!pre.res.ok) return stop(0, pre.res.message, pre.gate);
  const preSigned = pre.res.value;
  const hash = preSigned.approval.hash;

  // Sign every call in order (nonce n + i). One request for an atomic plan.
  const signed: string[] = [];
  for (const [i, c] of calls.value.entries()) {
    signRequests++;
    const s = await args.sign(i, c, args.ctx.nonce + i);
    if (!s.ok) return stop(i, `Signing failed: ${s.message} Nothing was sent.`, pre.gate);
    signed.push(s.value);
  }

  const sequential = plan.mode === "sequential" && calls.value.length > 1;
  const receipts: ReceiptStepLike[] = [];
  for (let i = 0; i < signed.length; i++) {
    if (sequential && i > 0) {
      // The policy gate again, on a fresh preflight, right before this step is sent.
      let pf: unknown;
      try {
        pf = await args.chain.preflight(args.send, args.input.plan, args.facts);
      } catch (e) {
        return stop(
          i,
          `Preflight failed before this step: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const g = G.policyGate(
        { ...args.input, facts: args.input.facts ?? args.facts, preflight: pf },
        { now: args.now(), acknowledgedDowngrade: args.acknowledgedDowngrade },
      );
      if (!g.ok) return stop(i, `Blocked by policy (${g.codes.join(", ")}).`, g);
    }
    const check = await G.preSubmit({
      chain: args.chain,
      send: args.send,
      pre: preSigned,
      facts: args.facts,
      signedTx: signed[i],
      now: args.now(),
      store: args.store,
      freshFingerprint: args.freshFingerprint,
      ...(sequential
        ? { sequential: { signedExtrinsics: signed, sendIndex: i, previousSteps: [...receipts] } }
        : {}),
    });
    if (!check.ok) return stop(i, check.message, pre.gate);
    args.store.markUsed(usageKey(hash as `0x${string}`, sequential ? i : undefined));
    const r = await args.submitAndWait(i, signed[i]);
    if (!r.ok) {
      Object.assign(steps[i], { status: "failed", message: r.message });
      return { ...stop(i, r.message, pre.gate), steps: markFailed(steps, i, r.message) };
    }
    receipts.push(r.value);
    const done = r.value.status === "finalized" && r.value.verification === "verified";
    const forStep = sequential ? [steps[i]] : steps;
    for (const s of forStep)
      Object.assign(s, { status: "sent", message: r.value.reason, receipt: r.value });
    if (sequential && i < signed.length - 1 && !done)
      return stop(
        i + 1,
        `Step ${i + 1} is ${r.value.status} / ${r.value.verification}, not finalized and verified, so later steps were not sent.`,
        pre.gate,
      );
  }
  return {
    ok: true,
    signRequests,
    steps,
    gate: pre.gate,
    message: `All ${signed.length} transaction(s) sent.`,
  };
}

function markFailed(steps: StepReport[], i: number, message: string): StepReport[] {
  steps[i] = { ...steps[i], status: "failed", message };
  return steps;
}
