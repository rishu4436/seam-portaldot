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
import { readyOrStop, type SignerWatch } from "./walletwatch";
import { runPolicyGate, type GateOutcome, type PolicyGateInput } from "./policygate";
import type { StepOutcome } from "@seam/sdk/browser";
import { atomicStepReceipts, callOfSigned, verifyPlanStep } from "./stepverify";
import type { RunStore } from "./runstore";
import {
  blockCodeText,
  type LiveCompile,
  type LiveReads,
  preSign,
  preSubmit,
  type ChainFns,
  type BlockDetail,
  type FreshRead,
  type RuntimeLockInfo,
  type SigningContext,
} from "./signflow";

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
  /** The send order (0-based) when this step's transaction was broadcast; absent when it was never sent. */
  sendIndex?: number;
  /** The read-back outcome (status, txHash, block, decoded events, extrinsicIndex); never signed bytes. */
  outcome?: StepOutcome & { extrinsicIndex?: number };
  /** How the submit gate's runtime lock passed for this step (policy result); absent when the gate didn't pass. */
  runtimeLock?: RuntimeLockInfo;
  /** Why the submit gate blocked this step (signed dry run), as reported; absent otherwise. */
  blockDetail?: BlockDetail;
  /**
   * Nonce this step's transaction was actually signed with: the trusted decoder's reading of the signed bytes when
   * available ("decoded"), else the nonce in the signing request sent to the wallet ("signing_request"). Absent when
   * never signed. Receipt metadata only: never part of approvalInputs or the plan digest.
   */
  nonce?: number;
  nonceSource?: "decoded" | "signing_request";
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
  /**
   * The ONE engine approval (preSign's createApproval) binding the whole plan, with every input createApproval took
   * plus its `now`, so the hash can be recomputed. Absent when preSign did not approve.
   */
  approval?: { hash: string; inputs: Record<string, unknown> & { now: string } };
  /** The compiled plan the run used (no signed bytes). */
  plan?: unknown;
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

