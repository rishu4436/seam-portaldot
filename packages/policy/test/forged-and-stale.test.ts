// P0-02 audit rows "tampered policy result" (MISSING) and "stale approval, console level" (partial).
// Drives the console's exact call order (console/src/lib/signflow.ts preSign, then the submit gate):
//   gatePolicy(input, { envelope, now }) -> createApproval({ ...approvalInput, policyResult: gate.result, now })
//   -> wallet signs -> checkBeforeSubmit(...) -> store.markUsed(usageKey(...)).
import { describe, it, expect } from "vitest";
import {
  createApproval,
  checkBeforeSubmit,
  InMemoryApprovalStore,
  callsToSign,
  usageKey,
  policyDigest,
  isEvaluatedPolicyResult,
  type BoundApproval,
  type Hex,
  type Plan,
  type PolicyResult,
} from "../src/index.js";
import { gatePolicy, assertPolicyAllows, PolicyBlockedError } from "../src/browser.js";
import * as H from "./helpers.js";

const facts = H.realFacts();
const fp = facts.fingerprint;
const MALLORY = H.CHARLIE;

/** console preSign, step for step. */
function preSign(plan: Plan, policy = H.policy(), now = H.NOW) {
  const preflight = H.preflight(plan);
  const envelope = H.envelope();
  const input = { policy, plan, facts, preflight, manifest: H.demoManifest() };
  const gate = gatePolicy(input, { envelope, now });
  const approvalInput = {
    manifestDigest: plan.manifestDigest,
    plan,
    envelope,
    preflight,
    policy,
    policyResult: gate.result!,
    fingerprint: fp,
  };
  const a = gate.allowed ? createApproval({ ...approvalInput, now }) : undefined;
  return { gate, approvalInput, approval: a?.ok ? (a.approval as BoundApproval) : undefined, a };
}
type Pre = ReturnType<typeof preSign>;
const submit = (
  p: Pre,
  approval: BoundApproval,
  over: Partial<Parameters<typeof checkBeforeSubmit>[0]> = {},
) =>
  checkBeforeSubmit({
    ...p.approvalInput,
    approval,
    preparedFingerprint: fp,
    currentFingerprint: fp,
    signedCalls: callsToSign(p.approvalInput.plan) as Hex[],
    signedDryRun: callsToSign(p.approvalInput.plan).map(() => "ok" as const),
    now: H.NOW,
    store: new InMemoryApprovalStore(),
    requireEvaluatedPolicyResult: true,
    ...over,
  });
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);
const toMallory = (): Plan => {
  const p = structuredClone(H.compilePlan());
  p.steps[0].decodedArgs.recipient = MALLORY;
  return { ...p, planDigest: H.planDigest(p) };
};

