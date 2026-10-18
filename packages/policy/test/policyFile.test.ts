import { describe, it, expect } from "vitest";
import { parsePolicy, evaluatePolicy, DEFAULT_POLICY } from "../src/index.js";
import * as H from "./helpers.js";

const paths = (r: ReturnType<typeof parsePolicy>) => (r.ok ? [] : r.issues.map((i) => i.path));

describe("parsePolicy", () => {
  it("reads a good policy and fills defaults", () => {
    const r = parsePolicy(
      JSON.stringify({
        allowedAssets: ["1"],
        allowedRecipients: [H.BOB],
        maxFee: "10000000000000",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.maxApprovalSeconds).toBe(DEFAULT_POLICY.maxApprovalSeconds);
      expect(r.policy.requireSignedDryRun).toBe(true);
    }
  });
  it("uses the Portaldot base when asked", () => {
    const r = parsePolicy({ base: "portaldot", allowUnknown: { fee: false } });
    expect(r.ok && r.policy.allowUnknown).toEqual({
      storageDeposit: true,
      dryRun: true,
      fee: false,
    });
  });
  it("rejects typos, floats, numbers instead of strings and negative limits", () => {
    const r = parsePolicy({
      maxFe: "1",
      maxFee: 1.5,
      maxWeight: 100,
      maxGasLimit: "-1",
      maxAmountPerAsset: { "1": "2.5" },
    });
    expect(paths(r).sort()).toEqual([
      "maxAmountPerAsset.1",
      "maxFe",
      "maxFee",
      "maxGasLimit",
      "maxWeight",
    ]);
  });
  it("rejects bad modes, selectors, unknown allowances and bad JSON", () => {
    expect(paths(parsePolicy({ allowedModes: ["atomic"] }))).toEqual(["allowedModes"]);
    expect(paths(parsePolicy({ allowedSelectors: { [H.CHARLIE]: ["flip"] } }))).toEqual([
      `allowedSelectors.${H.CHARLIE}`,
    ]);
    expect(paths(parsePolicy({ allowUnknown: { capability: true } }))).toEqual([
      "allowUnknown.capability",
    ]);
    expect(paths(parsePolicy("{ nope"))).toEqual(["$"]);
    expect(paths(parsePolicy({ version: "v2" }))).toEqual(["version"]);
  });
  it("warns about permissive settings without failing", () => {
    const r = parsePolicy({
      allowedRecipients: "any",
      allowedModes: ["atomic_unverified"],
      requireSignedDryRun: false,
    });
    expect(r.ok && r.warnings.map((w) => w.path)).toEqual([
      "allowedRecipients",
      "allowedModes",
      "requireSignedDryRun",
    ]);
  });
});

describe("two-part weights", () => {
  const plan = H.compilePlan();
  const facts = H.realFacts();
  it("checks proof size from preflight only when the policy sets a limit", () => {
    const pf = H.preflight(plan);
    expect(evaluatePolicy({ policy: H.policy(), plan, facts, preflight: pf }).allowed).toBe(true);
    const r = evaluatePolicy({
      policy: H.policy({ maxProofSize: "100000" }),
      plan,
      facts,
      preflight: pf,
    });
    expect(r.rules.find((x) => x.rule === "proof_size_limit")!.outcome).toBe("unknown");
    pf.steps.forEach((s) => {
      s.proofSize = { value: "5000" };
    });
    pf.steps[1].proofSize = { value: "200000" };
    const big = evaluatePolicy({
      policy: H.policy({ maxProofSize: "100000" }),
      plan,
      facts,
      preflight: pf,
    });
    expect(
      big.rules.find((x) => x.rule === "proof_size_limit" && x.outcome === "block")!.actionId,
    ).toBe("call");
  });
  it("caps a contract call's own proofSize and storageDepositLimit", () => {
    const p = structuredClone(plan);
    p.steps[1].decodedArgs.proofSize = "300000";
    p.steps[1].decodedArgs.storageDepositLimit = "5";
    const { planDigest } = H;
    const edited = { ...p, planDigest: planDigest(p) };
    const r = evaluatePolicy({
      policy: H.policy({ maxProofSize: "100000" }),
      plan: edited,
      facts,
      preflight: {
        ...H.preflight(edited),
        steps: H.preflight(edited).steps.map((s) => ({ ...s, proofSize: { value: "1" } })),
      },
    });
    expect(
      r.rules
        .filter((x) => x.outcome === "block")
        .map((x) => x.rule)
        .sort(),
    ).toEqual(["proof_size_limit", "storage_limit"]);
  });
  it("treats storageDepositLimit null as 'no limit': blocked under a cap, allowed without one", () => {
    const p = structuredClone(plan);
    (p.steps[1].decodedArgs as Record<string, string | null>).storageDepositLimit = null;
    const edited = { ...p, planDigest: H.planDigest(p) };
    const pf = H.preflight(edited);
    const capped = evaluatePolicy({ policy: H.policy(), plan: edited, facts, preflight: pf });
    expect(
      capped.rules.find((x) => x.rule === "storage_limit" && x.outcome === "block")!.reason,
    ).toMatch(/no storage deposit limit/);
    const uncapped = evaluatePolicy({
      policy: H.policy({ maxStorageDeposit: undefined }),
      plan: edited,
      facts,
      preflight: pf,
    });
    expect(uncapped.allowed).toBe(true);
  });
  it("uses a contract call's own proofSize instead of the node's estimate (Bot 4's test-chain numbers)", () => {
    const p = structuredClone(plan);
    p.steps[1].decodedArgs.proofSize = "1000000";
    const edited = { ...p, planDigest: H.planDigest(p) };
    const pf = H.preflight(edited);
    pf.steps[0].proofSize = { value: "6208" };
    pf.steps[1].proofSize = { value: "1004291" };
    pf.steps[2].proofSize = { value: "3675" };
    expect(
      evaluatePolicy({
        policy: H.policy({ maxProofSize: "1000000" }),
        plan: edited,
        facts,
        preflight: pf,
      }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy({
        policy: H.policy({ maxProofSize: "500000" }),
        plan: edited,
        facts,
        preflight: pf,
      }).rules.find((x) => x.rule === "proof_size_limit" && x.outcome === "block")!.reason,
    ).toMatch(/proof size limit 1000000/);
  });
});
