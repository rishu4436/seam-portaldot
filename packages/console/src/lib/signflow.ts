// Pre-sign and pre-submit gates for the LIVE flow, in the order Sentinel specified:
//   real preflight -> policy gate -> bound approval (engine) -> wallet signs -> preflight again with the signed
//   extrinsic (real dry run) -> checkBeforeSubmit -> submit.
// Everything here is fail closed and read-only on the chain; nothing is invented. All chain/policy functions are
// injected so tests can drive each block without a node.
import {
  checkBeforeSubmit,
  createApproval,
  InMemoryApprovalStore,
  type ApprovalStore,
  type BoundApproval,
} from "@seam/policy/browser";
import { runPolicyGate, type GateOutcome, type PolicyGateInput } from "./policygate";

type Res<T> = { ok: true; value: T } | { ok: false; reason: "unavailable"; message: string };
type Send = (method: string, params: unknown[]) => Promise<unknown>;
type PreflightRes = { steps: { actionId: string; dryRun: string }[]; totalFee?: unknown };

export interface ChainFns {
  preflight(
    send: Send,
    plan: unknown,
    facts: unknown,
    opts?: { signedExtrinsics?: string[] },
  ): Promise<PreflightRes>;
  signedExtrinsicDecoder(facts: unknown): (x: `0x${string}`) => unknown;
  /** Block time from the runtime's own metadata. Without it no signing envelope (expiry) can be built, so it blocks. */
  blockTimeFromFacts?: (facts: unknown) => number | undefined;
}
export interface SigningContext {
  nonce: number;
  mortalityBlocks: number;
  checkpointNumber: number;
  checkpointHash: string;
}
export interface PreSigned {
  gate: GateOutcome;
  approval: BoundApproval;
  approvalInput: Record<string, unknown>;
  preflight: PreflightRes;
}

const no = (message: string): { ok: false; reason: "unavailable"; message: string } => ({
  ok: false,
  reason: "unavailable",
  message,
});
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function loadChainFns(): Promise<ChainFns> {
  return (await import("@seam/chain/browser")) as unknown as ChainFns;
}

/** Real preflight, the authoritative gate, and the engine's bound approval. Runs before the wallet is asked. */
export async function preSign(args: {
  chain: ChainFns;
  send: Send;
  input: PolicyGateInput | undefined;
  facts: unknown;
  signer: string;
  ctx: SigningContext;
  now: Date;
  acknowledgedDowngrade?: boolean;
  gate?: typeof runPolicyGate;
}): Promise<{ gate?: GateOutcome; res: Res<PreSigned> }> {
  const { chain, send, input, facts, ctx, now } = args;
  if (!input?.policy || !input.plan)
    return {
      gate: runPolicyGate(undefined),
      res: no("No policy was provided for this plan, so nothing will be signed."),
    };
  let preflight: PreflightRes;
  try {
    preflight = await chain.preflight(send, input.plan, facts);
  } catch (e) {
    return { res: no(`Preflight failed, so nothing will be signed: ${errMsg(e)}`) };
  }
  const bt = chain.blockTimeFromFacts?.(facts);
  if (!bt)
    return {
      res: no(
        "The block time is not available from the runtime, so the signing window can't be set. Nothing will be signed.",
      ),
    };
  const envelope = {
    signer: args.signer,
    nonce: ctx.nonce,
    mortalityBlocks: ctx.mortalityBlocks,
    checkpoint: { number: ctx.checkpointNumber, hash: ctx.checkpointHash },
    // The era counts from the checkpoint; one block of margin, as the chain adapter does.
    expiresAt: new Date(now.getTime() + (ctx.mortalityBlocks - 1) * bt).toISOString(),
  };
  const gate = (args.gate ?? runPolicyGate)(
    { ...input, facts: input.facts ?? facts, preflight },
    { request: { envelope }, acknowledgedDowngrade: args.acknowledgedDowngrade, now },
  );
  if (!gate.ok)
    return {
      gate,
      res: no(`Blocked by policy before signing (${gate.codes.join(", ")}). Nothing was signed.`),
    };
  const plan = input.plan as { manifestDigest: `0x${string}` };
  const fp = (facts as { fingerprint: unknown }).fingerprint;
  const approvalInput = {
    manifestDigest: plan.manifestDigest,
    plan: input.plan,
    envelope,
    preflight,
    policy: input.policy,
    policyResult: gate.result,
    fingerprint: fp,
    ...(args.acknowledgedDowngrade ? { acknowledgedDowngrade: true } : {}),
  };
  const a = createApproval({ ...approvalInput, now } as never);
  if (!a.ok) return { gate, res: no(`${a.reason} Nothing was signed.`) };
  return {
    gate,
    res: { ok: true, value: { gate, approval: a.approval, approvalInput, preflight } },
  };
}