describe("forged policy result", () => {
  it("a genuine result is marked; a JSON copy of it is not", () => {
    const p = preSign(H.compilePlan());
    expect(isEvaluatedPolicyResult(p.gate.result)).toBe(true);
    expect(isEvaluatedPolicyResult(JSON.parse(JSON.stringify(p.gate.result)))).toBe(false);
  });
  it("assertPolicyAllows ignores any allow decision it is handed: it always re-evaluates", () => {
    const plan = toMallory();
    const input = {
      policy: H.policy(),
      plan,
      facts,
      preflight: H.preflight(plan),
      manifest: H.demoManifest(),
    };
    const forgedGate = { allowed: true, blockedBy: [], explanations: [] };
    void forgedGate; // there is no parameter that accepts a gate/result: the engine runs itself
    expect(() => assertPolicyAllows(input)).toThrow(PolicyBlockedError);
  });
  it("createApproval refuses a blocked result flipped to allowed:true", () => {
    const plan = toMallory();
    const p = preSign(plan);
    expect(p.gate.allowed).toBe(false);
    const flipped: PolicyResult = { ...p.gate.result!, allowed: true };
    const a = createApproval({ ...p.approvalInput, policyResult: flipped, now: H.NOW });
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toMatch(/forged or edited/);
  });
  it("createApproval refuses an empty hand-built allow result", () => {
    const plan = H.compilePlan();
    const p = preSign(plan);
    const fake: PolicyResult = { allowed: true, rules: [], policyDigest: policyDigest(H.policy()) };
    expect(createApproval({ ...p.approvalInput, policyResult: fake, now: H.NOW }).ok).toBe(false);
  });
  it("checkBeforeSubmit blocks a fully fabricated all-pass result for a blocked plan (policy_result_unverified)", () => {
    // Attacker builds a plan to Mallory, a hand-made all-pass result, and an approval over both.
    const plan = toMallory();
    const p = preSign(plan);
    const fake: PolicyResult = {
      allowed: true,
      rules: [{ rule: "plan_integrity", outcome: "pass", reason: "trust me" }],
      policyDigest: policyDigest(H.policy()),
    };
    const forgedInput = { ...p.approvalInput, policyResult: fake };
    const a = createApproval({ ...forgedInput, now: H.NOW });
    expect(a.ok).toBe(true); // self-consistent on its face, so the approval step alone can't tell
    const r = submit(
      { ...p, approvalInput: forgedInput },
      (a as { approval: BoundApproval }).approval,
    );
    expect(codes(r)).toContain("policy_result_unverified");
    // With the facts given, the gate re-runs the policy, which does not reproduce it.
    const r2 = submit(
      { ...p, approvalInput: forgedInput },
      (a as { approval: BoundApproval }).approval,
      {
        policyEvaluation: { facts, manifest: H.demoManifest() },
      },
    );
    expect(codes(r2)).toContain("policy_result_forged");
  });
  it("checkBeforeSubmit always blocks an inconsistent result (allowed:true with a failing rule), even without strict mode", () => {
    const p = preSign(H.compilePlan());
    const bad: PolicyResult = {
      ...p.gate.result!,
      rules: [
        ...p.gate.result!.rules,
        { rule: "recipient_allowed", outcome: "block", reason: "x" },
      ],
    };
    const r = submit(
      { ...p, approvalInput: { ...p.approvalInput, policyResult: bad } },
      p.approval!,
      {
        requireEvaluatedPolicyResult: false,
      },
    );
    expect(codes(r)).toContain("policy_result_forged");
  });
  it("a result made for another policy is policy_result_forged", () => {
    const p = preSign(H.compilePlan());
    const r = submit(p, p.approval!, { policy: H.policy({ maxFee: "1" }) });
    expect(codes(r)).toContain("policy_result_forged");
  });
  it("a genuine result restored from storage passes only when re-evaluation reproduces it", () => {
    const p = preSign(H.compilePlan());
    const restored = JSON.parse(JSON.stringify(p.gate.result)) as PolicyResult;
    const pp = { ...p, approvalInput: { ...p.approvalInput, policyResult: restored } };
    expect(codes(submit(pp, p.approval!))).toContain("policy_result_unverified");
    const ok = submit(pp, p.approval!, { policyEvaluation: { facts, manifest: H.demoManifest() } });
    expect(ok).toMatchObject({ ok: true, reasons: [] });
    expect(ok.passed.map((x) => x.code)).toContain("policy_result_reproduced");
  });
  it("the genuine in-memory console path still passes", () => {
    const p = preSign(H.compilePlan());
    expect(submit(p, p.approval!)).toMatchObject({ ok: true, reasons: [] });
  });
});

describe("stale approval replayed through the console's call sequence", () => {
  it("approval for plan A replayed for plan B: approval_mismatch", () => {
    const a = preSign(H.compilePlan());
    const pb = structuredClone(H.compilePlan());
    pb.steps[0].decodedArgs.amount = "1";
    const b = preSign({ ...pb, planDigest: H.planDigest(pb) });
    expect(b.gate.allowed).toBe(true);
    expect(codes(submit(b, a.approval!))).toContain("approval_mismatch");
  });
  it("approval from an earlier runtime: runtime_changed after an upgrade", () => {
    const a = preSign(H.compilePlan());
    const r = submit(a, a.approval!, {
      currentFingerprint: { ...fp, specVersion: fp.specVersion + 1 },
    });
    expect(codes(r)).toContain("runtime_changed");
  });
  it("approval used once, then replayed: approval_reused", () => {
    const a = preSign(H.compilePlan());
    const store = new InMemoryApprovalStore();
    expect(submit(a, a.approval!, { store }).ok).toBe(true);
    store.markUsed(usageKey(a.approval!.hash));
    expect(codes(submit(a, a.approval!, { store }))).toContain("approval_reused");
  });
  it("approval that went stale between approve and sign (time passed): approval_expired", () => {
    const a = preSign(H.compilePlan());
    const later = new Date(Date.parse(a.approval!.expiresAt) + 1000);
    expect(codes(submit(a, a.approval!, { now: later }))).toContain("approval_expired");
    // And a fresh preSign at that time is refused up front by the browser gate.
    const g = gatePolicy(
      {
        policy: H.policy(),
        plan: a.approvalInput.plan,
        facts,
        preflight: a.approvalInput.preflight,
        manifest: H.demoManifest(),
      },
      { envelope: a.approvalInput.envelope, now: new Date("2026-10-20T11:00:00Z") },
    );
    expect(g.blockedBy.map((x) => x.code)).toContain("SIGNING_WINDOW_EXPIRED");
  });
  it("approval replayed after the account nonce moved on: nonce_stale", () => {
    const a = preSign(H.compilePlan());
    expect(codes(submit(a, a.approval!, { currentAccountNonce: 6 }))).toContain("nonce_stale");
  });
});
