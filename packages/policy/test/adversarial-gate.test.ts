import { describe, it, expect } from "vitest";
import {
  evaluatePolicy, createApproval, checkBeforeSubmit, InMemoryApprovalStore, LOCKED_FIELDS, digest, callsToSign, usageKey,
  type BoundApproval, type Plan, type ReceiptStep, type RuntimeFingerprint, type Hex,
} from "../src/index.js";
import * as H from "./helpers.js";

const facts = H.realFacts();
const fp = facts.fingerprint;

function approvedRun(plan: Plan = H.compilePlan()) {
  const policy = H.policy();
  const preflight = H.preflight(plan);
  const policyResult = evaluatePolicy({ policy, plan, facts, preflight, manifest: H.demoManifest() });
  const envelope = H.envelope();
  const out = createApproval({ manifestDigest: plan.manifestDigest, plan, envelope, preflight, policy, policyResult, fingerprint: fp, now: H.NOW });
  if (!out.ok) throw new Error(out.reason);
  return { plan, policy, preflight, policyResult, envelope, fingerprint: fp, approval: out.approval as BoundApproval };
}
type Run = ReturnType<typeof approvedRun>;
function gate(run: Run, over: Partial<Parameters<typeof checkBeforeSubmit>[0]> = {}) {
  return checkBeforeSubmit({
    approval: run.approval, manifestDigest: run.plan.manifestDigest, plan: run.plan, envelope: run.envelope,
    preflight: run.preflight, policy: run.policy, policyResult: run.policyResult,
    preparedFingerprint: run.fingerprint, currentFingerprint: run.fingerprint,
    signedCalls: callsToSign(run.plan) as Hex[], signedDryRun: callsToSign(run.plan).map(() => "ok" as const),
    now: H.NOW, store: new InMemoryApprovalStore(), ...over,
  });
}
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);
const done = (actionId: string): ReceiptStep => ({ actionId, status: "finalized", events: ["x"], verification: "verified", reason: "ok" });

