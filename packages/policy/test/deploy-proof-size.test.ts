// Deploy proof_size 0 / missing is unknown and blocks (fail closed). V3 dry runs report refTime with proof_size 0
// when the PoV part isn't measured; a deploy bounded by such a value is not bounded at all.
import { describe, it, expect } from "vitest";
import { checkDeployStep, type DeployPolicy, type Hex, type PlanStep } from "../src/index.js";
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
