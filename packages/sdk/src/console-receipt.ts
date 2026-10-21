// Re-verification of receipts written by the SEAM console (receiptKind "seam/console-live-receipt/v1"), single-step and
// sequential. Console receipts are not SDK `Receipt`s (no receiptVersion, no receiptDigest), so they get their own checks.
// Nothing here trusts a field of the receipt: every claim is recomputed (plan digest, approval hash) or re-read from the
// chain (block, tx, signer, call, nonce, events, fee). A field that is absent is reported as `not_checked`, never as a pass.
import { computePlanDigest, type Hex, type Plan, type PlanStep } from "@seam/compiler";
import { createApproval, policyDigest } from "@seam/policy";
import { verifyStep, type ChainEvent } from "./receipt.js";
import type { ReceiptChainReader } from "./verify-live.js";

export const CONSOLE_RECEIPT_KIND_PREFIX = "seam/console-live-receipt/";

export type CheckStatus = "pass" | "fail" | "not_checked" | "unknown";
export interface ConsoleCheck {
  check: string;
  status: CheckStatus;
  detail: string;
  /** Set on a step-level check. */
  actionId?: string;
}

export interface ConsoleReceiptStep {
  index?: number;
  actionId: string;
  sent?: boolean;
  sendIndex?: number;
  status?: string;
  txHash?: string;
  block?: { number?: number; hash?: string };
  extrinsicIndex?: number;
  fee?: string;
  nonce?: number;
  nonceSource?: string;
  verification?: string;
}

export interface ConsoleReceipt {
  receiptKind: string;
  mode?: string;
  result?: string;
  planDigest?: string;
  manifestDigest?: string;
  fingerprintDigest?: string;
  approvalHash?: string;
  approvalInputs?: Record<string, unknown> & { now?: string; envelope?: { nonce?: number } };
  plan?: Plan;
  steps?: ConsoleReceiptStep[];
  txHash?: string;
  block?: { number?: number; hash?: string };
  signer?: string;
  fee?: string;
  policyDigest?: string;
  [k: string]: unknown;
}

