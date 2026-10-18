import { describe, it, expect } from "vitest";
import {
  evaluatePolicy,
  createApproval,
  checkBeforeSubmit,
  InMemoryApprovalStore,
  callsToSign,
  type BoundApproval,
  type Hex,
} from "../src/index.js";
import * as H from "./helpers.js";

const facts = H.realFacts();
function run() {
  const plan = H.compilePlan(),
    policy = H.policy(),
    preflight = H.preflight(plan);
  const policyResult = evaluatePolicy({
    policy,
    plan,
    facts,
    preflight,
    manifest: H.demoManifest(),
  });
  const envelope = H.envelope();
  const out = createApproval({
    manifestDigest: plan.manifestDigest,
    plan,
    envelope,
    preflight,
    policy,
    policyResult,
    fingerprint: facts.fingerprint,
    now: H.NOW,
  });
  if (!out.ok) throw new Error(out.reason);
  return {
    plan,
    policy,
    preflight,
    policyResult,
    envelope,
    approval: out.approval as BoundApproval,
  };
}
const gate = (r: ReturnType<typeof run>, approval: BoundApproval) =>
  checkBeforeSubmit({
    approval,
    manifestDigest: r.plan.manifestDigest,
    plan: r.plan,
    envelope: r.envelope,
    preflight: r.preflight,
    policy: r.policy,
    policyResult: r.policyResult,
    preparedFingerprint: facts.fingerprint,
    currentFingerprint: facts.fingerprint,
    signedCalls: callsToSign(r.plan) as Hex[],
    signedDryRun: callsToSign(r.plan).map(() => "ok" as const),
    now: H.NOW,
    store: new InMemoryApprovalStore(),
  });
const messageFor = (res: { reasons: { code: string; message?: string }[] }, code: string) =>
  res.reasons.find((x) => x.code === code)?.message;

describe("approval expiry wording", () => {
  it("approval_tampered: expiry changed after approval", () => {
    const r = run();
    const res = gate(r, { ...r.approval, expiresAt: "2030-01-01T00:00:00Z" });
    expect(messageFor(res, "approval_tampered")).toBe(
      "Blocked: the approval's expiry was changed after it was approved.",
    );
  });
  it("approval_expired: no valid expiry time", () => {
    const r = run();
    const res = gate(r, {
      ...r.approval,
      expiresAt: "not-a-date",
      binding: { ...r.approval.binding, expiresAt: "not-a-date" },
    });
    expect(messageFor(res, "approval_expired")).toBe(
      "Blocked: this approval has no valid expiry time. Approve again.",
    );
  });
});
