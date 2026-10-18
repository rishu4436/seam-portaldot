// Policy side of Bot 2's compiler audit changes: SEAM-012 (rollback proof), SEAM-013 (atomicRequired / modeDowngrade),
// SEAM-006/007 (reasonCode blockers).
import { describe, it, expect } from "vitest";
import { evaluatePolicy, createApproval, checkBeforeSubmit, InMemoryApprovalStore, callsToSign, definePolicy, type Plan, type Hex } from "../src/index.js";
import * as H from "./helpers.js";

const facts = H.realFacts();
const fp = facts.fingerprint;
const evalP = (plan: Plan, f = facts, policy = H.policy()) => evaluatePolicy({ policy, plan, facts: f, preflight: H.preflight(plan), manifest: undefined });
const rule = (r: ReturnType<typeof evaluatePolicy>, name: string) => r.rules.find((x) => x.rule === name && x.outcome !== "pass");

describe("SEAM-012: atomic claim needs a matching rollback proof", () => {
  const good = H.withRollback(facts);
  const atomic = H.compilePlan(H.demoManifest(), good);
  it("allows atomic_verified with a matching proof", () => {
    expect(atomic.mode).toBe("atomic_verified");
    expect(evalP(atomic, good).allowed).toBe(true);
  });
  it("blocks a hand-built atomic_verified plan when facts only say bare 'verified'", () => {
    const r = evalP(atomic, H.withBareVerified(facts));
    expect(r.allowed).toBe(false);
    expect(rule(r, "mode_allowed")?.reason).toMatch(/proof/);
  });
  it.each([
    ["wrong genesis", { genesisHash: ("0x" + "11".repeat(32)) as Hex }],
    ["wrong metadata hash", { metadataHash: ("0x" + "22".repeat(32)) as Hex }],
    ["wrong spec version", { specVersion: 9999 }],
    ["no tx or block hash", { txHash: undefined, blockHash: undefined }],
    ["empty preState", { preState: {} }],
    ["missing postState", { postState: undefined }],
    ["empty composition", { composition: [] }],
    ["composition misses a kind", { composition: ["assets.transfer"] }],
  ])("blocks a proof with %s", (_n, over) => {
    const f = { ...good, behaviour: { batchAllRollback: "verified" as const, batchAllRollbackProof: { ...H.proofFor(facts), ...over } as never } };
    const r = evalP(atomic, f);
    expect(r.allowed).toBe(false);
    expect(rule(r, "mode_allowed")?.reason).toMatch(/rollback proof/);
  });
});

describe("SEAM-013: modeDowngrade needs a person's acknowledgement", () => {
  const manifest = { ...H.demoManifest(), actions: H.demoManifest().actions.map((a) => ({ ...a, preferredMode: "atomic" as const })) };
  const plan = H.compilePlan(manifest, facts); // rollback unknown, so the atomic preference falls back
  it("the compiler produced a downgrade", () => {
    expect(plan.mode).toBe("sequential");
    expect(plan.modeDowngrade?.requiresApproval).toBe(true);
  });
  const result = () => evaluatePolicy({ policy: H.policy(), plan, facts, preflight: H.preflight(plan), manifest });
  const create = (acknowledgedDowngrade?: boolean, p: Plan = plan) => createApproval({
    manifestDigest: p.manifestDigest, plan: p, envelope: H.envelope(), preflight: H.preflight(p), policy: H.policy(),
    policyResult: evaluatePolicy({ policy: H.policy(), plan: p, facts, preflight: H.preflight(p), manifest }), fingerprint: fp, now: H.NOW, acknowledgedDowngrade,
  });
  it("policy flags approval as required and spells out the risk", () => {
    const r = result();
    expect(r.allowed).toBe(true);
    expect(r.approvalRequired?.[0]).toMatchObject({ code: "mode_downgrade" });
    expect(r.approvalRequired![0].reason).toMatch(/not rolled back/);
  });
  it("cannot be auto-approved", () => {
    const out = create(undefined);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toMatch(/Acknowledge the downgrade/);
    expect(create(false).ok).toBe(false);
  });
  it("acknowledged approval binds the downgrade", () => {
    const out = create(true);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.approval.binding.modeDowngradeDigest).toMatch(/^0x[0-9a-f]{64}$/);
    // Removing the downgrade from the plan (keeping the digest) changes what was approved.
    const stripped = { ...plan, modeDowngrade: undefined } as Plan;
    expect(create(true, stripped).ok && (create(true, stripped) as never as { approval: { hash: string } }).approval.hash).not.toBe(out.approval.hash);
  });
  it("submit gate rejects an approval that never acknowledged the downgrade", () => {
    const out = create(true);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { modeDowngradeDigest: _drop, ...binding } = out.approval.binding;
    const approval = { ...out.approval, binding };
    const res = checkBeforeSubmit({
      approval, manifestDigest: plan.manifestDigest, plan, envelope: H.envelope(), preflight: H.preflight(plan),
      policy: H.policy(), policyResult: result(), preparedFingerprint: fp, currentFingerprint: fp,
      signedCalls: callsToSign(plan) as Hex[], signedDryRun: callsToSign(plan).map(() => "ok" as const), now: H.NOW, store: new InMemoryApprovalStore(),
    });
    expect(res.ok).toBe(false);
    expect(res.reasons.map((x) => x.code)).toContain("downgrade_not_approved");
  });
  it("a malformed downgrade (requiresApproval false) is blocked", () => {
    const bad = { ...plan, modeDowngrade: { ...plan.modeDowngrade!, requiresApproval: false } } as unknown as Plan;
    expect(evalP(bad).allowed).toBe(false);
  });
});

describe("unavailable plans carry a clear reason code", () => {
  it("atomicRequired with no verified rollback is blocked with ATOMIC_REQUIRED_UNAVAILABLE", () => {
    const plan = H.compilePlan({ ...H.demoManifest(), atomicRequired: true }, facts);
    expect(plan.mode).toBe("unavailable");
    const r = evalP(plan);
    expect(r.allowed).toBe(false);
    expect(rule(r, "plan_available")?.reason).toMatch(/ATOMIC_REQUIRED_UNAVAILABLE/);
  });
  it("revive.call is blocked with NO_OBSERVED_V3_METADATA", () => {
    const m = { ...H.demoManifest(), actions: [{ id: "rv", kind: "revive.call" as const, args: { contract: "0x" + "11".repeat(20), value: "0", gasLimit: "1", data: "0x" } }] };
    const plan = H.compilePlan(m as never, facts);
    expect(plan.mode).toBe("unavailable");
    const r = evalP(plan, facts, definePolicy({ ...H.policy() } as never));
    expect(r.allowed).toBe(false);
    expect(r.rules.map((x) => x.reason).join(" ")).toMatch(/NO_OBSERVED_V3_METADATA/);
  });
});
