import { describe, it, expect } from "vitest";
import { computePlanDigest, computeFingerprintDigest, digestJson } from "@seam/compiler";
import {
  evaluatePolicy, createApproval, checkBeforeSubmit, InMemoryApprovalStore, canRunNextStep, overallResult,
  checkRuntimeLock, digest, planDigest, fingerprintDigest, callsToSign,
  type BoundApproval, type Plan, type ReceiptStep, type RuntimeFacts, type RuntimeFingerprint, type Hex,
} from "../src/index.js";
import * as H from "./helpers.js";

const facts = H.realFacts();
const fp = facts.fingerprint;

function approvedRun(plan: Plan = H.compilePlan(), f: RuntimeFacts = facts) {
  const policy = H.policy();
  const preflight = H.preflight(plan);
  const manifest = H.demoManifest();
  const policyResult = evaluatePolicy({ policy, plan, facts: f, preflight, manifest });
  const envelope = H.envelope();
  const out = createApproval({ manifestDigest: plan.manifestDigest, plan, envelope, preflight, policy, policyResult, fingerprint: f.fingerprint, now: H.NOW });
  if (!out.ok) throw new Error(out.reason + " | " + JSON.stringify(policyResult.rules.filter((r) => r.outcome !== "pass")));
  return { plan, policy, preflight, policyResult, envelope, fingerprint: f.fingerprint, approval: out.approval as BoundApproval };
}
type Run = ReturnType<typeof approvedRun>;
function submit(run: Run, over: Partial<Parameters<typeof checkBeforeSubmit>[0]> = {}) {
  return checkBeforeSubmit({
    approval: run.approval, manifestDigest: run.plan.manifestDigest, plan: run.plan, envelope: run.envelope,
    preflight: run.preflight, policy: run.policy, policyResult: run.policyResult,
    preparedFingerprint: run.fingerprint, currentFingerprint: run.fingerprint,
    signedCalls: callsToSign(run.plan) as Hex[], signedDryRun: callsToSign(run.plan).map(() => "ok" as const), now: H.NOW, store: new InMemoryApprovalStore(), ...over,
  });
}
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);
const blocked = (r: { rules: { rule: string; outcome: string }[] }, rule: string) => r.rules.some((x) => x.rule === rule && x.outcome !== "pass");
const check = (plan: Plan, f: RuntimeFacts = facts, over = {}) => evaluatePolicy({ policy: H.policy(over), plan, facts: f, preflight: H.preflight(plan) });
/** A plan edited by hand with its digest recomputed, to test the policy's own checks behind the compiler's. */
function edited(edit: (p: Plan) => void): Plan {
  const p = structuredClone(H.compilePlan());
  edit(p);
  return { ...p, planDigest: planDigest(p) };
}
function factsWith(over: Partial<RuntimeFingerprint>): RuntimeFacts {
  const f = structuredClone(facts);
  f.fingerprint = { ...f.fingerprint, ...over };
  f.fingerprintDigest = fingerprintDigest(f.fingerprint);
  return f;
}

describe("matches Bot 2's compiler", () => {
  it("hashes exactly like the compiler (plan, fingerprint, arbitrary JSON)", () => {
    const plan = H.compilePlan();
    expect(planDigest(plan)).toBe(plan.planDigest);
    expect(planDigest(plan)).toBe(computePlanDigest(plan as never));
    expect(fingerprintDigest(fp)).toBe(computeFingerprintDigest(fp as never));
    expect(fingerprintDigest(fp)).toBe(facts.fingerprintDigest);
    const v = { b: [1, { y: "2", x: true }], a: null };
    expect(digest("seam/test", v)).toBe(digestJson("seam/test", v));
  });
  it("allows, approves and submits the real compiled demo flow", () => {
    const run = approvedRun();
    expect(run.plan.mode).toBe("sequential");
    expect(run.policyResult.allowed).toBe(true);
    expect(submit(run)).toMatchObject({ ok: true, reasons: [] });
  });
  it("rejects floats in anything it hashes", () => {
    expect(() => digest("d", { amount: 1.5 })).toThrow(/safe integer/);
  });
});

