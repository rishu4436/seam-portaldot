import { describe, it, expect } from "vitest";
import {
  evaluatePolicy, createApproval, checkBeforeSubmit, InMemoryApprovalStore, canRunNextStep, overallResult,
  checkRuntimeLock, digest, decodeSs58, type BoundApproval, type Plan, type ReceiptStep,
} from "../src/index.js";
import * as F from "./fixtures.js";

const fp = F.fingerprint();

function approvedRun(over: { plan?: Plan } = {}) {
  const plan = over.plan ?? F.plan(fp);
  const policy = F.policy();
  const preflight = F.preflight();
  const policyResult = evaluatePolicy({ policy, plan, facts: F.facts(fp), preflight, manifest: F.manifest() });
  const envelope = F.envelope();
  const out = createApproval({ manifestDigest: plan.manifestDigest, plan, envelope, preflight, policy, policyResult, fingerprint: fp, now: F.NOW });
  if (!out.ok) throw new Error(out.reason);
  return { plan, policy, preflight, policyResult, envelope, approval: out.approval as BoundApproval };
}

function submit(run: ReturnType<typeof approvedRun>, over: Partial<Parameters<typeof checkBeforeSubmit>[0]> = {}) {
  return checkBeforeSubmit({
    approval: run.approval, manifestDigest: run.plan.manifestDigest, plan: run.plan, envelope: run.envelope,
    preflight: run.preflight, policy: run.policy, policyResult: run.policyResult,
    preparedFingerprint: fp, currentFingerprint: fp,
    signedCalls: run.plan.steps.map((s) => s.encodedCall!), now: F.NOW, store: new InMemoryApprovalStore(),
    ...over,
  });
}
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);
const blocked = (r: { rules: { rule: string; outcome: string }[] }, rule: string) => r.rules.some((x) => x.rule === rule && x.outcome !== "pass");

