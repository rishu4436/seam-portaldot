// Audit regression tests: SEAM-002 (sequential gating), SEAM-005 (approval reserve/commit lifecycle),
// SEAM-017 (deny-by-default across action types), SEAM-001 gate side (trusted decoder instead of wallet-reported calls).
import { describe, it, expect } from "vitest";
import {
  evaluatePolicy,
  createApproval,
  checkBeforeSubmit,
  InMemoryApprovalStore,
  canRunNextStep,
  overallResult,
  markNotRun,
  callsToSign,
  usageKey,
  planDigest,
  definePolicy,
  type BoundApproval,
  type Plan,
  type PlanStep,
  type ReceiptStep,
  type RuntimeFacts,
  type Hex,
  type Policy,
  type DecodedSignedExtrinsic,
} from "../src/index.js";
import * as H from "./helpers.js";

const facts = H.realFacts();
const fp = facts.fingerprint;
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

function approvedRun(plan: Plan = H.compilePlan()) {
  const policy = H.policy();
  const preflight = H.preflight(plan);
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
    fingerprint: fp,
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
type Run = ReturnType<typeof approvedRun>;
function gate(run: Run, over: Partial<Parameters<typeof checkBeforeSubmit>[0]> = {}) {
  return checkBeforeSubmit({
    approval: run.approval,
    manifestDigest: run.plan.manifestDigest,
    plan: run.plan,
    envelope: run.envelope,
    preflight: run.preflight,
    policy: run.policy,
    policyResult: run.policyResult,
    preparedFingerprint: fp,
    currentFingerprint: fp,
    signedCalls: callsToSign(run.plan) as Hex[],
    signedDryRun: callsToSign(run.plan).map(() => "ok" as const),
    now: H.NOW,
    store: new InMemoryApprovalStore(),
    ...over,
  });
}

const H1 = ("0x" + "11".repeat(32)) as Hex;
const good = (id: string): ReceiptStep => ({
  actionId: id,
  status: "finalized",
  txHash: H1,
  block: { number: 10, hash: H1 },
  events: ["Assets.Transferred"],
  verification: "verified",
  reason: "ok",
});

describe("SEAM-002: dependent steps need finalized + verified", () => {
  it("allows only a finalized, verified step with receipt data", () => {
    expect(canRunNextStep([good("pay")]).ok).toBe(true);
    expect(canRunNextStep([]).ok).toBe(true);
  });
  const cases: [string, Partial<ReceiptStep>, string][] = [
    ["finalized but verification unknown", { verification: "unknown" }, "verification_unknown"],
    ["included + unknown", { status: "included", verification: "unknown" }, "step_not_finalized"],
    ["included + verified", { status: "included" }, "step_not_finalized"],
    ["submitted + verified", { status: "submitted" }, "step_not_finalized"],
    ["uncertain + verified", { status: "uncertain" }, "step_not_finalized"],
    ["not_run", { status: "not_run" }, "step_not_finalized"],
    ["finalized but not_verified", { verification: "not_verified" }, "verification_failed"],
    [
      "failed contract outcome",
      { status: "failed", verification: "not_verified", events: ["Contracts.ContractTrapped"] },
      "step_failed",
    ],
    [
      "finalized, verified but ExtrinsicFailed event",
      { events: ["System.ExtrinsicFailed"] },
      "contract_outcome_failed",
    ],
    ["finalized, verified, no tx hash", { txHash: undefined }, "receipt_data_missing"],
    ["finalized, verified, no block", { block: undefined }, "receipt_data_missing"],
  ];
  for (const [name, patch, code] of cases) {
    it(`blocks: ${name}`, () => {
      const r = canRunNextStep([{ ...good("pay"), ...patch }]);
      expect(r.ok).toBe(false);
      expect(r.code).toBe(code);
      expect(r.reason).toMatch(/Stopped/);
    });
  }
  it("blocks on the first bad step among several", () => {
    const r = canRunNextStep([good("a"), { ...good("b"), verification: "unknown" }, good("c")]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("b");
  });
  it("the submit gate refuses step 2 after finalized-unknown and after included", () => {
    const plan = H.compilePlan(); // sequential demo plan
    expect(plan.mode).toBe("sequential");
    const run = approvedRun(plan);
    const store = new InMemoryApprovalStore();
    store.markUsed(usageKey(run.approval.hash, 0));
    const base = { store, sendIndex: 1, signedDryRun: ["ok" as const] };
    expect(codes(gate(run, { ...base, previousSteps: [good("pay")] }))).not.toContain(
      "previous_step_failed",
    );
    for (const patch of [
      { verification: "unknown" as const },
      { status: "included" as const },
      { status: "submitted" as const },
      { verification: "not_verified" as const },
      { txHash: undefined },
    ]) {
      const c = codes(gate(run, { ...base, previousSteps: [{ ...good("pay"), ...patch }] }));
      expect(c).toContain("previous_step_failed");
    }
  });
  it("markNotRun fills later steps as not_run and the receipt is partial", () => {
    const steps = markNotRun(
      [{ ...good("pay"), verification: "unknown" }],
      ["pay", "call", "receipt"],
      "Stopped: pay did not verify",
    );
    expect(steps.map((s) => s.status)).toEqual(["finalized", "not_run", "not_run"]);
    expect(steps[2].reason).toMatch(/Stopped/);
    expect(overallResult(steps)).toBe("partial");
  });
  it("overallResult is never verified with an unknown step", () => {
    expect(overallResult([{ ...good("a"), verification: "unknown" }])).toBe("not_verified");
  });
});

describe("SEAM-005: reserve / commit / release / markUncertain", () => {
  const key = "0xabc";
  it("a reserved key cannot be reserved again concurrently", () => {
    const s = new InMemoryApprovalStore();
    const a = s.reserve(key, { idempotencyKey: "idem-1" });
    expect(a.ok).toBe(true);
    const b = s.reserve(key, { idempotencyKey: "idem-2" });
    expect(b).toMatchObject({ ok: false, reason: "reserved" });
    expect(s.stateOf(key)?.state).toBe("reserved");
  });
  it("commit records tx hash + idempotency key and blocks reuse", () => {
    const s = new InMemoryApprovalStore();
    s.reserve(key, { idempotencyKey: "idem-1" });
    s.commit(key, { txHash: H1 });
    expect(s.has(key)).toBe(true);
    expect(s.stateOf(key)).toMatchObject({
      state: "committed",
      txHash: H1,
      idempotencyKey: "idem-1",
    });
    expect(s.reserve(key, { idempotencyKey: "idem-1" })).toMatchObject({
      ok: false,
      reason: "committed",
      txHash: H1,
    });
  });
  it("release (definitely not broadcast) makes it reservable again", () => {
    const s = new InMemoryApprovalStore();
    s.reserve(key, { idempotencyKey: "i" });
    s.release(key);
    expect(s.stateOf(key)).toBeUndefined();
    expect(s.reserve(key, { idempotencyKey: "i2" }).ok).toBe(true);
  });
  it("uncertain blocks reuse and release until reconciled", () => {
    const s = new InMemoryApprovalStore();
    s.reserve(key, { idempotencyKey: "i" });
    s.markUncertain(key, { txHash: H1, note: "RPC timeout" });
    expect(s.reserve(key, { idempotencyKey: "i" })).toMatchObject({
      ok: false,
      reason: "uncertain",
    });
    expect(() => s.release(key)).toThrow(/uncertain/);
    expect(s.has(key)).toBe(true);
    s.reconcile(key, { outcome: "not_broadcast" });
    expect(s.reserve(key, { idempotencyKey: "i" }).ok).toBe(true);
  });
  it("reconcile as broadcast commits it", () => {
    const s = new InMemoryApprovalStore();
    s.reserve(key, { idempotencyKey: "i" });
    s.markUncertain(key, {});
    s.reconcile(key, { outcome: "broadcast", txHash: H1 });
    expect(s.stateOf(key)).toMatchObject({ state: "committed", txHash: H1 });
  });
  it("commit/markUncertain without a reservation throws", () => {
    const s = new InMemoryApprovalStore();
    expect(() => s.commit(key, { txHash: H1 })).toThrow();
    expect(() => s.markUncertain(key, {})).toThrow();
  });
  it("markUsed still works (backwards compatible) and is final", () => {
    const s = new InMemoryApprovalStore();
    s.markUsed(key);
    expect(s.has(key)).toBe(true);
    expect(s.reserve(key, { idempotencyKey: "x" })).toMatchObject({
      ok: false,
      reason: "committed",
    });
  });
  it("the gate blocks while reserved or uncertain, with distinct codes", () => {
    const run = approvedRun();
    const s = new InMemoryApprovalStore();
    s.reserve(run.approval.hash, { idempotencyKey: "i" });
    expect(codes(gate(run, { store: s }))).toContain("approval_reserved");
    s.markUncertain(run.approval.hash, { txHash: H1 });
    expect(codes(gate(run, { store: s }))).toContain("approval_uncertain");
    s.reconcile(run.approval.hash, { outcome: "broadcast", txHash: H1 });
    expect(codes(gate(run, { store: s }))).toContain("approval_reused");
  });
  it("gate passes after release", () => {
    const run = approvedRun();
    const s = new InMemoryApprovalStore();
    s.reserve(run.approval.hash, { idempotencyKey: "i" });
    s.release(run.approval.hash);
    expect(gate(run, { store: s }).ok).toBe(true);
  });
});

// ---------- SEAM-017 ----------
const REV = "0x" + "ab".repeat(20);
const ALL_KINDS = [
  "assets.transfer",
  "assets.mint",
  "contracts.call",
  "revive.call",
  "nfts.mint",
] as const;

function factsWith(over: Record<string, unknown>): RuntimeFacts {
  const f = structuredClone(facts) as RuntimeFacts;
  Object.assign(f.capabilities, over);
  return f;
}
const OBS = (p: number, c: number) => ({ status: "observed", palletIndex: p, callIndex: c });
const f2 = factsWith({ "revive.call": OBS(60, 6), "nfts.mint": OBS(52, 3) });

function stepOf(kind: (typeof ALL_KINDS)[number], args: Record<string, string> = {}): PlanStep {
  const hex2 = (n: number) => n.toString(16).padStart(2, "0");
  const base = H.compilePlan();
  const pick = (k: string) => base.steps.find((s) => s.kind === k);
  if (kind === "assets.transfer" || kind === "assets.mint" || kind === "contracts.call") {
    const s = structuredClone(pick(kind)!);
    s.decodedArgs = { ...s.decodedArgs, ...args };
    return s;
  }
  const [p, c] = kind === "revive.call" ? [60, 6] : [52, 3];
  const decoded =
    kind === "revive.call"
      ? {
          contract: REV,
          value: "0",
          gasLimit: "5000000000",
          // Every compiled revive.call carries an explicit proof size cap (a missing one now blocks CALL_GAS_LIMIT_MISSING).
          proofSize: "500",
          data: "0x633aa551",
        }
      : { recipient: H.BOB, assetId: "1", amount: "1" };
  return {
    actionId: "s1",
    kind,
    capability: kind === "revive.call" ? "Revive.call" : "Nfts.mint",
    palletIndex: p,
    callIndex: c,
    decodedArgs: { ...decodedArgs(decoded), ...args },
    encodedCall: ("0x" + hex2(p) + hex2(c) + "00") as Hex,
    status: "ok",
  };
}
const decodedArgs = (d: Record<string, string>) => d;

function planWith(step: PlanStep, extra: Partial<Plan> = {}): Plan {
  const p = structuredClone(H.compilePlan()) as Plan;
  p.steps = [{ ...step, actionId: "s1" }];
  p.mode = "sequential";
  delete (p as { outerCall?: unknown }).outerCall;
  Object.assign(p, extra);
  return { ...p, planDigest: planDigest(p) };
}
// the facts' capability keys are "Pallet.call_name"
function key(step: PlanStep) {
  return step.capability;
}

function evalWith(
  step: PlanStep,
  policyOver: Partial<Policy> = {},
  f: RuntimeFacts = f2,
  pre = true,
) {
  const f3 = structuredClone(f) as RuntimeFacts;
  f3.capabilities[key(step)] = OBS(step.palletIndex!, step.callIndex!) as never;
  const plan = planWith(step);
  plan.fingerprintDigest = f3.fingerprintDigest;
  const p2 = { ...plan, planDigest: planDigest(plan) };
  const pf = pre ? H.preflight(p2) : undefined;
  const policy = H.policy({
    allowedCapabilities: "any",
    allowedContracts: [H.CHARLIE, REV],
    allowedSelectors: undefined,
    maxNativeValue: "0",
    ...policyOver,
  });
  return {
    result: evaluatePolicy({ policy, plan: p2, facts: f3, preflight: pf }),
    plan: p2,
    f3,
    policy,
  };
}
const bad = (r: { rules: { rule: string; outcome: string }[] }, rule: string) =>
  r.rules.some((x) => x.rule === rule && x.outcome !== "pass");

describe("SEAM-017: deny-by-default across every action type", () => {
  for (const kind of ALL_KINDS) {
    describe(kind, () => {
      const step = () => stepOf(kind);
      it("baseline: recognised + within policy is evaluated without a capability block", () => {
        const { result } = evalWith(step(), {
          allowedAssets: ["1", "2"],
          allowedRecipients: [H.BOB],
          allowedContracts: [H.CHARLIE, REV],
        });
        expect(bad(result, "capability")).toBe(false);
      });
      it("blocks a capability the facts do not list", () => {
        const s = step();
        const plan = planWith(s);
        const f = structuredClone(facts) as RuntimeFacts;
        delete f.capabilities[s.capability];
        plan.fingerprintDigest = f.fingerprintDigest;
        const p2 = { ...plan, planDigest: planDigest(plan) };
        const r = evaluatePolicy({
          policy: H.policy(),
          plan: p2,
          facts: f,
          preflight: H.preflight(p2),
        });
        expect(r.allowed).toBe(false);
        expect(bad(r, "capability")).toBe(true);
      });
      for (const st of ["unknown", "not_observed"] as const) {
        it(`blocks a ${st} capability even if the policy allows "any"`, () => {
          const s = step();
          const plan = planWith(s);
          const f = structuredClone(f2) as RuntimeFacts;
          f.capabilities[s.capability] = { status: st } as never;
          plan.fingerprintDigest = f.fingerprintDigest;
          const p2 = { ...plan, planDigest: planDigest(plan) };
          const r = evaluatePolicy({
            policy: H.policy({
              allowedCapabilities: "any",
              allowUnknown: {
                fee: true,
                weight: true,
                dryRun: true,
                storageDeposit: true,
                proofSize: true,
              },
            }),
            plan: p2,
            facts: f,
            preflight: H.preflight(p2),
          });
          expect(r.allowed).toBe(false);
          expect(bad(r, "capability")).toBe(true);
        });
      }
      it("blocks a capability not on the policy's allowed list", () => {
        const { result } = evalWith(step(), { allowedCapabilities: ["Balances.transfer"] });
        expect(result.allowed).toBe(false);
        expect(bad(result, "capability")).toBe(true);
      });
      it("blocks a call index that does not match the runtime", () => {
        const s = step();
        const { f3 } = evalWith(s);
        f3.capabilities[s.capability] = OBS(s.palletIndex! + 1, s.callIndex!) as never;
        const plan = planWith(s);
        plan.fingerprintDigest = f3.fingerprintDigest;
        const p2 = { ...plan, planDigest: planDigest(plan) };
        expect(
          bad(
            evaluatePolicy({ policy: H.policy(), plan: p2, facts: f3, preflight: H.preflight(p2) }),
            "call_index",
          ),
        ).toBe(true);
      });
      // The pre-sign prefix check was removed (Anchor, P0-02 plan-bytes gate): a prefix match proved little, since an
      // edited plan keeps the right prefix. Call bytes are now proven byte for byte against a fresh compile of the
      // Manifest by createApproval / checkBeforeSubmit (verifyPlan), see test/plan-bytes-gate.test.ts.
      it("does not judge call bytes pre-sign (no prefix check); a step with no bytes still blocks", () => {
        const s = { ...step(), encodedCall: "0xffff00" as Hex };
        expect(bad(evalWith(s).result, "call_index")).toBe(false);
        expect(bad(evalWith({ ...step(), encodedCall: undefined }).result, "call_index")).toBe(
          true,
        );
      });
      it("blocks an unavailable step and a missing preflight", () => {
        expect(bad(evalWith({ ...step(), status: "unavailable" }).result, "step_available")).toBe(
          true,
        );
        const r = evalWith(step(), {}, f2, false).result;
        expect(r.allowed).toBe(false);
        expect(bad(r, "preflight")).toBe(true);
      });
      it("blocks maxSteps exceeded", () => {
        const s = step();
        const { f3 } = evalWith(s);
        const plan = planWith(s);
        plan.steps = [s, { ...s, actionId: "s2" }];
        plan.fingerprintDigest = f3.fingerprintDigest;
        const p2 = { ...plan, planDigest: planDigest(plan) };
        expect(
          bad(
            evaluatePolicy({
              policy: H.policy({ maxSteps: 1 }),
              plan: p2,
              facts: f3,
              preflight: H.preflight(p2),
            }),
            "max_steps",
          ),
        ).toBe(true);
      });
      it("blocks a disallowed mode", () => {
        const s = step();
        const { f3 } = evalWith(s);
        const plan = planWith(s);
        plan.fingerprintDigest = f3.fingerprintDigest;
        const p2 = { ...plan, planDigest: planDigest(plan) };
        expect(
          bad(
            evaluatePolicy({
              policy: H.policy({ allowedModes: ["atomic_verified"] }),
              plan: p2,
              facts: f3,
              preflight: H.preflight(p2),
            }),
            "mode_allowed",
          ),
        ).toBe(true);
      });
    });
  }

  describe("per-argument caps and lists (every kind that carries the argument)", () => {
    it("recipient / asset not allowed", () => {
      for (const kind of ["assets.transfer", "assets.mint", "nfts.mint"] as const) {
        expect(
          bad(
            evalWith(stepOf(kind, { recipient: H.CHARLIE }), { allowedRecipients: [H.BOB] }).result,
            "recipient_allowed",
          ),
        ).toBe(true);
        expect(
          bad(
            evalWith(stepOf(kind, { assetId: "99" }), { allowedAssets: ["1"] }).result,
            "asset_allowed",
          ),
        ).toBe(true);
      }
    });
    it("amount over cap, non-integer, negative, hex, and missing limit", () => {
      for (const kind of ["assets.transfer", "assets.mint", "nfts.mint"] as const) {
        const lim = { maxAmountPerAsset: { "1": "10" } };
        expect(
          bad(evalWith(stepOf(kind, { assetId: "1", amount: "11" }), lim).result, "amount_limit"),
        ).toBe(true);
        for (const a of ["1.5", "-1", "0x10", "1e3", "", " 5"])
          expect(
            bad(evalWith(stepOf(kind, { assetId: "1", amount: a }), lim).result, "amount_limit"),
          ).toBe(true);
        expect(
          bad(
            evalWith(stepOf(kind, { assetId: "7", amount: "1" }), {
              allowedAssets: "any",
              maxAmountPerAsset: { "1": "10" },
            }).result,
            "amount_limit",
          ),
        ).toBe(true);
        expect(
          bad(evalWith(stepOf(kind, { assetId: "1", amount: "10" }), lim).result, "amount_limit"),
        ).toBe(false);
      }
    });
    it("contract not allowed; selector not allowed; named message / ABI pins deny raw data", () => {
      for (const kind of ["contracts.call", "revive.call"] as const) {
        const addr = kind === "revive.call" ? REV : H.CHARLIE;
        expect(
          bad(evalWith(stepOf(kind), { allowedContracts: [] }).result, "contract_allowed"),
        ).toBe(true);
        expect(
          bad(
            evalWith(stepOf(kind, { data: "0xdeadbeef" }), {
              allowedContracts: [addr],
              allowedSelectors: { [addr]: ["0x633aa551"] },
            }).result,
            "selector_allowed",
          ),
        ).toBe(true);
        expect(
          bad(
            evalWith(stepOf(kind), {
              allowedContracts: [addr],
              allowedSelectors: { [addr]: ["0x633aa551"] },
            }).result,
            "selector_allowed",
          ),
        ).toBe(false);
        expect(
          bad(
            evalWith(stepOf(kind), {
              allowedContracts: [addr],
              allowedMessages: { [addr]: ["settle"] },
            }).result,
            "message_not_allowed",
          ),
        ).toBe(true);
        expect(
          bad(
            evalWith(stepOf(kind), {
              allowedContracts: [addr],
              pinnedAbiHashes: { [addr]: "0x" + "cd".repeat(32) },
            }).result,
            "abi_hash_missing",
          ),
        ).toBe(true);
      }
    });
    it("a selector can't be smuggled by short/empty/uppercase-mangled calldata", () => {
      for (const kind of ["contracts.call", "revive.call"] as const) {
        const addr = kind === "revive.call" ? REV : H.CHARLIE;
        const pol = { allowedContracts: [addr], allowedSelectors: { [addr]: ["0x633aa551"] } };
        for (const data of ["0x", "0x63", "0x633aa5", "0x633aa550", "0x00633aa551"]) {
          expect(bad(evalWith(stepOf(kind, { data }), pol).result, "selector_allowed")).toBe(true);
        }
      }
    });
    it("value, gas, proof size, storage deposit caps; null storage limit", () => {
      for (const kind of ["contracts.call", "revive.call"] as const) {
        const addr = kind === "revive.call" ? REV : H.CHARLIE;
        const pol = { allowedContracts: [addr] };
        expect(
          bad(
            evalWith(stepOf(kind, { value: "1" }), { ...pol, maxNativeValue: "0" }).result,
            "native_value_limit",
          ),
        ).toBe(true);
        expect(
          bad(
            evalWith(stepOf(kind, { gasLimit: "99999999999" }), { ...pol, maxGasLimit: "10" })
              .result,
            "gas_limit",
          ),
        ).toBe(true);
        expect(
          bad(
            evalWith(stepOf(kind, { proofSize: "100" }), { ...pol, maxProofSize: "10" }).result,
            "proof_size_limit",
          ),
        ).toBe(true);
        expect(
          bad(
            evalWith(stepOf(kind, { storageDepositLimit: "100" }), {
              ...pol,
              maxStorageDeposit: "10",
            }).result,
            "storage_limit",
          ),
        ).toBe(true);
        expect(
          bad(
            evalWith(stepOf(kind, { storageDepositLimit: null as unknown as string }), {
              ...pol,
              maxStorageDeposit: "10",
            }).result,
            "storage_limit",
          ),
        ).toBe(true);
        for (const v of ["-1", "1.0", "0x1", "abc"])
          expect(bad(evalWith(stepOf(kind, { value: v }), pol).result, "native_value_limit")).toBe(
            true,
          );
      }
    });
    it("preflight fee / weight / storage over caps for every kind", () => {
      for (const kind of ALL_KINDS) {
        const { plan, f3, policy } = evalWith(stepOf(kind));
        const pf = H.preflight(plan);
        pf.steps[0] = {
          ...pf.steps[0],
          weight: { value: "99999999999" },
          storageDeposit: { value: "5" },
        };
        pf.totalFee = { value: "99999999999" };
        const r = evaluatePolicy({ policy, plan, facts: f3, preflight: pf });
        expect(r.allowed).toBe(false);
        for (const rule of ["weight_limit", "storage_limit", "fee_limit"])
          expect(bad(r, rule)).toBe(true);
      }
    });
    it("preflight step for an action not in the plan is blocked", () => {
      const { plan, f3, policy } = evalWith(stepOf("revive.call"));
      const pf = H.preflight(plan);
      pf.steps.push({ ...pf.steps[0], actionId: "ghost" });
      expect(evaluatePolicy({ policy, plan, facts: f3, preflight: pf }).allowed).toBe(false);
    });
  });

  describe("unknown dry-run / fee / weight / storage / proof size", () => {
    for (const kind of ALL_KINDS) {
      it(`${kind}: unknowns block by default; when allowed they are flagged as weaker proof`, () => {
        const { plan, f3, policy } = evalWith(stepOf(kind), { maxProofSize: "1000" });
        const pf = H.preflight(plan);
        pf.steps[0] = {
          ...pf.steps[0],
          weight: { unknown: true },
          fee: { unknown: true },
          storageDeposit: { unknown: true },
          proofSize: { unknown: true },
          dryRun: "unknown",
        };
        pf.totalFee = { unknown: true };
        const strict = evaluatePolicy({
          policy: { ...policy, allowUnknown: {} },
          plan,
          facts: f3,
          preflight: pf,
        });
        expect(strict.allowed).toBe(false);
        expect(strict.rules.filter((x) => x.outcome === "unknown").length).toBeGreaterThanOrEqual(
          3,
        );
        expect(strict.weakProof ?? []).toEqual([]);
        const loose = evaluatePolicy({
          policy: {
            ...policy,
            allowUnknown: {
              fee: true,
              weight: true,
              storageDeposit: true,
              dryRun: true,
              proofSize: true,
            },
          },
          plan,
          facts: f3,
          preflight: pf,
        });
        expect(loose.allowed).toBe(true);
        expect(loose.weakProof?.length).toBeGreaterThanOrEqual(3);
        expect(
          loose.rules
            .filter((x) => x.weak)
            .every((x) => x.outcome === "pass" && /allowed by policy/.test(x.reason)),
        ).toBe(true);
        expect(loose.rules.some((x) => x.weak && x.rule === "dry_run")).toBe(true);
      });
    }
    it("a failed dry run is never excused by allowUnknown", () => {
      const { plan, f3, policy } = evalWith(stepOf("contracts.call"));
      const pf = H.preflight(plan);
      pf.steps[0].dryRun = "failed";
      expect(
        evaluatePolicy({
          policy: { ...policy, allowUnknown: { dryRun: true } },
          plan,
          facts: f3,
          preflight: pf,
        }).allowed,
      ).toBe(false);
    });
    it("fully proven results carry no weakProof field (digests of existing approvals unchanged)", () => {
      const run = approvedRun();
      expect("weakProof" in run.policyResult).toBe(false);
    });
    it("gate: pre-sign estimate vs submitted signed dry run is distinguished", () => {
      const run = approvedRun();
      const loosePolicy = H.policy({ requireSignedDryRun: false });
      const pr = evaluatePolicy({
        policy: loosePolicy,
        plan: run.plan,
        facts,
        preflight: run.preflight,
      });
      const ap = createApproval({
        manifestDigest: run.plan.manifestDigest,
        plan: run.plan,
        envelope: run.envelope,
        preflight: run.preflight,
        policy: loosePolicy,
        policyResult: pr,
        fingerprint: fp,
        now: H.NOW,
      });
      if (!ap.ok) throw new Error(ap.reason);
      const none = gate(run, {
        policy: loosePolicy,
        policyResult: pr,
        approval: ap.approval,
        signedDryRun: undefined,
      });
      expect(none.ok).toBe(true);
      expect(
        none.passed.some(
          (p) => p.code === "signed_dry_run_not_checked" && /weaker|estimate/i.test(p.detail),
        ),
      ).toBe(true);
      expect(gate(run).passed.some((p) => p.code === "signed_dry_run_ok")).toBe(true);
      // unknown signed dry run with requireSignedDryRun blocks
      expect(codes(gate(run, { signedDryRun: ["unknown", "unknown", "unknown"] }))).toContain(
        "signed_dry_run_missing",
      );
    });
  });

  describe("mismatched policy never survives approval and send gate", () => {
    it("approval from a different policy's result is refused; gate refuses a swapped policy", () => {
      const run = approvedRun();
      const weaker = definePolicy({
        ...run.policy,
        maxAmountPerAsset: { "1": "999999999999999999999", "2": "1" },
      });
      const resultWeaker = evaluatePolicy({
        policy: weaker,
        plan: run.plan,
        facts,
        preflight: run.preflight,
      });
      const out = createApproval({
        manifestDigest: run.plan.manifestDigest,
        plan: run.plan,
        envelope: run.envelope,
        preflight: run.preflight,
        policy: run.policy,
        policyResult: resultWeaker,
        fingerprint: fp,
        now: H.NOW,
      });
      expect(out.ok).toBe(false);
      expect(codes(gate(run, { policy: weaker, policyResult: resultWeaker }))).toContain(
        "approval_mismatch",
      );
    });
    it("a hand-edited policy result (allowed:true) is caught by the approval hash", () => {
      const run = approvedRun();
      const forged = {
        ...run.policyResult,
        rules: [
          ...run.policyResult.rules,
          { rule: "x", outcome: "pass" as const, reason: "forged" },
        ],
      };
      expect(codes(gate(run, { policyResult: forged }))).toContain("approval_mismatch");
    });
    it("a blocked policy result can never be approved, whatever it says", () => {
      const { plan, f3, policy } = evalWith(stepOf("revive.call"), { allowedContracts: [] });
      const result = evaluatePolicy({ policy, plan, facts: f3, preflight: H.preflight(plan) });
      expect(result.allowed).toBe(false);
      const out = createApproval({
        manifestDigest: plan.manifestDigest,
        plan,
        envelope: H.envelope(),
        preflight: H.preflight(plan),
        policy,
        policyResult: { ...result, allowed: false },
        fingerprint: f3.fingerprint,
        now: H.NOW,
      });
      expect(out.ok).toBe(false);
    });
  });

  describe("property-style: random single-field mutations of an allowed step are never silently allowed", () => {
    let seed = 1337;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const junk = [
      "-1",
      "1.5",
      "0x10",
      "9".repeat(40),
      "",
      "NaN",
      "1e9",
      " 1",
      "99999999999999999999999999",
    ];
    it("any junk amount/value/gas/recipient/asset/contract is blocked for each kind", () => {
      const fields: Record<string, string[]> = {
        "assets.transfer": ["amount", "assetId", "recipient"],
        "assets.mint": ["amount", "assetId", "recipient"],
        "nfts.mint": ["amount", "assetId", "recipient"],
        "contracts.call": ["value", "gasLimit", "contract"],
        "revive.call": ["value", "gasLimit", "contract"],
      };
      for (let n = 0; n < 60; n++) {
        const kind = ALL_KINDS[Math.floor(rnd() * ALL_KINDS.length)];
        const fl = fields[kind];
        const field = fl[Math.floor(rnd() * fl.length)];
        const v = junk[Math.floor(rnd() * junk.length)];
        const { result } = evalWith(stepOf(kind, { [field]: v }), {
          allowedAssets: ["1"],
          allowedRecipients: [H.BOB],
          allowedContracts: [kind === "revive.call" ? REV : H.CHARLIE],
          maxAmountPerAsset: { "1": "10" },
          maxNativeValue: "0",
          maxGasLimit: "10000000000",
        });
        expect(result.allowed, `${kind}.${field}=${JSON.stringify(v)}`).toBe(false);
      }
    });
  });
});

// ---------- SEAM-001 (gate side) ----------
describe("SEAM-001 gate side: trusted decoder over wallet-reported calls", () => {
  const dec =
    (run: Run, over: Partial<DecodedSignedExtrinsic> = {}) =>
    (xt: Hex): DecodedSignedExtrinsic | null => {
      const idx = Number(xt.slice(2, 4) === "ee" ? 0 : parseInt(xt.slice(2, 4), 16));
      return {
        call: callsToSign(run.plan)[idx] as Hex,
        signer: H.ALICE,
        nonce: run.envelope.nonce + idx,
        signatureValid: true,
        ...over,
      };
    };
  // fake signed extrinsics: first byte after 0x is the index
  const xts = (run: Run) =>
    callsToSign(run.plan).map((_, i) => ("0x" + i.toString(16).padStart(2, "0") + "aa") as Hex);
  it("passes when decoded calls equal the approved ones, ignoring signedCalls", () => {
    const run = approvedRun();
    const r = gate(run, {
      signedCalls: ["0xdeadbeef"],
      signedExtrinsics: xts(run),
      decodeSignedExtrinsic: dec(run),
    });
    expect(r.ok).toBe(true);
    expect(r.passed.some((p) => p.code === "signed_bytes_match" && /decoded/.test(p.detail))).toBe(
      true,
    );
  });
  it("wallet reports the expected signedCall but the extrinsic carries a different call: blocked", () => {
    const run = approvedRun();
    const evil = (xt: Hex) => ({ ...dec(run)(xt)!, call: "0x0000dead" as Hex });
    const r = gate(run, {
      signedCalls: callsToSign(run.plan) as Hex[],
      signedExtrinsics: xts(run),
      decodeSignedExtrinsic: evil,
    });
    expect(codes(r)).toContain("signed_bytes_mismatch");
  });
  it("blocks a different signer, tampered nonce, bad signature, undecodable, extra/fewer extrinsics", () => {
    const run = approvedRun();
    const x = xts(run);
    expect(
      codes(gate(run, { signedExtrinsics: x, decodeSignedExtrinsic: dec(run, { signer: H.BOB }) })),
    ).toContain("signed_signer_mismatch");
    expect(
      codes(gate(run, { signedExtrinsics: x, decodeSignedExtrinsic: dec(run, { nonce: 999 }) })),
    ).toContain("signed_nonce_mismatch");
    expect(
      codes(
        gate(run, {
          signedExtrinsics: x,
          decodeSignedExtrinsic: dec(run, { signatureValid: false }),
        }),
      ),
    ).toContain("signed_signature_invalid");
    expect(codes(gate(run, { signedExtrinsics: x, decodeSignedExtrinsic: () => null }))).toContain(
      "signed_extrinsic_undecodable",
    );
    expect(
      codes(gate(run, { signedExtrinsics: x.slice(0, 1), decodeSignedExtrinsic: dec(run) })),
    ).toContain("signed_bytes_mismatch");
    expect(
      codes(gate(run, { signedExtrinsics: [...x, x[0]], decodeSignedExtrinsic: dec(run) })),
    ).toContain("signed_bytes_mismatch");
  });
  it("blocks a genesis hash from another chain when the decoder reports one", () => {
    const run = approvedRun();
    const r = gate(run, {
      signedExtrinsics: xts(run),
      decodeSignedExtrinsic: dec(run, { genesisHash: ("0x" + "99".repeat(32)) as Hex }),
    });
    expect(codes(r)).toContain("signed_chain_mismatch");
  });
  it("a decoder that throws fails closed", () => {
    const run = approvedRun();
    const r = gate(run, {
      signedExtrinsics: xts(run),
      decodeSignedExtrinsic: () => {
        throw new Error("boom");
      },
    });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("signed_extrinsic_undecodable");
  });
  it("requireTrustedDecoder blocks when only wallet-reported signedCalls are given", () => {
    const run = approvedRun();
    expect(codes(gate(run, { requireTrustedDecoder: true }))).toContain("trusted_decoder_required");
    expect(codes(gate(run, { requireTrustedDecoder: true, signedExtrinsics: xts(run) }))).toContain(
      "trusted_decoder_required",
    );
  });
  it("without the new fields, behaviour is unchanged (wallet-reported path still works)", () => {
    expect(gate(approvedRun()).ok).toBe(true);
  });
});