describe("attack cases", () => {
  it("1. recipient or amount changed after approval", () => {
    const run = approvedRun();
    const toMallory = structuredClone(run.plan);
    toMallory.steps[0].decodedArgs.recipient = H.CHARLIE;
    expect(codes(submit(run, { plan: toMallory }))).toContain("approval_mismatch");
    expect(blocked(evaluatePolicy({ policy: run.policy, plan: toMallory, facts, preflight: run.preflight }), "plan_integrity")).toBe(true);
    const bigger = edited((p) => { p.steps[0].decodedArgs.amount = "4000000000000000"; });
    expect(codes(submit(run, { plan: bigger }))).toContain("approval_mismatch");
  });

  it("2. approval reused, or used after it expired", () => {
    const run = approvedRun();
    const store = new InMemoryApprovalStore();
    expect(submit(run, { store }).ok).toBe(true);
    store.markUsed(run.approval.hash);
    expect(codes(submit(run, { store }))).toContain("approval_reused");
    expect(codes(submit(run, { now: new Date("2026-10-20T10:11:00Z") }))).toContain("approval_expired");
  });

  it("3. runtime upgraded between compile and submit", () => {
    const run = approvedRun();
    const upgraded = factsWith({ specVersion: 1003 });
    const r = submit(run, { currentFingerprint: upgraded.fingerprint });
    expect(codes(r)).toContain("runtime_changed");
    expect(r.reasons.find((x) => x.code === "runtime_changed")!.message).toMatch(/runtime version/);
    expect(blocked(evaluatePolicy({ policy: run.policy, plan: run.plan, facts: upgraded, preflight: run.preflight }), "runtime_match")).toBe(true);
  });

  it("4. metadata changed while the spec version stayed the same", () => {
    const changed = factsWith({ metadataHash: ("0x" + "99".repeat(32)) as Hex });
    const lock = checkRuntimeLock(fp, changed.fingerprint);
    expect(lock.changed).toEqual(["metadataHash"]);
    expect(codes(submit(approvedRun(), { currentFingerprint: changed.fingerprint }))).toContain("runtime_changed");
  });

  it("5. wrong address type or network prefix: the compiler refuses, and the policy catches a hand-edited plan", () => {
    const m = H.demoManifest();
    (m.actions[0].args as Record<string, unknown>).recipient = H.BOB_POLKADOT;
    expect(() => H.compilePlan(m)).toThrow(/prefix/i);
    const h160 = H.demoManifest();
    (h160.actions[0].args as Record<string, unknown>).recipient = "0x" + "12".repeat(20);
    expect(() => H.compilePlan(h160)).toThrow();

    const prefixed = edited((p) => { p.steps[0].decodedArgs.recipient = H.BOB_POLKADOT; });
    expect(check(prefixed).rules.find((r) => r.rule === "address_check")?.reason).toMatch(/prefix 0/);
    const asH160 = edited((p) => { p.steps[0].decodedArgs.recipient = "0x" + "12".repeat(20); });
    expect(blocked(check(asH160), "address_check")).toBe(true);
  });

  it("6. capability not observed or unknown", () => {
    const m = H.demoManifest();
    m.actions[2] = { id: "receipt", kind: "nfts.mint", args: { collection: "1", item: "1", recipient: H.BOB } };
    const plan = H.compilePlan(m);
    expect(plan.mode).toBe("unavailable");
    expect(check(plan).rules.find((r) => r.rule === "plan_available")!.reason).toMatch(/Nfts/);

    const unk = structuredClone(facts);
    unk.capabilities["Assets.mint"] = { ...unk.capabilities["Assets.mint"], status: "unknown" };
    expect(check(H.compilePlan(), unk).rules.find((r) => r.rule === "capability" && r.outcome === "block")!.reason).toMatch(/never allowed/);
  });

  it("7. asset, contract or contract message not on the allowed list", () => {
    const m = H.demoManifest();
    (m.actions[0].args as Record<string, unknown>).assetId = "666";
    expect(blocked(check(H.compilePlan(m)), "asset_allowed")).toBe(true);
    const c = H.demoManifest();
    (c.actions[1].args as Record<string, unknown>).contract = H.BOB;
    expect(blocked(check(H.compilePlan(c)), "contract_allowed")).toBe(true);
    const s = H.demoManifest();
    (s.actions[1].args as Record<string, unknown>).data = "0xdeadbeef";
    expect(blocked(check(H.compilePlan(s)), "selector_allowed")).toBe(true);
  });

  it("8. amount, gas, weight or storage over the limit", () => {
    const m = H.demoManifest();
    (m.actions[0].args as Record<string, unknown>).amount = "5000000000000001";
    expect(blocked(check(H.compilePlan(m)), "amount_limit")).toBe(true);
    const g = H.demoManifest();
    (g.actions[1].args as Record<string, unknown>).gasLimit = "20000000000";
    expect(blocked(check(H.compilePlan(g)), "gas_limit")).toBe(true);
    const plan = H.compilePlan();
    const heavy = H.preflight(plan);
    heavy.steps[1].weight = { value: "2000000000" };
    heavy.steps[1].storageDeposit = { value: "1" };
    const r = evaluatePolicy({ policy: H.policy(), plan, facts, preflight: heavy });
    expect(blocked(r, "weight_limit")).toBe(true);
    expect(blocked(r, "storage_limit")).toBe(true);
  });

  it("9. sequential run fails at step 2: stop, never run step 3, partial receipt", () => {
    const done: ReceiptStep[] = [
      { actionId: "pay", status: "finalized", events: ["Assets.Transferred"], verification: "verified", reason: "ok" },
      { actionId: "call", status: "failed", events: ["System.ExtrinsicFailed"], verification: "not_verified", reason: "contract trapped" },
    ];
    const gate = canRunNextStep(done);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/call failed/);
    expect(overallResult([...done, { actionId: "receipt", status: "not_run", events: [], verification: "unknown", reason: gate.reason }])).toBe("partial");
  });

  it("10. wallet signed different bytes from the approved plan", () => {
    const run = approvedRun();
    const signed = callsToSign(run.plan) as Hex[];
    const swapped = [...signed];
    swapped[0] = (signed[0].slice(0, -2) + "ff") as Hex;
    expect(codes(submit(run, { signedCalls: swapped }))).toContain("signed_bytes_mismatch");
    expect(codes(submit(run, { signedCalls: signed.slice(0, 2) }))).toContain("signed_bytes_mismatch");
  });

  it("11. a step reports success but the expected event is missing", () => {
    const steps: ReceiptStep[] = [{ actionId: "pay", status: "finalized", events: ["System.ExtrinsicSuccess"], verification: "not_verified", reason: "no Assets.Transferred event" }];
    expect(overallResult(steps)).toBe("not_verified");
    expect(canRunNextStep(steps).ok).toBe(false);
  });

  it("12. atomic mode without a verified rollback", () => {
    const unverified = H.compilePlan(H.demoManifest(), facts, { allowAtomicUnverified: true });
    expect(unverified.mode).toBe("atomic_unverified");
    expect(blocked(check(unverified), "mode_allowed")).toBe(true);
    const verifiedFacts = { ...facts, behaviour: { batchAllRollback: "verified" as const } };
    const atomic = H.compilePlan(H.demoManifest(), verifiedFacts);
    expect(atomic.mode).toBe("atomic_verified");
    expect(check(atomic, verifiedFacts).allowed).toBe(true);
    expect(check(atomic, facts).rules.find((r) => r.rule === "mode_allowed")!.reason).toMatch(/rollback/);
    // An atomic plan signs exactly one batch_all call.
    const run = approvedRun(atomic, verifiedFacts);
    expect(callsToSign(atomic)).toEqual([atomic.outerCall!.encodedCall]);
    expect(codes(submit(run, { signedCalls: atomic.steps.map((s) => s.encodedCall!) }))).toContain("signed_bytes_mismatch");
  });

  it("13. pinned type definitions file changed after compiling", () => {
    const lock = checkRuntimeLock(fp, { ...fp, typesBundleHash: ("0x" + "22".repeat(32)) as Hex });
    expect(lock.changed).toEqual(["typesBundleHash"]);
    expect(lock.reason).toMatch(/type definitions/);
  });
});

