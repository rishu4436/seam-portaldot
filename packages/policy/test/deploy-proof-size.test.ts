// Deploy proof_size 0 / missing is unknown and blocks (fail closed). V3 dry runs report refTime with proof_size 0
// when the PoV part isn't measured; a deploy bounded by such a value is not bounded at all.
import { describe, it, expect } from "vitest";
import {
  checkDeployStep,
  evaluatePolicy,
  planDigest,
  type DeployPolicy,
  type Hex,
  type Plan,
  type PlanStep,
} from "../src/index.js";
import { explainPolicy } from "../src/browser.js";
import * as H from "./helpers.js";

const CODE = ("0x" + "ab".repeat(32)) as Hex;
const deploy: DeployPolicy = {
  allowedCodeHashes: [CODE],
  maxStorageDepositLimit: "10000000000000",
  maxGasLimit: "5000000000",
  maxProofSize: "1000000",
};
const inst = (over: Record<string, unknown> = {}): PlanStep =>
  ({
    actionId: "deploy",
    kind: "revive.instantiate_with_code",
    capability: "Revive.instantiate_with_code",
    palletIndex: 60,
    callIndex: 1,
    decodedArgs: {
      codeHash: CODE,
      value: "0",
      gasLimit: "4000000000",
      proofSize: "500000",
      storageDepositLimit: "9144000000000",
      ...over,
    },
    encodedCall: "0x3c01",
    status: "ok",
  }) as unknown as PlanStep;
const blocked = (over: Record<string, unknown>) =>
  checkDeployStep(inst(over), deploy, H.ALICE_HEX as Hex).filter((r) => r.outcome !== "pass");

describe("deploy proof size unknown", () => {
  it.each(["0", "00"])("proofSize %s with refTime set blocks DEPLOY_PROOF_SIZE_UNKNOWN", (v) => {
    const b = blocked({ proofSize: v });
    expect(b.map((r) => r.code)).toEqual(["DEPLOY_PROOF_SIZE_UNKNOWN"]);
  });
  it("explains it in one plain line", () => {
    const rules = checkDeployStep(inst({ proofSize: "0" }), deploy, H.ALICE_HEX as Hex);
    const ex = explainPolicy({ allowed: false, rules, policyDigest: "0x" as Hex });
    expect(ex.find((e) => e.code === "DEPLOY_PROOF_SIZE_UNKNOWN")?.message).toBe(
      "Deploy gas limit (step deploy): Fail. Blocked (DEPLOY_PROOF_SIZE_UNKNOWN): the proof size limit is 0, which means the proof size (PoV) part of the weight is unknown, so the deploy can't be bounded.",
    );
  });
  it("missing proofSize still blocks (existing stable code DEPLOY_GAS_LIMIT_MISSING)", () => {
    expect(blocked({ proofSize: undefined }).map((r) => r.code)).toEqual([
      "DEPLOY_GAS_LIMIT_MISSING",
    ]);
    expect(blocked({ proofSize: null }).map((r) => r.code)).toEqual(["DEPLOY_GAS_LIMIT_MISSING"]);
  });
  it("a real non-zero proof size within the cap passes", () => {
    expect(blocked({ proofSize: "1" })).toEqual([]);
  });
});

describe("deploy proof size sources (cap 500000)", () => {
  const plan = (() => {
    const base = H.compilePlan();
    const { planDigest: _d, ...rest } = { ...base, steps: [inst()] };
    const p = { ...rest, planDigest: "0x" } as Plan;
    p.planDigest = planDigest(p);
    return p;
  })();
  const run = (
    legacy?: string,
    extra: { callInfoProofSize?: { value: string }; dryRunProofSize?: { value: string } } = {},
    strict = false,
  ) =>
    evaluatePolicy({
      requireMeasuredProofSize: strict,
      policy: H.policy({ deploy }),
      plan,
      facts: H.realFacts(),
      preflight: {
        steps: [
          {
            actionId: "deploy",
            weight: { value: "1" },
            fee: { value: "1" },
            storageDeposit: { value: "0" },
            dryRun: "ok",
            ...(legacy === undefined ? {} : { proofSize: { value: legacy } }),
            ...extra,
          },
        ],
        totalFee: { value: "1" },
      },
    }).rules.filter((r) => r.rule === "proof_size_limit");
  const out = (r: ReturnType<typeof run>) => r.map((x) => x.code ?? x.outcome);
  it("dry run 0 (instantiate reads 0) or missing: allowed, noted unknown", () => {
    for (const r of [run(undefined, { dryRunProofSize: { value: "0" } }), run()]) {
      expect(out(r)).toEqual(["pass"]);
      expect(r[0].reason).toMatch(
        /dry-run proof size is unknown \(0 or missing\) and was not used as a bound/,
      );
    }
  });
  it("dry run non-zero must fit the cap", () => {
    expect(out(run(undefined, { dryRunProofSize: { value: "500000" } }))).toEqual(["pass"]);
    expect(out(run(undefined, { dryRunProofSize: { value: "500001" } }))).toEqual([
      "PROOF_SIZE_ESTIMATE_OVER_LIMIT",
    ]);
  });
  it("call info: > cap passes (and satisfies strict), <= cap mismatches", () => {
    expect(out(run(undefined, { callInfoProofSize: { value: "506823" } }, true))).toEqual(["pass"]);
    expect(out(run(undefined, { callInfoProofSize: { value: "500000" } }))).toEqual([
      "PROOF_SIZE_CALL_INFO_MISMATCH",
    ]);
  });
  it("strict without callInfoProofSize: PROOF_SIZE_CALL_INFO_MISSING, even with legacy or dry run", () => {
    expect(out(run(undefined, {}, true))).toEqual(["PROOF_SIZE_CALL_INFO_MISSING"]);
    expect(out(run("506823", {}, true))).toEqual(["PROOF_SIZE_CALL_INFO_MISSING"]);
    expect(out(run(undefined, { dryRunProofSize: { value: "1" } }, true))).toEqual([
      "PROOF_SIZE_CALL_INFO_MISSING",
    ]);
  });
  it("legacy proofSize alone: read as call info (> cap allowed with no rule when no policy cap, <= cap mismatches)", () => {
    // No policy maxProofSize: a legacy reading that checks out emits no rule (recorded results re-evaluate identically).
    expect(out(run("506823"))).toEqual([]);
    expect(out(run("1000"))).toEqual(["PROOF_SIZE_CALL_INFO_MISMATCH"]);
  });
});