describe("happy path", () => {
  it("allows the demo flow, approves it and lets it through the submit gate", () => {
    const run = approvedRun();
    expect(run.policyResult.allowed).toBe(true);
    expect(run.approval.covers).toContain("encoded calls");
    expect(submit(run)).toEqual({ ok: true, reasons: [] });
  });
  it("produces the same digest for the same input regardless of key order", () => {
    expect(digest("d", { a: 1, b: [1, { y: 2, x: 1 }] })).toBe(digest("d", { b: [1, { x: 1, y: 2 }], a: 1 }));
    expect(digest("d1", { a: 1 })).not.toBe(digest("d2", { a: 1 }));
  });
  it("encodes SS58 addresses compatibly with Substrate (Alice, prefix 42)", () => {
    expect(F.ALICE).toBe("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
    const d = decodeSs58(F.ALICE);
    expect("prefix" in d && d.prefix).toBe(42);
  });
});

describe("attack cases", () => {
  it("1. recipient or amount changed after approval", () => {
    const run = approvedRun();
    const tampered = structuredClone(run.plan);
    tampered.steps[0].decoded.recipient = F.MALLORY;
    expect(codes(submit(run, { plan: tampered }))).toContain("approval_mismatch");
    const bigger = structuredClone(run.plan);
    bigger.steps[0].decoded.amount = "4999";
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
    const upgraded = F.fingerprint({ specVersion: 1003 });
    const r = submit(run, { currentFingerprint: upgraded });
    expect(codes(r)).toContain("runtime_changed");
    expect(r.reasons.find((x) => x.code === "runtime_changed")!.message).toMatch(/runtime version/);
    expect(blocked(evaluatePolicy({ policy: run.policy, plan: run.plan, facts: F.facts(upgraded), preflight: run.preflight }), "runtime_match")).toBe(true);
  });

  it("4. metadata changed while the spec version stayed the same", () => {
    const lock = checkRuntimeLock(fp, F.fingerprint({ metadataHash: ("0x" + "99".repeat(32)) as `0x${string}` }));
    expect(lock.ok).toBe(false);
    expect(lock.changed).toEqual(["metadataHash"]);
    expect(codes(submit(approvedRun(), { currentFingerprint: F.fingerprint({ metadataHash: ("0x" + "99".repeat(32)) as `0x${string}` }) }))).toContain("runtime_changed");
  });

  it("5. wrong address type, wrong network prefix or bad checksum", () => {
    const m = F.manifest();
    const h160 = structuredClone(m);
    h160.actions[0].args.to = { type: "H160", value: "0x" + "12".repeat(20) };
    expect(blocked(evaluatePolicy({ policy: F.policy(), plan: F.plan(fp), facts: F.facts(fp), preflight: F.preflight(), manifest: h160 }), "address_check")).toBe(true);

    const polkadotPrefix = structuredClone(m); // Bob encoded with Polkadot's prefix 0
    polkadotPrefix.actions[0].args.to = { type: "SS58", value: "14E5nqKAp3oAJcmzgZhUD2RcptBeUBScxKHgJKU4HPNcKVf3" };
    const r = evaluatePolicy({ policy: F.policy(), plan: F.plan(fp), facts: F.facts(fp), preflight: F.preflight(), manifest: polkadotPrefix });
    expect(r.rules.find((x) => x.rule === "address_check")?.reason).toMatch(/prefix 0/);

    const badSum = structuredClone(m);
    badSum.actions[0].args.to = { type: "SS58", value: F.BOB.slice(0, -1) + (F.BOB.endsWith("a") ? "b" : "a") };
    expect(blocked(evaluatePolicy({ policy: F.policy(), plan: F.plan(fp), facts: F.facts(fp), preflight: F.preflight(), manifest: badSum }), "address_check")).toBe(true);
  });

  it("6. capability not observed or unknown", () => {
    const nft = F.plan(fp);
    nft.steps[2] = { ...nft.steps[2], capability: "Nfts.mint" };
    const r = evaluatePolicy({ policy: F.policy(), plan: nft, facts: F.facts(fp), preflight: F.preflight() });
    expect(r.allowed).toBe(false);
    expect(r.rules.find((x) => x.rule === "capability" && x.outcome === "block")!.reason).toMatch(/Nfts.mint is not available/);
    const unk = F.plan(fp);
    unk.steps[2] = { ...unk.steps[2], capability: "Assets.freeze" };
    expect(evaluatePolicy({ policy: F.policy(), plan: unk, facts: F.facts(fp), preflight: F.preflight() }).rules
      .find((x) => x.rule === "capability" && x.outcome === "block")!.reason).toMatch(/never allowed/);
  });

  it("7. asset or contract not on the allowed list", () => {
    const p = F.plan(fp);
    p.steps[0].decoded.assetId = "666";
    expect(blocked(evaluatePolicy({ policy: F.policy(), plan: p, facts: F.facts(fp), preflight: F.preflight() }), "asset_allowed")).toBe(true);
    const c = F.plan(fp);
    c.steps[1].decoded.contract = "0x" + "cd".repeat(32);
    expect(blocked(evaluatePolicy({ policy: F.policy(), plan: c, facts: F.facts(fp), preflight: F.preflight() }), "contract_allowed")).toBe(true);
  });

  it("8. amount, weight or storage over the limit", () => {
    const p = F.plan(fp);
    p.steps[0].decoded.amount = "5001";
    expect(blocked(evaluatePolicy({ policy: F.policy(), plan: p, facts: F.facts(fp), preflight: F.preflight() }), "amount_limit")).toBe(true);
    const heavy = F.preflight();
    heavy.steps[1].weight = { value: "2000000000" };
    heavy.steps[1].storageDeposit = { value: "1" };
    const r = evaluatePolicy({ policy: F.policy(), plan: F.plan(fp), facts: F.facts(fp), preflight: heavy });
    expect(blocked(r, "weight_limit")).toBe(true);
    expect(blocked(r, "storage_limit")).toBe(true);
  });

  it("9. sequential run fails at step 2: stop, never run step 3, partial receipt", () => {
    const done: ReceiptStep[] = [
      { actionId: "pay", status: "finalized", events: ["Assets.Transferred"], verification: "verified", reason: "ok" },
      { actionId: "settle", status: "failed", events: ["System.ExtrinsicFailed"], verification: "not_verified", reason: "contract trapped" },
    ];
    const gate = canRunNextStep(done);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/settle failed/);
    expect(overallResult([...done, { actionId: "receipt", status: "not_run", events: [], verification: "unknown", reason: gate.reason }])).toBe("partial");
  });

  it("10. wallet signed different bytes from the approved plan", () => {
    const run = approvedRun();
    const signed = run.plan.steps.map((s) => s.encodedCall!);
    signed[0] = "0x0c09aa02";
    expect(codes(submit(run, { signedCalls: signed }))).toContain("signed_bytes_mismatch");
    expect(codes(submit(run, { signedCalls: signed.slice(0, 2) }))).toContain("signed_bytes_mismatch");
  });

  it("11. a step reports success but the expected event is missing", () => {
    const steps: ReceiptStep[] = [
      { actionId: "pay", status: "finalized", events: ["System.ExtrinsicSuccess"], verification: "not_verified", reason: "no Assets.Transferred event" },
    ];
    expect(overallResult(steps)).toBe("not_verified");
    expect(canRunNextStep(steps).ok).toBe(false);
  });

  it("12. atomic mode requested without a tested rollback", () => {
    const unverified = F.plan(fp, { mode: "atomic_unverified" });
    expect(blocked(evaluatePolicy({ policy: F.policy(), plan: unverified, facts: F.facts(fp), preflight: F.preflight() }), "mode_allowed")).toBe(true);
    const verified = F.plan(fp, { mode: "atomic_verified" });
    expect(evaluatePolicy({ policy: F.policy(), plan: verified, facts: F.facts(fp), preflight: F.preflight() }).rules
      .find((x) => x.rule === "mode_allowed")!.reason).toMatch(/rollback/);
  });

  it("13. pinned type definitions file changed after compiling", () => {
    const lock = checkRuntimeLock(fp, F.fingerprint({ typesFileHash: ("0x" + "22".repeat(32)) as `0x${string}` }));
    expect(lock.changed).toEqual(["typesFileHash"]);
    expect(lock.reason).toMatch(/type definitions/);
  });
});

