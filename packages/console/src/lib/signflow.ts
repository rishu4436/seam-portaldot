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
  type LockResult,
} from "@seam/policy/browser";
import { runPolicyGate, type GateOutcome, type PolicyGateInput } from "./policygate";

type Res<T> = { ok: true; value: T } | { ok: false; reason: "unavailable"; message: string };
type Send = (method: string, params: unknown[]) => Promise<unknown>;
type PreflightRes = { steps: { actionId: string; dryRun: string }[]; totalFee?: unknown };

/** One signed transaction's system_dryRun as @seam/chain's preflightReport returns it (transactions[i].dryRun). */
export interface ChainDryRun {
  outcome: "ok" | "failed" | "unknown";
  detail: string;
}
type PreflightReportRes = {
  result: PreflightRes;
  atBlock?: { number: number; hash: string };
  transactions?: { dryRun?: ChainDryRun }[];
};

/**
 * Why the submit gate blocked on the signed dry run, exactly as reported. checkBeforeSubmit (@seam/policy) only gives
 * the code; the dry-run outcome and detail string and the block it ran at come from @seam/chain's preflightReport.
 * No signed bytes, no metadata. dryRun / dryRunAt are absent when the chain did not report them.
 */
export interface BlockDetail {
  code: string;
  /** transactions[sendIndex].dryRun, unchanged. */
  dryRun?: ChainDryRun;
  /** preflightReport.atBlock: the block the dry run ran at. */
  dryRunAt?: { number: number; hash: string };
  source: string;
}

export const NO_DETAIL = "no detail reported by the gate";

/** Plain sentence for the block message and panels. Never guesses a cause. */
export function blockDetailText(d: BlockDetail | undefined): string | undefined {
  if (!d) return undefined;
  if (!d.dryRun) return `Dry-run detail: ${NO_DETAIL}.`;
  const at = d.dryRunAt
    ? ` (dry run at block #${d.dryRunAt.number}, ${d.dryRunAt.hash.slice(0, 10)}…)`
    : "";
  return `Dry-run detail: ${d.dryRun.outcome}, ${d.dryRun.detail}${at}.`;
}

export interface ChainFns {
  /** @seam/chain/browser preflightReport: same preflight plus per-transaction dry-run detail and the block. Optional. */
  preflightReport?(
    send: Send,
    plan: unknown,
    facts: unknown,
    opts?: { signedExtrinsics?: string[] },
  ): Promise<PreflightReportRes>;
  preflight(
    send: Send,
    plan: unknown,
    facts: unknown,
    opts?: { signedExtrinsics?: string[] },
  ): Promise<PreflightRes>;
  /**
   * Chainsmith's decoder (needs 239974f). The context (the approved envelope's checkpoint, or the signing requests) is
   * required to check a signature: the era block hash is not inside the extrinsic, so with no context every signature
   * reads as invalid (the LIVE fc91363 signed_signature_invalid bug).
   */
  signedExtrinsicDecoder(facts: unknown, context?: unknown): (x: `0x${string}`) => unknown;
  /** Block time from the runtime's own metadata (Chainsmith, @seam/chain/browser). */
  blockTimeFromFacts?: (facts: unknown) => number | undefined;
  /**
   * Chainsmith's buildSigningEnvelope from @seam/chain/browser. Throws NODE_MISSING_VALUE when the block time or any
   * input is unknown; that blocks before signing. Missing entirely also blocks.
   */
  buildSigningEnvelope?: (i: {
    signer: string;
    nonce: number;
    checkpoint: { number: number; hash: string };
    mortalityBlocks: number;
    now: Date;
    facts: unknown;
  }) => {
    signer: string;
    nonce: number;
    mortalityBlocks: number;
    checkpoint: { number: number; hash: string };
    expiresAt: string;
  };
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
  /** The `now` createApproval was called with (ISO); with approvalInput it reproduces approval.hash. */
  approvedAt: string;
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
  if (!chain.buildSigningEnvelope)
    return { res: no("The signing envelope builder is not available, so nothing will be signed.") };
  let envelope: ReturnType<NonNullable<ChainFns["buildSigningEnvelope"]>>;
  try {
    envelope = chain.buildSigningEnvelope({
      signer: args.signer,
      nonce: ctx.nonce,
      checkpoint: { number: ctx.checkpointNumber, hash: ctx.checkpointHash },
      mortalityBlocks: ctx.mortalityBlocks,
      now,
      facts,
    });
  } catch (e) {
    const code = (e as { code?: string })?.code;
    return {
      res: no(
        `The signing window can't be set (${code ?? "error"}: ${errMsg(e)}), for example because the block time is unknown. Nothing will be signed.`,
      ),
    };
  }
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
    res: {
      ok: true,
      value: {
        gate,
        approval: a.approval,
        approvalInput,
        approvedAt: now.toISOString(),
        preflight,
      },
    },
  };
}

/**
 * The submit gate's runtime lock exactly as checkBeforeSubmit returned it (@seam/policy LockResult: ok, code, lockBasis,
 * both raw and both layout hashes when computed). Never carries metadata bytes.
 */
export type RuntimeLockInfo = LockResult;

/** What freshFingerprint returns: the fresh fingerprint plus the raw metadata from the same read (memory only). */
export interface FreshRead {
  fingerprint: unknown;
  metadataHex?: string;
}