describe("unknowns and approval rules", () => {
  it("blocks an unknown fee by default and allows it only when the policy says so", () => {
    const plan = H.compilePlan();
    const pf = { ...H.preflight(plan), totalFee: { unknown: true } };
    const strict = evaluatePolicy({ policy: H.policy(), plan, facts, preflight: pf });
    expect(strict.allowed).toBe(false);
    expect(strict.rules.find((r) => r.rule === "fee_limit")!.outcome).toBe("unknown");
    expect(evaluatePolicy({ policy: H.policy({ allowUnknown: { fee: true } }), plan, facts, preflight: pf }).allowed).toBe(true);
  });
  it("blocks when no preflight was run, or a dry run failed", () => {
    const plan = H.compilePlan();
    expect(evaluatePolicy({ policy: H.policy(), plan, facts }).allowed).toBe(false);
    const pf = H.preflight(plan);
    pf.steps[1].dryRun = "failed";
    expect(blocked(evaluatePolicy({ policy: H.policy(), plan, facts, preflight: pf }), "dry_run")).toBe(true);
  });
  it("blocks a plan compiled from a different Manifest or for a different signer", () => {
    const plan = H.compilePlan();
    const other = H.demoManifest();
    other.signer = { type: "ss58", value: H.BOB, ss58Prefix: 42 };
    const r = evaluatePolicy({ policy: H.policy(), plan, facts, preflight: H.preflight(plan), manifest: other });
    expect(blocked(r, "manifest_match")).toBe(true);
    expect(blocked(r, "signer_match")).toBe(true);
  });
  it("refuses to approve a blocked plan, or one whose envelope signer differs", () => {
    const plan = H.compilePlan();
    const policy = H.policy({ allowedRecipients: [] });
    const pr = evaluatePolicy({ policy, plan, facts, preflight: H.preflight(plan) });
    expect(createApproval({ manifestDigest: plan.manifestDigest, plan, envelope: H.envelope(), preflight: H.preflight(plan), policy, policyResult: pr, fingerprint: fp, now: H.NOW }).ok).toBe(false);
    const good = H.policy();
    const gpr = evaluatePolicy({ policy: good, plan, facts, preflight: H.preflight(plan) });
    expect(createApproval({ manifestDigest: plan.manifestDigest, plan, envelope: H.envelope({ signer: H.BOB }), preflight: H.preflight(plan), policy: good, policyResult: gpr, fingerprint: fp, now: H.NOW }).ok).toBe(false);
    expect(createApproval({ manifestDigest: plan.manifestDigest, plan, envelope: H.envelope({ signer: H.ALICE_HEX }), preflight: H.preflight(plan), policy: good, policyResult: gpr, fingerprint: fp, now: H.NOW }).ok).toBe(true);
  });
  it("caps approval lifetime at the policy maximum", () => {
    expect(approvedRun().approval.expiresAt).toBe("2026-10-20T10:10:00.000Z");
  });
  it("blocks a changed nonce or policy after approval", () => {
    const run = approvedRun();
    expect(codes(submit(run, { envelope: H.envelope({ nonce: 6 }) }))).toContain("approval_mismatch");
    expect(codes(submit(run, { policy: H.policy({ maxNativeValue: "999" }) }))).toContain("approval_mismatch");
  });
  it("needs a checkpoint block in the signing envelope, and binds it", () => {
    const plan = H.compilePlan();
    const policy = H.policy();
    const pr = evaluatePolicy({ policy, plan, facts, preflight: H.preflight(plan) });
    const noCp = { ...H.envelope(), checkpoint: undefined } as never;
    expect(createApproval({ manifestDigest: plan.manifestDigest, plan, envelope: noCp, preflight: H.preflight(plan), policy, policyResult: pr, fingerprint: fp, now: H.NOW }).ok).toBe(false);
    const run = approvedRun();
    const moved = H.envelope({ checkpoint: { number: 2721456, hash: ("0x" + "77".repeat(32)) as Hex } });
    expect(codes(submit(run, { envelope: moved }))).toContain("approval_mismatch");
  });
  it("requires a successful dry run of the signed transaction at the submit gate", () => {
    const run = approvedRun();
    expect(codes(submit(run, { signedDryRun: ["ok", "failed", "ok"] }))).toContain("signed_dry_run_failed");
    expect(codes(submit(run, { signedDryRun: undefined }))).toContain("signed_dry_run_missing");
    expect(codes(submit(run, { signedDryRun: ["ok", "unknown", "ok"] }))).toContain("signed_dry_run_missing");
  });
  it("Portaldot preset allows unknown storage deposit and pre-sign dry run, nothing else", async () => {
    const { portaldotPolicy } = await import("../src/index.js");
    const plan = H.compilePlan();
    const pf = H.preflight(plan);
    pf.steps.forEach((s) => { s.storageDeposit = { unknown: true }; s.dryRun = "unknown"; });
    const base = { allowedAssets: ["1", "2"], allowedContracts: [H.CHARLIE], allowedRecipients: [H.BOB] };
    expect(evaluatePolicy({ policy: portaldotPolicy(base), plan, facts, preflight: pf }).allowed).toBe(true);
    expect(evaluatePolicy({ policy: H.policy(), plan, facts, preflight: pf }).allowed).toBe(false);
    pf.totalFee = { unknown: true };
    expect(evaluatePolicy({ policy: portaldotPolicy(base), plan, facts, preflight: pf }).allowed).toBe(false);
  });
  it("sequential plans pass the gate one step at a time, with only the current step's dry run required", () => {
    const run = approvedRun();
    const store = new InMemoryApprovalStore();
    const { usageKey } = H;
    // Before anything is sent, later transactions can't dry-run yet (future nonce).
    const pre = ["ok", "unknown", "unknown"] as const;
    expect(codes(submit(run, { store, signedDryRun: [...pre] }))).toContain("signed_dry_run_missing");
    expect(submit(run, { store, signedDryRun: [...pre], sendIndex: 0, previousSteps: [] }).ok).toBe(true);
    store.markUsed(usageKey(run.approval.hash, 0));
    expect(codes(submit(run, { store, signedDryRun: [...pre], sendIndex: 0, previousSteps: [] }))).toContain("approval_reused");
    const done: ReceiptStep = { actionId: "pay", status: "finalized", events: ["Assets.Transferred"], verification: "verified", reason: "ok" };
    // Step 2 needs its own fresh dry run and step 1's result.
    expect(codes(submit(run, { store, signedDryRun: ["ok", "unknown", "unknown"], sendIndex: 1, previousSteps: [done] }))).toContain("signed_dry_run_missing");
    expect(codes(submit(run, { store, signedDryRun: ["ok", "ok", "unknown"], sendIndex: 1, previousSteps: [] }))).toContain("previous_steps_missing");
    expect(codes(submit(run, { store, signedDryRun: ["ok", "ok", "unknown"], sendIndex: 1, previousSteps: [{ ...done, verification: "not_verified" }] }))).toContain("previous_step_failed");
    expect(submit(run, { store, signedDryRun: ["ok", "ok", "unknown"], sendIndex: 1, previousSteps: [done] }).ok).toBe(true);
    // Skipping ahead is blocked.
    expect(codes(submit(run, { store: new InMemoryApprovalStore(), signedDryRun: ["ok", "ok", "ok"], sendIndex: 2, previousSteps: [done, done] }))).toContain("out_of_order");
    // A runtime change between steps still blocks the next step.
    expect(codes(submit(run, { store, signedDryRun: ["ok", "ok", "unknown"], sendIndex: 1, previousSteps: [done], currentFingerprint: { ...run.fingerprint, specVersion: 1003 } }))).toContain("runtime_changed");
  });
  it("atomic plans can't be sent step by step", () => {
    const verifiedFacts = { ...facts, behaviour: { batchAllRollback: "verified" as const } };
    const atomic = H.compilePlan(H.demoManifest(), verifiedFacts);
    const run = approvedRun(atomic, verifiedFacts);
    expect(codes(submit(run, { sendIndex: 0, previousSteps: [] }))).toContain("send_index_invalid");
  });
});