/** After the wallet signed: real dry run of the signed bytes, fresh fingerprint, then checkBeforeSubmit. */
export async function preSubmit(args: {
  chain: ChainFns;
  send: Send;
  pre: PreSigned;
  facts: unknown;
  freshFingerprint: () => Promise<unknown>;
  signedTx: string;
  now: Date;
  store: ApprovalStore;
}): Promise<Res<{ passed: { code: string; detail: string }[] }>> {
  const { chain, send, pre, facts, signedTx } = args;
  let pf: PreflightRes;
  let current: unknown;
  try {
    pf = await chain.preflight(send, pre.approvalInput.plan, facts, {
      signedExtrinsics: [signedTx],
    });
    current = await args.freshFingerprint();
  } catch (e) {
    return no(`Could not re-check the signed transaction, so it was not sent: ${errMsg(e)}`);
  }
  if (!current) return no("Could not re-read the runtime before submit, so nothing was sent.");
  const plan = pre.approvalInput.plan as { mode?: string };
  let check: ReturnType<typeof checkBeforeSubmit>;
  try {
    check = checkBeforeSubmit({
      ...(pre.approvalInput as object),
      approval: pre.approval,
      preparedFingerprint: (facts as { fingerprint: unknown }).fingerprint,
      currentFingerprint: current,
      signedCalls: [],
      signedExtrinsics: [signedTx],
      decodeSignedExtrinsic: chain.signedExtrinsicDecoder(facts),
      requireTrustedDecoder: true,
      signedDryRun: pf.steps.map((s) => s.dryRun),
      ...(plan.mode === "sequential" ? { sendIndex: 0, previousSteps: [] } : {}),
      now: args.now,
      store: args.store,
    } as never);
  } catch (e) {
    return no(`The submit gate failed, so nothing was sent: ${errMsg(e)}`);
  }
  if (!check.ok)
    return no(
      `Blocked at submit (${check.reasons.map((r) => r.code).join(", ")}): ${check.reasons.map((r) => r.message).join(" ")} Nothing was sent.`,
    );
  return { ok: true, value: { passed: check.passed } };
}

export const newApprovalStore = (): ApprovalStore => new InMemoryApprovalStore();

/**
 * The demo's Approve decision from the real engine: reads live facts and the real preflight (read-only), then runs the
 * authoritative gate. The console's own pre-check is display only. Signing re-runs everything with a fresh envelope.
 */
export async function engineApprovalCheck(args: {
  chain: ChainFns;
  send: Send;
  readFacts: () => Promise<unknown>;
  input: PolicyGateInput;
  now: Date;
  gate?: typeof runPolicyGate;
}): Promise<GateOutcome> {
  try {
    const facts = await args.readFacts();
    if (!facts)
      return {
        ok: false,
        codes: ["FACTS_UNAVAILABLE"],
        explanations: [],
        message: "Live runtime facts could not be read, so the plan can't be approved.",
      };
    const preflight = await args.chain.preflight(args.send, args.input.plan, facts);
    return (args.gate ?? runPolicyGate)({ ...args.input, facts, preflight }, { now: args.now });
  } catch (e) {
    return {
      ok: false,
      codes: ["APPROVAL_CHECK_FAILED"],
      explanations: [],
      message: `The policy check could not run, so the plan can't be approved: ${errMsg(e)}`,
    };
  }
}