/** After the wallet signed: real dry run of the signed bytes, fresh fingerprint, then checkBeforeSubmit. */
export async function preSubmit(args: {
  chain: ChainFns;
  send: Send;
  pre: PreSigned;
  facts: unknown;
  /** Fresh fingerprint and raw metadata, read right before submit. metadataHex stays in memory only. */
  freshFingerprint: () => Promise<FreshRead | undefined>;
  signedTx: string;
  now: Date;
  store: ApprovalStore;
  /**
   * Sequential plans: every step's signed bytes (the engine compares all of them with the approved calls, nonce n+i),
   * the index being sent, and the receipts of the earlier steps. Atomic / single-call plans leave these out.
   */
  sequential?: { signedExtrinsics: string[]; sendIndex: number; previousSteps: unknown[] };
}): Promise<
  | {
      ok: true;
      value: { passed: { code: string; detail: string }[]; runtimeLock?: RuntimeLockInfo };
    }
  | { ok: false; reason: "unavailable"; message: string; blockDetail?: BlockDetail }
> {
  const { chain, send, pre, facts, signedTx } = args;
  const all = args.sequential?.signedExtrinsics ?? [signedTx];
  let pf: PreflightRes;
  let report: PreflightReportRes | undefined;
  let current: unknown;
  let currentMetadataHex: string | undefined;
  try {
    // preflightReport runs the same preflight; its .result is exactly what preflight returns, so the gate is unchanged.
    if (chain.preflightReport) {
      report = await chain.preflightReport(send, pre.approvalInput.plan, facts, {
        signedExtrinsics: all,
      });
      pf = report.result;
    } else
      pf = await chain.preflight(send, pre.approvalInput.plan, facts, {
        signedExtrinsics: all,
      });
    const fresh = await args.freshFingerprint();
    current = fresh?.fingerprint;
    currentMetadataHex = fresh?.metadataHex;
  } catch (e) {
    return no(`Could not re-check the signed transaction, so it was not sent: ${errMsg(e)}`);
  }
  if (!current) return no("Could not re-read the runtime before submit, so nothing was sent.");
  const plan = pre.approvalInput.plan as { mode?: string };
  const atomicPlan = !!plan.mode?.startsWith("atomic");
  const preparedFingerprint = (facts as { fingerprint: unknown }).fingerprint;
  const preparedMetadataHex = (facts as { source?: { metadataHex?: string } })?.source?.metadataHex;
  let check: ReturnType<typeof checkBeforeSubmit>;
  try {
    check = checkBeforeSubmit({
      ...(pre.approvalInput as object),
      approval: pre.approval,
      preparedFingerprint,
      currentFingerprint: current,
      // The gate recomputes raw and layout hashes from both blobs itself; it never trusts a supplied layout hash.
      // CheckMetadataHash mode comes only from the trusted decoder; the console never supplies or fakes it.
      preparedMetadataHex,
      currentMetadataHex,
      signedCalls: [],
      signedExtrinsics: all,
      decodeSignedExtrinsic: chain.signedExtrinsicDecoder(facts, pre.approvalInput.envelope),
      requireTrustedDecoder: true,
      // Atomic: ONE signed batch_all, so ONE dry run: the chain's per-transaction outcome. Its per-step dryRun stays
      // "unknown" for atomic plans (chain preflight-core), and there is one entry per plan step, not per transaction.
      signedDryRun:
        atomicPlan && report?.transactions?.length
          ? report.transactions.map((t) => t.dryRun?.outcome ?? "unknown")
          : pf.steps.map((s) => s.dryRun),
      ...(plan.mode === "sequential"
        ? {
            sendIndex: args.sequential?.sendIndex ?? 0,
            previousSteps: args.sequential?.previousSteps ?? [],
          }
        : {}),
      now: args.now,
      store: args.store,
    } as never);
  } catch (e) {
    return no(`The submit gate failed, so nothing was sent: ${errMsg(e)}`);
  }
  if (!check.ok) {
    const dryCode = check.reasons.find((r) => r.code.startsWith("signed_dry_run_"))?.code;
    let blockDetail: BlockDetail | undefined;
    if (dryCode) {
      const tx = report?.transactions?.[args.sequential?.sendIndex ?? 0];
      blockDetail = {
        code: dryCode,
        ...(tx?.dryRun ? { dryRun: { outcome: tx.dryRun.outcome, detail: tx.dryRun.detail } } : {}),
        ...(tx?.dryRun && report?.atBlock
          ? { dryRunAt: { number: report.atBlock.number, hash: report.atBlock.hash } }
          : {}),
        source: tx?.dryRun
          ? "@seam/chain preflightReport transactions[i].dryRun (checkBeforeSubmit reports only the code)"
          : "checkBeforeSubmit reports only the code; @seam/chain reported no dry-run detail",
      };
    }
    const extra = blockDetail ? ` ${blockDetailText(blockDetail)}` : "";
    return {
      ...no(
        `Blocked at submit (${check.reasons.map((r) => r.code).join(", ")}): ${check.reasons.map((r) => r.message).join(" ")} Nothing was sent.${extra}`,
      ),
      ...(blockDetail ? { blockDetail } : {}),
    };
  }
  // Recorded exactly as the gate returned it; the console computes nothing about the lock itself.
  return { ok: true, value: { passed: check.passed, runtimeLock: check.runtimeLock } };
}

/** Plain sentence for the panels; hashes shortened. */
export function lockBasisText(l: RuntimeLockInfo | undefined): string | undefined {
  if (!l) return undefined;
  if (l.lockBasis === "raw")
    return "Runtime lock passed: the runtime is unchanged since the plan was prepared.";
  if (l.lockBasis !== "layout_hash") return undefined;
  const sh = (h?: string) => (h ? `${h.slice(0, 10)}…` : "unknown");
  return `Runtime lock passed on the layout hash: only the raw metadata hash changed (${sh(l.preparedMetadataHash)} -> ${sh(l.currentMetadataHash)}).`;
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