describe("unknowns and approval rules", () => {
  it("blocks an unknown fee by default and allows it only when the policy says so", () => {
    const pf = F.preflight({ totalFee: { unknown: true } });
    const strict = evaluatePolicy({ policy: F.policy(), plan: F.plan(fp), facts: F.facts(fp), preflight: pf });
    expect(strict.allowed).toBe(false);
    expect(strict.rules.find((r) => r.rule === "fee_limit")!.outcome).toBe("unknown");
    expect(evaluatePolicy({ policy: F.policy({ allowUnknown: { fee: true } }), plan: F.plan(fp), facts: F.facts(fp), preflight: pf }).allowed).toBe(true);
  });
  it("blocks when no preflight was run", () => {
    expect(evaluatePolicy({ policy: F.policy(), plan: F.plan(fp), facts: F.facts(fp) }).allowed).toBe(false);
  });
  it("blocks a failed dry run", () => {
    const pf = F.preflight();
    pf.steps[1].dryRun = "failed";
    expect(blocked(evaluatePolicy({ policy: F.policy(), plan: F.plan(fp), facts: F.facts(fp), preflight: pf }), "dry_run")).toBe(true);
  });
  it("refuses to approve a blocked plan, or one whose envelope signer differs", () => {
    const p = F.plan(fp);
    p.steps[0].decoded.assetId = "666";
    const policy = F.policy();
    const pr = evaluatePolicy({ policy, plan: p, facts: F.facts(fp), preflight: F.preflight() });
    const out = createApproval({ manifestDigest: p.manifestDigest, plan: p, envelope: F.envelope(), preflight: F.preflight(), policy, policyResult: pr, fingerprint: fp, now: F.NOW });
    expect(out.ok).toBe(false);
    const good = F.plan(fp);
    const gpr = evaluatePolicy({ policy, plan: good, facts: F.facts(fp), preflight: F.preflight() });
    const wrong = createApproval({ manifestDigest: good.manifestDigest, plan: good, envelope: F.envelope({ signer: F.BOB }), preflight: F.preflight(), policy, policyResult: gpr, fingerprint: fp, now: F.NOW });
    expect(wrong.ok).toBe(false);
  });
  it("caps approval lifetime at the policy maximum", () => {
    expect(approvedRun().approval.expiresAt).toBe("2026-10-20T10:10:00.000Z");
  });
  it("blocks a changed nonce or policy after approval", () => {
    const run = approvedRun();
    expect(codes(submit(run, { envelope: F.envelope({ nonce: 6 }) }))).toContain("approval_mismatch");
    expect(codes(submit(run, { policy: F.policy({ maxNativeValue: "999" }) }))).toContain("approval_mismatch");
  });
});
