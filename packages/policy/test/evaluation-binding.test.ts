import { describe, it, expect } from "vitest";
import {
  createApproval,
  checkBeforeSubmit,
  evaluatePolicy,
  InMemoryApprovalStore,
  callsToSign,
  isEvaluatedPolicyResult,
} from "../src/index.js";
import * as H from "./helpers.js";

describe("policy evaluation input binding", () => {
  const setup = () => {
    const facts = H.realFacts(),
      plan = H.compilePlan(),
      policy = H.policy();
    const input = {
      plan,
      policy,
      preflight: H.preflight(plan),
      envelope: H.envelope(),
      fingerprint: facts.fingerprint,
      manifestDigest: plan.manifestDigest,
      now: H.NOW,
    };
    const policyResult = evaluatePolicy({ ...input, facts });
    return { facts, input, policyResult };
  };
  it("does not approve a different disallowed plan using a genuine allowed result", () => {
    const { input, policyResult, facts } = setup();
    const manifest = H.demoManifest();
    manifest.actions[0].args.recipient = H.CHARLIE;
    const plan = H.compilePlan(manifest);
    expect(evaluatePolicy({ ...input, facts, plan }).allowed).toBe(false);
    expect(
      createApproval({ ...input, plan, manifestDigest: plan.manifestDigest, policyResult }).ok,
    ).toBe(false);
  });
  it("rejects a result edited in place, even when every rule is flipped to pass", () => {
    const { input, facts } = setup();
    const policyResult = evaluatePolicy({
      ...input,
      facts,
      policy: H.policy({ allowedRecipients: [] }),
    });
    policyResult.allowed = true;
    policyResult.rules.forEach((rule) => {
      rule.outcome = "pass";
    });
    expect(isEvaluatedPolicyResult(policyResult)).toBe(false);
    expect(createApproval({ ...input, policyResult }).ok).toBe(false);
  });
  it("blocks a genuine stale result at submit even if an attacker creates a new approval hash", () => {
    const { input, policyResult } = setup();
    const approval = createApproval({ ...input, policyResult });
    if (!approval.ok) throw new Error(approval.reason);
    const preflight = { ...input.preflight, totalFee: { value: "999999999999" } };
    const gate = checkBeforeSubmit({
      ...input,
      policyResult,
      preflight,
      approval: approval.approval,
      preparedFingerprint: input.fingerprint,
      currentFingerprint: input.fingerprint,
      signedCalls: callsToSign(input.plan) as `0x${string}`[],
      signedDryRun: ["ok", "ok", "ok"],
      store: new InMemoryApprovalStore(),
    });
    expect(gate.reasons.map((r) => r.code)).toContain("policy_result_forged");
  });
});