export async function runPlanSteps(a0: RunPlanArgs): Promise<MultiStepResult> {
  if (!a0.live) return runPlanStepsInner(a0);
  // Live V3: the plan is compiled fresh from the Manifest on the live facts; a stored plan is never signed.
  let fresh: unknown;
  try {
    fresh = a0.live.compile(a0.live.manifest, a0.facts);
  } catch (e) {
    return {
      ok: false,
      signRequests: 0,
      steps: [],
      stoppedAt: 0,
      message: `Stopped at step 1: ${blockCodeText("LIVE_COMPILE_FAILED")} (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const stored = (a0.input.plan as { planDigest?: string } | undefined)?.planDigest;
  if (a0.input.plan !== undefined && stored !== (fresh as { planDigest?: string }).planDigest)
    return {
      ok: false,
      signRequests: 0,
      steps: [],
      stoppedAt: 0,
      message: `Stopped at step 1: ${blockCodeText("STORED_PLAN_REFUSED")} Nothing was signed.`,
    };
  return runPlanStepsInner({
    ...a0,
    input: { ...a0.input, plan: fresh, manifest: a0.live.manifest, facts: a0.facts },
  });
}

export interface RunPlanArgs {
  /**
   * Wallet watch (Chainsmith's watchSigner): assertReadyToSign runs before each step's signPayload and again before each
   * submit. Not ready: the run stops and nothing is broadcast. The caller stops the watch.
   */
  watch?: Pick<SignerWatch, "assertReadyToSign">;
  /** Live V3: compile fresh from the Manifest (never a stored plan) and run the gates in live mode. */
  live?: LiveCompile & LiveReads;
  chain: ChainFns;
  send: Send;
  input: PolicyGateInput;
  facts: unknown;
  signer: string;
  ctx: SigningContext;
  now: () => Date;
  store: ApprovalStore;
  freshFingerprint: () => Promise<FreshRead | undefined>;
  /** Asks the wallet to sign one call at the given nonce; returns the signed extrinsic bytes (already binding-checked). */
  sign: (
    i: number,
    call: { actionIds: string[]; callHex: string },
    nonce: number,
  ) => Promise<Res<string>>;
  /**
   * Submits signed bytes, waits for inclusion/finality and reads the extrinsic's events back; returns the SDK
   * StepOutcome (status, txHash, block, events). Verification is NOT decided here.
   */
  submitAndWait: (i: number, signedTx: string) => Promise<Res<StepOutcome>>;
  /**
   * Decides a step's verification. Default: Quill's verifyStep (@seam/sdk/browser) with the V3 runtime facts and the
   * call decoded from the in-memory signed bytes. Only "verified" lets the next step run.
   */
  verifyOutcome?: (i: number, outcome: StepOutcome, callHex: string | undefined) => ReceiptStepLike;
  acknowledgedDowngrade?: boolean;
  /** Holds the signed bytes in memory for this run only. Injectable so tests can check it is emptied. */
  holder?: SignedHolder;
  /** Aborted when the run is cancelled or the panel unmounts: nothing more is sent and the bytes are dropped. */
  signal?: AbortSignal;
  /**
   * Persisted non-secret run state (lib/runstore.ts): phase, step statuses, tx hashes, nonces, blocks and the
   * single-flight send guard keyed by approvalHash + step index. Optional; never receives signed bytes.
   */
  runStore?: RunStore;
  /** Injectable only for tests; the app always uses the real gates. */
  gates?: {
    preSign: typeof preSign;
    preSubmit: typeof preSubmit;
    policyGate: typeof runPolicyGate;
  };
}

async function runPlanStepsInner(args: RunPlanArgs): Promise<MultiStepResult> {
  const G = args.gates ?? { preSign, preSubmit, policyGate: runPolicyGate };
  const runtime = (args.facts as { fingerprint?: { specName?: string; specVersion?: number } })
    ?.fingerprint;
  const signerAccountId = (args.input.plan as { signer?: { publicKey?: string } })?.signer
    ?.publicKey;
  const verify =
    args.verifyOutcome ??
    ((i: number, o: StepOutcome, callHex: string | undefined): ReceiptStepLike => {
      const atomic = (args.input.plan as PlanLike).mode.startsWith("atomic");
      const step = (args.input.plan as { steps: unknown[] }).steps[i];
      // Atomic: one batch outcome; per-step-of-batch verification isn't available here, so it stays unknown.
      if (atomic || !step || !signerAccountId)
        return {
          actionId: o.actionId,
          status: o.status as ReceiptStepLike["status"],
          ...(o.txHash ? { txHash: o.txHash } : {}),
          ...(o.block ? { block: o.block } : {}),
          events: [],
          verification: "unknown",
          reason: atomic
            ? "Atomic batch: per-step verification of the batch is not available in the console."
            : "No plan step or signer account to verify against.",
        };
      return verifyPlanStep(step, signerAccountId, o, runtime, callHex) as ReceiptStepLike;
    });
  const plan = args.input.plan as PlanLike;
  const calls = callsToSignOf(plan);
  const steps: StepReport[] = (plan?.steps ?? []).map((s, index) => ({
    index,
    actionId: s.actionId,
    status: "not_run",
    message: "Not run.",
  }));
  let signRequests = 0;
  // Set once preSign approves; stop() reports it from then on.
  const bound: { approval?: MultiStepResult["approval"] } = {};
  const holder = args.holder ?? new SignedHolder();
  // Every exit drops the signed bytes. Messages never carry them (redact covers any echo from a node or wallet).
  const stop = (
    i: number,
    message: string,
    gate?: GateOutcome,
    status: "blocked" | "failed" = "blocked",
  ): MultiStepResult => {
    const msg = holder.redact(message);
    holder.clear();
    const target = steps[i];
    if (target) Object.assign(target, { status, message: msg });
    if (bound.approval && args.runStore) {
      const rs = args.runStore;
      const h = bound.approval.hash;
      for (const s of steps) {
        const cur = rs.run(h)?.steps.find((x) => x.index === s.index);
        // Never downgrade a step that has a tx hash; an unsent signed step can't be resumed (bytes are dropped).
        if (cur?.txHash) continue;
        rs.updateStep(h, s.index, {
          status: s === target ? status : "not_sent",
          note: s === target ? msg.slice(0, 300) : "not sent",
        });
      }
      rs.updateStep(h, i, {}, status);
    }
    for (const s of steps.slice(i + 1))
      if (s.status === "not_run")
        s.message = `Not run: step ${i + 1} (${target?.actionId ?? "?"}) stopped the plan.`;
    return {
      ok: false,
      signRequests,
      steps,
      stoppedAt: i,
      gate,
      ...(bound.approval ? { approval: bound.approval } : {}),
      plan: args.input.plan,
      message: `Stopped at step ${i + 1}${target ? ` (${target.actionId})` : ""}: ${msg}`,
    };
  };
  const cancelled = () => args.signal?.aborted === true;
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
    ...(args.live ? { live: { manifest: args.live.manifest, compile: args.live.compile } } : {}),
  });
  if (!pre.res.ok) return stop(0, pre.res.message, pre.gate);
  const preSigned = pre.res.value;
  const hash = preSigned.approval.hash;
  bound.approval = {
    hash,
    inputs: {
      ...(preSigned.approvalInput as Record<string, unknown>),
      now: preSigned.approvedAt,
    },
  };
  args.runStore?.upsertRun({
    approvalHash: hash,
    planDigest: (args.input.plan as { planDigest?: string }).planDigest,
    mode: plan.mode,
    phase: "approved",
    fromBlock: args.ctx.checkpointNumber,
    steps: steps.map((s) => ({
      index: s.index,
      actionId: s.actionId,
      status: "pending",
      updatedAt: new Date().toISOString(),
    })),
  });
  // ONE envelope for the whole plan (Chainsmith's buildSigningEnvelope in preSign): same checkpoint and short mortality
  // for every step; only the nonce moves (n + i). Its expiresAt is checked again before every send.
  const expiresAt = Date.parse(
    String((preSigned.approvalInput?.envelope as { expiresAt?: string } | undefined)?.expiresAt),
  );
  const expired = () => Number.isNaN(expiresAt) || args.now().getTime() >= expiresAt;
  const expiredMsg =
    "SIGNING_WINDOW_EXPIRED: the signing window of this plan's envelope has passed, so nothing more is sent. Approve again.";

  // Sign every call in order (nonce n + i). One request for an atomic plan.
  for (const [i, c] of calls.value.entries()) {
    if (cancelled()) return stop(i, "Cancelled. Nothing more was signed or sent.");
    if (args.watch) {
      const w = await readyOrStop(args.watch, "sign");
      if (!w.ok) return stop(i, w.message, pre.gate);
    }
    signRequests++;
    const requested = args.ctx.nonce + i;
    const s = await args.sign(i, c, requested);
    if (!s.ok) return stop(i, `Signing failed: ${s.message} Nothing was sent.`, pre.gate);
    holder.put(i, s.value);
    let decodedNonce: unknown;
    try {
      const dec = args.chain.signedExtrinsicDecoder?.(args.facts) as
        ((x: `0x${string}`) => { nonce?: unknown } | null) | undefined;
      decodedNonce = dec?.(s.value as `0x${string}`)?.nonce;
    } catch {
      decodedNonce = undefined;
    }
    const signedNonce = Number.isSafeInteger(decodedNonce)
      ? { nonce: decodedNonce as number, nonceSource: "decoded" as const }
      : { nonce: requested, nonceSource: "signing_request" as const };
    for (const st of steps)
      if (c.actionIds.includes(st.actionId)) {
        Object.assign(st, signedNonce);
        args.runStore?.updateStep(
          hash,
          st.index,
          { status: "signed", nonce: signedNonce.nonce },
          "signed",
        );
      }
  }

  const n = calls.value.length;
  const sequential = plan.mode === "sequential" && n > 1;
  const receipts: ReceiptStepLike[] = [];
  for (let i = 0; i < n; i++) {
    if (cancelled()) return stop(i, "Cancelled. Nothing more was sent.");
    if (expired()) return stop(i, expiredMsg, pre.gate);
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
        {
          now: args.now(),
          acknowledgedDowngrade: args.acknowledgedDowngrade,
          request: { envelope: preSigned.approvalInput.envelope },
        },
      );
      if (!g.ok) return stop(i, `Blocked by policy (${g.codes.join(", ")}).`, g);
    }
    const all = holder.all();
    if (!all) return stop(i, "The signed bytes are gone, so nothing more is sent.");
    const check = await G.preSubmit({
      chain: args.chain,
      send: args.send,
      pre: preSigned,
      facts: args.facts,
      signedTx: all[i],
      now: args.now(),
      store: args.store,
      freshFingerprint: args.freshFingerprint,
      ...(args.live ? { liveReads: args.live } : {}),
      ...(sequential
        ? { sequential: { signedExtrinsics: all, sendIndex: i, previousSteps: [...receipts] } }
        : {}),
    });
    if (!check.ok) {
      const bd = (check as { blockDetail?: BlockDetail }).blockDetail;
      const r = stop(i, check.message, pre.gate);
      const st = r.steps.find((x) => x.index === i);
      if (bd && st) st.blockDetail = bd;
      return r;
    }
    if (check.value.runtimeLock) steps[i]!.runtimeLock = check.value.runtimeLock;
    // Last look right before broadcasting: the window, and a cancel during the checks.
    if (cancelled()) return stop(i, "Cancelled. Nothing more was sent.");
    if (expired()) return stop(i, expiredMsg, pre.gate);
    // Single-flight guard (persisted before the broadcast): a step claimed once, in any session, is never sent again.
    if (args.runStore && !args.runStore.claimSend(hash, i))
      return stop(
        i,
        "This step was already sent once (persisted send guard). It is not sent again; reconcile by its tx hash.",
        pre.gate,
      );
    args.runStore?.updateStep(hash, i, { status: "submitting" }, "submitting");
    if (args.watch) {
      const w = await readyOrStop(args.watch, "submit");
      if (!w.ok) return stop(i, w.message, pre.gate);
    }
    args.store.markUsed(usageKey(hash as `0x${string}`, sequential ? i : undefined));
    const r = await args.submitAndWait(i, all[i]);
    if (r.ok && args.runStore) {
      const o = r.value as {
        txHash?: string;
        status?: string;
        block?: { number: number; hash: string };
      };
      const idxs = sequential ? [i] : steps.map((s) => s.index);
      for (const k of idxs) {
        if (o.txHash) args.runStore.recordSent(hash, k, o.txHash);
        args.runStore.updateStep(
          hash,
          k,
          {
            status:
              o.status === "finalized"
                ? "finalized"
                : o.status === "failed"
                  ? "failed"
                  : "submitted",
            ...(o.block ? { block: o.block } : {}),
          },
          o.status === "finalized" && (!sequential || i === n - 1) ? "finalized" : "submitted",
        );
      }
    }
    if (!r.ok) {
      steps[i]!.sendIndex = i;
      return stop(i, r.message, pre.gate, "failed");
    }
    let callHex: string | undefined;
    try {
      callHex = callOfSigned(args.chain.signedExtrinsicDecoder?.(args.facts) as never, all[i]);
    } catch {
      callHex = undefined;
    }
    const verified = verify(i, r.value, callHex);
    const receipt = { ...verified, reason: holder.redact(verified.reason) };
    receipts.push(receipt);
    const done = receipt.status === "finalized" && receipt.verification === "verified";
    const atomic = plan.mode.startsWith("atomic");
    if (atomic && !args.verifyOutcome && signerAccountId) {
      // Atomic: Quill's perStepOfBatch splits the one batch outcome into per-step outcomes (each step's call is a
      // verified slice of the signed batch call); verifyStep then checks each step. Labelled per-step verified.
      const per = atomicStepReceipts(args.input.plan, r.value, callHex, signerAccountId, runtime);
      for (const s of steps) {
        const pr = per.find((x) => x.actionId === s.actionId);
        const rr = pr
          ? {
              ...pr,
              reason: holder.redact(`per-step verified from the batch outcome: ${pr.reason}`),
            }
          : receipt;
        Object.assign(s, {
          status: rr.status === "failed" ? "failed" : "sent",
          message: rr.reason,
          receipt: rr,
        });
      }
    } else {
      const forStep = sequential ? [steps[i]] : steps;
      for (const s of forStep)
        Object.assign(s, {
          status: receipt.status === "failed" ? "failed" : "sent",
          message: receipt.reason,
          receipt,
          sendIndex: i,
          // Read-back data only, with any echo of the signed bytes redacted.
          outcome: JSON.parse(holder.redact(JSON.stringify(r.value))),
        });
    }
    callHex = undefined;
    if (sequential && i < n - 1 && !done)
      return stop(
        i + 1,
        `Step ${i + 1} is ${receipt.status} / ${receipt.verification}, not finalized and verified, so later steps were not sent.`,
        pre.gate,
      );
  }
  holder.clear();
  return {
    ok: true,
    signRequests,
    steps,
    gate: pre.gate,
    approval: bound.approval,
    plan: args.input.plan,
    message: `All ${n} transaction(s) sent.`,
  };
}

/**
 * Signed extrinsic bytes for one run, in memory only: never logged, persisted, exported or shown. clear() overwrites
 * every slot and empties the list. They are kept until the run ends because checkBeforeSubmit for step i needs every
 * signed transaction of the plan; any stop, failure, cancel or the end of the run clears them. redact() removes them from any text.
 */
export class SignedHolder {
  #slots: (string | undefined)[] = [];
  #seen: string[] = [];
  put(i: number, signed: string) {
    this.#slots[i] = signed;
    this.#seen.push(signed);
  }
  /** All slots, or undefined when any is gone (a later step can't be checked without every signed transaction). */
  all(): string[] | undefined {
    const s = this.#slots;
    return s.length && s.every((x) => typeof x === "string") ? [...(s as string[])] : undefined;
  }
  clear() {
    this.#slots.fill(undefined);
    this.#slots.length = 0;
    this.#seen.fill("");
    this.#seen.length = 0;
  }
  get size() {
    return this.#slots.filter((x) => x !== undefined).length;
  }
  redact(text: string): string {
    let t = text;
    for (const s of this.#seen) if (s) t = t.split(s).join("[signed bytes]");
    return t.replace(/0x[0-9a-fA-F]{200,}/g, "[signed bytes]");
  }
}