export interface ConsoleVerification {
  /** Offline: `integrity_checked` (no check failed) or `failed`. Live: `chain_verified`, `unknown` or `failed`. */
  status: "integrity_checked" | "chain_verified" | "unknown" | "failed";
  /** What the receipt itself claims; never re-used as proof. */
  claimedResult: string | undefined;
  kind: "single" | "sequential";
  checks: ConsoleCheck[];
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const lc = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function isConsoleReceipt(d: unknown): d is ConsoleReceipt {
  return (
    isObj(d) &&
    typeof d.receiptKind === "string" &&
    d.receiptKind.startsWith(CONSOLE_RECEIPT_KIND_PREFIX)
  );
}

/** The steps a console receipt claims, normalised: a single-step receipt's top-level tx becomes step 0. */
export function consoleSteps(r: ConsoleReceipt): ConsoleReceiptStep[] {
  if (Array.isArray(r.steps) && r.steps.length) {
    return r.steps.map((s, i) => ({
      ...s,
      sent: s.sent ?? (typeof s.txHash === "string" ? true : undefined),
      sendIndex: s.sendIndex ?? (r.mode === "sequential" ? undefined : i),
    }));
  }
  if (typeof r.txHash === "string")
    return [
      {
        actionId: r.plan?.steps?.[0]?.actionId ?? "step1",
        sent: true,
        sendIndex: 0,
        txHash: r.txHash,
        block: r.block,
        fee: r.fee,
      },
    ];
  return [];
}

function kindOf(r: ConsoleReceipt): "single" | "sequential" {
  return r.mode === "sequential" ? "sequential" : "single";
}

/**
 * Offline checks of a console receipt: shape, plan digest, approval hash (re-run `createApproval` on `approvalInputs`),
 * the binding between them, and per-step nonce claims. It proves the file is self-consistent, not that anything happened
 * on chain; that needs `verifyConsoleReceiptLive`.
 */
export function verifyConsoleReceiptOffline(r: ConsoleReceipt): ConsoleVerification {
  const checks: ConsoleCheck[] = [];
  const add = (check: string, status: CheckStatus, detail: string, actionId?: string) =>
    checks.push(actionId ? { check, status, detail, actionId } : { check, status, detail });

  // 1. Plan digest, recomputed from the plan in the receipt.
  const plan = isObj(r.plan) ? (r.plan as Plan) : undefined;
  if (!plan)
    add(
      "plan_digest",
      "not_checked",
      "the receipt carries no plan, so the plan digest cannot be recomputed",
    );
  else {
    let d: string | undefined;
    try {
      d = computePlanDigest(plan);
    } catch (e) {
      add("plan_digest", "fail", `the plan cannot be digested: ${(e as Error).message}`);
    }
    if (d !== undefined) {
      if (lc(d) !== lc(plan.planDigest))
        add("plan_digest", "fail", `plan.planDigest ${plan.planDigest} != recomputed ${d}`);
      else if (lc(d) !== lc(r.planDigest))
        add("plan_digest", "fail", `receipt planDigest ${r.planDigest} != recomputed ${d}`);
      else add("plan_digest", "pass", `recomputed ${d}, equal to the receipt's`);
    }
    if (r.fingerprintDigest === undefined)
      add("fingerprint_digest", "not_checked", "no fingerprintDigest in the receipt");
    else if (lc(plan.fingerprintDigest) !== lc(r.fingerprintDigest))
      add(
        "fingerprint_digest",
        "fail",
        `receipt ${r.fingerprintDigest} != plan ${plan.fingerprintDigest}`,
      );
    else add("fingerprint_digest", "pass", "equal to the plan's fingerprintDigest");
  }

  // 2. Approval hash, recomputed with the policy engine from the receipt's approvalInputs.
  const ai = r.approvalInputs;
  if (!isObj(ai)) {
    add(
      "approval_hash",
      "not_checked",
      r.approvalHash && lc(r.approvalHash) === lc(r.planDigest)
        ? "no approvalInputs; the receipt's approvalHash equals its planDigest (an older console receipt), so it is not an engine approval hash"
        : "no approvalInputs in the receipt, so createApproval cannot be re-run",
    );
  } else {
    try {
      const now = typeof ai.now === "string" ? new Date(ai.now) : undefined;
      if (!now || Number.isNaN(now.getTime()))
        throw new Error("approvalInputs.now is missing or not a date");
      const o = createApproval({ ...(ai as never as object), now } as never);
      if (!o.ok)
        add("approval_hash", "fail", `createApproval refused the recorded inputs: ${o.reason}`);
      else if (lc(o.approval.hash) !== lc(r.approvalHash))
        add(
          "approval_hash",
          "fail",
          `receipt approvalHash ${r.approvalHash} != recomputed ${o.approval.hash}`,
        );
      else
        add(
          "approval_hash",
          "pass",
          `recomputed ${o.approval.hash} with createApproval, equal to the receipt's`,
        );
    } catch (e) {
      add("approval_hash", "fail", `createApproval could not be re-run: ${(e as Error).message}`);
    }
    const ap = ai.plan as Plan | undefined;
    if (!isObj(ap) || lc(ap.planDigest) !== lc(r.planDigest))
      add(
        "approval_binds_plan",
        "fail",
        "approvalInputs.plan is not the receipt's plan (planDigest differs or is missing)",
      );
    else add("approval_binds_plan", "pass", "approvalInputs.plan has the receipt's planDigest");
    if (ai.manifestDigest !== undefined && lc(ai.manifestDigest) !== lc(r.manifestDigest))
      add(
        "approval_binds_manifest",
        "fail",
        `approvalInputs.manifestDigest ${String(ai.manifestDigest)} != receipt ${r.manifestDigest}`,
      );
  }

  // 3. Fields a later console version adds. Absent = not checked; present but unknown format = not checked.
  if (r.policyDigest == null) add("policy_digest", "not_checked", "absent from this receipt");
  else if (isObj(ai) && isObj(ai.policy)) {
    let pd: string | undefined;
    try {
      pd = policyDigest(ai.policy as never);
    } catch {
      /* reported below */
    }
    if (pd === undefined) add("policy_digest", "fail", "approvalInputs.policy cannot be digested");
    else if (lc(pd) !== lc(r.policyDigest))
      add("policy_digest", "fail", `receipt ${r.policyDigest} != recomputed ${pd}`);
    else add("policy_digest", "pass", `recomputed ${pd} from approvalInputs.policy`);
  } else
    add(
      "policy_digest",
      "not_checked",
      "present, but no approvalInputs.policy to recompute it from",
    );
  for (const f of ["integrity", "integrityHash", "receiptDigest"])
    if (r[f] !== undefined)
      add(
        "integrity_hash",
        "not_checked",
        `"${f}" is present; its format is not known to this version of seam`,
      );
  if (!["integrity", "integrityHash", "receiptDigest"].some((f) => r[f] !== undefined))
    add("integrity_hash", "not_checked", "absent from this receipt");
  add(
    "evidence_coverage",
    "not_checked",
    r.evidenceCoverage === undefined
      ? "absent from this receipt"
      : "present; the console's coverage claim is not re-derived offline",
  );

  // 4. Steps: shape and nonce claims.
  const steps = consoleSteps(r);
  if (!steps.length) add("steps", "fail", "the receipt lists no step and no transaction");
  const envNonce =
    isObj(ai) && isObj(ai.envelope) && Number.isInteger(ai.envelope.nonce)
      ? (ai.envelope.nonce as number)
      : undefined;
  for (const s of steps) {
    const id = s.actionId;
    if (plan && !plan.steps.some((p) => p.actionId === id))
      add("step_in_plan", "fail", `step ${id} is not in the plan`, id);
    if (!s.sent) {
      if (s.txHash != null || s.nonce != null)
        add("step_shape", "fail", "a step marked not sent carries a txHash or nonce", id);
      continue;
    }
    if (typeof s.txHash !== "string" || !HASH.test(s.txHash))
      add("step_shape", "fail", "a sent step has no 32-byte txHash", id);
    else if (
      !s.block ||
      !Number.isInteger(s.block.number) ||
      typeof s.block.hash !== "string" ||
      !HASH.test(s.block.hash)
    )
      add("step_shape", "fail", "a sent step has no block number and hash", id);
    if (s.nonce == null && s.nonceSource == null)
      add(
        "step_nonce",
        "not_checked",
        "no per-step nonce in this receipt (it predates the field); only the chain can say",
        id,
      );
    else if (
      !Number.isInteger(s.nonce) ||
      (s.nonceSource !== "decoded" && s.nonceSource !== "signing_request")
    )
      add(
        "step_nonce",
        "fail",
        `nonce ${String(s.nonce)} / nonceSource ${String(s.nonceSource)} is not a valid pair`,
        id,
      );
    else if (
      envNonce !== undefined &&
      Number.isInteger(s.sendIndex) &&
      s.nonce !== envNonce + (s.sendIndex as number)
    )
      add(
        "step_nonce",
        "fail",
        `nonce ${s.nonce} != envelope nonce ${envNonce} + sendIndex ${s.sendIndex}`,
        id,
      );
    else
      add(
        "step_nonce",
        "not_checked",
        `nonce ${s.nonce} (${s.nonceSource})${s.nonceSource === "signing_request" ? ", a claim of what the wallet was asked to sign" : ""}; consistent with the envelope, but only the on-chain nonce proves it (use --endpoint)`,
        id,
      );
  }
  const failed = checks.some((c) => c.status === "fail");
  return {
    status: failed ? "failed" : "integrity_checked",
    claimedResult: r.result,
    kind: kindOf(r),
    checks,
  };
}

const parseEvent = (e: ChainEvent | string): ChainEvent => e as ChainEvent;

/**
 * Offline checks plus a read-only re-check of every sent step against the chain: canonical finalized block, the block holds
 * the tx at the recorded index, signer, call bytes, nonce, success, fee and the planned effect (`verifyStep` on the chain's own
 * events). `chain_verified` needs every offline check to pass or be not_checked, a plan, and every sent step re-derived as
 * verified with an on-chain nonce; anything unreadable is `unknown`, any mismatch is `failed`.
 */
export async function verifyConsoleReceiptLive(
  r: ConsoleReceipt,
  reader: ReceiptChainReader,
): Promise<ConsoleVerification> {
  const off = verifyConsoleReceiptOffline(r);
  const checks = [...off.checks];
  const add = (check: string, status: CheckStatus, detail: string, actionId?: string) =>
    checks.push(actionId ? { check, status, detail, actionId } : { check, status, detail });
  const plan = isObj(r.plan) ? (r.plan as Plan) : undefined;
  if (!plan)
    add("plan", "unknown", "no plan in the receipt: call bytes and effects cannot be compared");
  const signer = plan?.signer?.publicKey as Hex | undefined;
  const envNonce =
    isObj(r.approvalInputs) &&
    isObj(r.approvalInputs.envelope) &&
    Number.isInteger(r.approvalInputs.envelope.nonce)
      ? (r.approvalInputs.envelope.nonce as number)
      : undefined;
  let head: number | undefined;
  try {
    head = await reader.finalizedNumber();
  } catch (e) {
    add("finalized_head", "unknown", `could not read: ${(e as Error).message}`);
  }
  const steps = consoleSteps(r);
  let sentVerified = 0;
  let sent = 0;
  for (const s of steps) {
    if (!s.sent) continue;
    sent++;
    const id = s.actionId;
    const n = s.block?.number;
    const bh = s.block?.hash as Hex | undefined;
    if (!Number.isInteger(n) || !bh || !s.txHash) {
      add("chain_tx", "fail", "no block or tx hash to re-check", id);
      continue;
    }
    let ok = true;
    const fail = (c: string, d: string) => (add(c, "fail", d, id), (ok = false));
    const unk = (c: string, d: string) => (add(c, "unknown", d, id), (ok = false));
    try {
      if (head === undefined) unk("finalized", "finalized head unknown");
      else if ((n as number) > head)
        unk("finalized", `block #${n} is above the finalized head #${head}`);
      const ch = await reader.canonicalHash(n as number);
      if (!ch) unk("canonical_block", `no canonical block at #${n}`);
      else if (lc(ch) !== lc(bh))
        fail("canonical_block", `canonical #${n} is ${ch}, receipt says ${bh}`);
      else add("canonical_block", "pass", `#${n} ${bh} is canonical`, id);
      const tx = await reader.readTx(bh, s.txHash as Hex);
      if (!tx) {
        fail("chain_tx", `block #${n} does not contain ${s.txHash}`);
        continue;
      }
      if (
        Number.isInteger(s.extrinsicIndex) &&
        (s.extrinsicIndex as number) >= 0 &&
        s.extrinsicIndex !== tx.extrinsicIndex
      )
        fail("extrinsic_index", `receipt index ${s.extrinsicIndex} != chain ${tx.extrinsicIndex}`);
      if (!tx.signer) unk("signer", "the extrinsic's signer could not be decoded");
      else if (!signer) unk("signer", "no plan signer to compare with");
      else if (lc(tx.signer) !== lc(signer))
        fail("signer", `chain signer ${tx.signer} != plan signer ${signer}`);
      else add("signer", "pass", "the plan's signer", id);
      const ps: PlanStep | undefined = plan?.steps.find((p) => p.actionId === id);
      const want = ps?.encodedCall as Hex | undefined;
      if (!tx.callHex || !want)
        unk("call_bytes", "call bytes not comparable (undecodable or no planned call)");
      else if (lc(tx.callHex) !== lc(want))
        fail("call_bytes", `chain call ${tx.callHex} != planned ${want}`);
      else add("call_bytes", "pass", "equal to the planned step's encodedCall", id);
      const chainNonce = (tx as { nonce?: number }).nonce;
      const expected =
        envNonce !== undefined && Number.isInteger(s.sendIndex)
          ? envNonce + (s.sendIndex as number)
          : undefined;
      if (!Number.isInteger(chainNonce)) unk("nonce", "the on-chain nonce could not be read");
      else if (s.nonce != null && s.nonce !== chainNonce)
        fail(
          "nonce",
          `receipt nonce ${s.nonce} (${String(s.nonceSource)}) != on-chain nonce ${chainNonce}`,
        );
      else if (expected !== undefined && expected !== chainNonce)
        fail(
          "nonce",
          `on-chain nonce ${chainNonce} != envelope nonce ${envNonce} + sendIndex ${s.sendIndex}`,
        );
      else
        add(
          "nonce",
          "pass",
          `on-chain nonce ${chainNonce}${s.nonce == null ? " (the receipt has no per-step nonce)" : ` = receipt (${s.nonceSource})`}`,
          id,
        );
      const events = tx.events.map(parseEvent);
      if (events.some((e) => e.pallet === "System" && e.name === "ExtrinsicFailed"))
        fail("dispatch", "System.ExtrinsicFailed");
      else if (!events.some((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess"))
        unk("dispatch", "no ExtrinsicSuccess event read");
      else add("dispatch", "pass", "System.ExtrinsicSuccess", id);
      const feeEv = events.find(
        (e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid",
      );
      if (s.fee == null) add("fee", "not_checked", "no fee in the receipt", id);
      else if (!feeEv) unk("fee", "no TransactionFeePaid event read");
      else if (String(feeEv.args[1]) !== String(s.fee))
        fail("fee", `receipt fee ${s.fee} != TransactionFeePaid ${feeEv.args[1]}`);
      else add("fee", "pass", `equal to TransactionFeePaid ${s.fee}`, id);
      if (ps && signer) {
        const v = verifyStep(ps, signer, {
          actionId: id,
          status: "finalized",
          txHash: s.txHash as Hex,
          block: { number: n as number, hash: bh },
          events,
          callHex: tx.callHex,
        });
        if (v.verification === "verified") add("effect", "pass", v.reason, id);
        else if (v.verification === "not_verified") fail("effect", v.reason);
        else unk("effect", v.reason);
      } else unk("effect", "no planned step or signer to derive the effect from");
    } catch (e) {
      unk("chain_read", `read failed: ${(e as Error).message}`);
    }
    if (ok) sentVerified++;
  }
  // A receipt that claims "verified" must have run every planned step.
  if (plan && r.result === "verified" && sent < plan.steps.length)
    add(
      "claimed_result",
      "fail",
      `the receipt claims verified but only ${sent} of ${plan.steps.length} planned steps were sent`,
    );
  const anyFail = checks.some((c) => c.status === "fail");
  const anyUnknown = checks.some((c) => c.status === "unknown");
  const status = anyFail
    ? "failed"
    : !anyUnknown && plan && sent > 0 && sentVerified === sent
      ? "chain_verified"
      : "unknown";
  return { status, claimedResult: r.result, kind: off.kind, checks };
}

export function explainConsoleVerification(v: ConsoleVerification): string {
  const mark: Record<CheckStatus, string> = {
    pass: "ok",
    fail: "FAIL",
    not_checked: "not checked",
    unknown: "unknown",
  };
  return [
    `Console ${v.kind} receipt. Claimed result: ${v.claimedResult ?? "none"} (a claim, not proof).`,
    ...v.checks.map(
      (c) => `- ${mark[c.status]}: ${c.check}${c.actionId ? ` [${c.actionId}]` : ""}: ${c.detail}`,
    ),
  ].join("\n");
}