describe("adversarial submit gate", () => {
  it("blocks an approval whose expiry was extended by hand", () => {
    const run = approvedRun();
    const forged = { ...run.approval, expiresAt: "2030-01-01T00:00:00Z", binding: { ...run.approval.binding, expiresAt: "2030-01-01T00:00:00Z" } };
    expect(codes(gate({ ...run, approval: forged }, { now: new Date("2026-10-20T11:00:00Z") }))).toEqual(expect.arrayContaining(["approval_tampered"]));
  });

  it("blocks a binding edited to match a different recipient, even with the hash left alone", () => {
    const run = approvedRun();
    const forged = { ...run.approval, binding: { ...run.approval.binding, callsDigest: ("0x" + "ab".repeat(32)) as Hex } };
    expect(codes(gate({ ...run, approval: forged }))).toContain("approval_tampered");
  });

  it("blocks a fully re-hashed forged approval, because the binding no longer matches what is being sent", () => {
    const run = approvedRun();
    const binding = { ...run.approval.binding, callsDigest: ("0x" + "cd".repeat(32)) as Hex };
    const forged = { ...run.approval, binding, hash: digest("seam/approval/v1", binding) };
    const r = gate({ ...run, approval: forged });
    expect(codes(r)).toContain("approval_mismatch");
    expect(codes(r)).not.toContain("approval_tampered");
  });

  it("blocks an approval that was marked used in its own object", () => {
    const run = approvedRun();
    expect(codes(gate({ ...run, approval: { ...run.approval, used: true } }))).toContain("approval_reused");
  });

  it("blocks one plan's approval presented for a different plan", () => {
    const run = approvedRun();
    const other = H.compilePlan({ ...H.demoManifest(), actions: H.demoManifest().actions.slice(0, 2) });
    const r = gate(run, { plan: other, signedCalls: callsToSign(other) as Hex[], signedDryRun: callsToSign(other).map(() => "ok" as const) });
    expect(codes(r)).toContain("approval_mismatch");
  });

  it("blocks when the signer in the envelope is swapped after approval", () => {
    const run = approvedRun();
    expect(codes(gate(run, { envelope: { ...run.envelope, signer: H.BOB } }))).toContain("approval_mismatch");
  });

  it("blocks a changed nonce or mortality after approval", () => {
    const run = approvedRun();
    expect(codes(gate(run, { envelope: { ...run.envelope, nonce: run.envelope.nonce + 1 } }))).toContain("approval_mismatch");
    expect(codes(gate(run, { envelope: { ...run.envelope, mortalityBlocks: 4096 } }))).toContain("approval_mismatch");
  });

  it("blocks a swapped checkpoint block", () => {
    const run = approvedRun();
    const checkpoint = { ...run.envelope.checkpoint!, hash: ("0x" + "11".repeat(32)) as Hex };
    expect(codes(gate(run, { envelope: { ...run.envelope, checkpoint } }))).toContain("approval_mismatch");
  });

  it("blocks a runtime change in each of the nine locked fields, one at a time", () => {
    const run = approvedRun();
    for (const field of LOCKED_FIELDS) {
      const cur = { ...fp } as Record<string, unknown>;
      const v = fp[field];
      cur[field] = typeof v === "number" ? v + 1 : typeof v === "string" ? v + "x" : "other";
      const r = gate(run, { currentFingerprint: cur as unknown as RuntimeFingerprint });
      expect(codes(r), field).toContain("runtime_changed");
    }
  });

  it("blocks signed bytes that are truncated, extended, reordered, empty, or an extra call", () => {
    const run = approvedRun();
    const calls = callsToSign(run.plan) as Hex[];
    const bad: Hex[][] = [
      [calls[0].slice(0, -2) as Hex, ...calls.slice(1)],
      [(calls[0] + "00") as Hex, ...calls.slice(1)],
      [...calls].reverse(),
      [],
      [...calls, calls[0]],
    ];
    for (const signedCalls of bad) expect(codes(gate(run, { signedCalls })), JSON.stringify(signedCalls.length)).toContain("signed_bytes_mismatch");
  });

  it("accepts the same bytes in different hex case", () => {
    const run = approvedRun();
    const upper = (callsToSign(run.plan) as Hex[]).map((c) => ("0x" + c.slice(2).toUpperCase()) as Hex);
    expect(gate(run, { signedCalls: upper }).ok).toBe(true);
  });

  it("is valid before the expiry second and blocked at it", () => {
    const run = approvedRun();
    const at = new Date(run.approval.expiresAt);
    expect(gate(run, { now: new Date(at.getTime() - 1000) }).ok).toBe(true);
    expect(codes(gate(run, { now: at }))).toContain("approval_expired");
  });

  it("blocks an expired approval whose top-level expiry was pushed forward (the hash only covers the bound copy)", () => {
    const run = approvedRun();
    const stretched = { ...run.approval, expiresAt: "2030-01-01T00:00:00Z" };
    const r = gate({ ...run, approval: stretched }, { now: new Date("2026-10-20T11:00:00Z") });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("approval_tampered");
  });

  it("blocks an unparseable expiry", () => {
    const run = approvedRun();
    expect(gate({ ...run, approval: { ...run.approval, expiresAt: "soon" } }).ok).toBe(false);
    const binding = { ...run.approval.binding, expiresAt: "soon" };
    const forged = { ...run.approval, expiresAt: "soon", binding, hash: digest("seam/approval/v1", binding) };
    expect(gate({ ...run, approval: forged }).ok).toBe(false);
  });

  it("blocks a failed signed dry run, and a missing one when the policy requires it", () => {
    const run = approvedRun();
    const n = callsToSign(run.plan).length;
    expect(codes(gate(run, { signedDryRun: Array(n).fill("failed") }))).toContain("signed_dry_run_failed");
    expect(codes(gate(run, { signedDryRun: undefined }))).toContain("signed_dry_run_missing");
  });

  it("one approval cannot send the same sequential step twice, or step 2 before step 1", () => {
    const run = approvedRun();
    const store = new InMemoryApprovalStore();
    const dry = ["ok", "ok", "ok"] as const;
    expect(codes(gate(run, { store, signedDryRun: [...dry], sendIndex: 1, previousSteps: [done("pay")] }))).toContain("out_of_order");
    store.markUsed(usageKey(run.approval.hash, 0));
    expect(gate(run, { store, signedDryRun: [...dry], sendIndex: 1, previousSteps: [done("pay")] }).ok).toBe(true);
    store.markUsed(usageKey(run.approval.hash, 1));
    expect(codes(gate(run, { store, signedDryRun: [...dry], sendIndex: 1, previousSteps: [done("pay")] }))).toContain("approval_reused");
  });

  it("an earlier step that only finalized without verification, or is still pending, blocks the next one", () => {
    const run = approvedRun();
    const store = new InMemoryApprovalStore();
    store.markUsed(usageKey(run.approval.hash, 0));
    const dry = ["ok", "ok", "unknown"] as const;
    const pending = { ...done("pay"), status: "submitted" } as unknown as ReceiptStep;
    expect(codes(gate(run, { store, signedDryRun: [...dry], sendIndex: 1, previousSteps: [pending] }))).toContain("previous_step_failed");
    expect(codes(gate(run, { store, signedDryRun: [...dry], sendIndex: 1, previousSteps: [{ ...done("pay"), status: "failed" }] }))).toContain("previous_step_failed");
  });

  it("a sendIndex outside the plan is rejected, including negative and fractional", () => {
    const run = approvedRun();
    for (const sendIndex of [-1, 3, 99, 0.5]) expect(codes(gate(run, { sendIndex, previousSteps: [] })), String(sendIndex)).toContain("send_index_invalid");
  });

  it("collects every problem at once instead of stopping at the first", () => {
    const run = approvedRun();
    const r = gate(run, { now: new Date("2026-10-20T12:00:00Z"), currentFingerprint: { ...fp, specVersion: 9999 }, signedCalls: [] });
    expect(codes(r)).toEqual(expect.arrayContaining(["approval_expired", "runtime_changed", "signed_bytes_mismatch"]));
    expect(r.ok).toBe(false);
  });

  it("every blocked result carries a human-readable message and a stable code", () => {
    const run = approvedRun();
    const r = gate(run, { currentFingerprint: { ...fp, metadataHash: ("0x" + "99".repeat(32)) as Hex }, signedCalls: [] });
    for (const x of r.reasons) { expect(x.code).toMatch(/^[a-z_]+$/); expect(x.message.length).toBeGreaterThan(20); }
  });
});
