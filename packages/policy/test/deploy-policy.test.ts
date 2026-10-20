// Deploy rules for revive.instantiate_with_code and revive.map_account (assumed field names in src/deploy.ts).
import { describe, it, expect } from "vitest";
import {
  checkDeployStep,
  evaluatePolicy,
  planDigest,
  type DeployPolicy,
  type PlanStep,
  type Plan,
  type Hex,
} from "../src/index.js";
import * as H from "./helpers.js";

const CODE = ("0x" + "ab".repeat(32)) as Hex;
const SIGNER = H.ALICE_HEX as Hex;
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
const map = (account: unknown): PlanStep =>
  ({
    actionId: "map",
    kind: "revive.map_account",
    capability: "Revive.map_account",
    palletIndex: 60,
    callIndex: 7,
    decodedArgs: account === undefined ? {} : { account },
    encodedCall: "0x3c07",
    status: "ok",
  }) as unknown as PlanStep;
const blocks = (r: ReturnType<typeof checkDeployStep>) =>
  r.filter((x) => x.outcome === "block").map((x) => x.code);

describe("deploy policy", () => {
  it("passes a deploy within every cap", () => {
    const r = checkDeployStep(inst(), deploy, SIGNER);
    expect(r.length).toBeGreaterThan(0);
    expect(blocks(r)).toEqual([]);
  });
  it("ignores non-deploy kinds", () => {
    expect(checkDeployStep({ ...inst(), kind: "revive.call" } as PlanStep, deploy, SIGNER)).toEqual(
      [],
    );
  });
  it.each([
    ["no deploy policy", undefined, {}, "DEPLOY_CODE_HASH_LIST_MISSING"],
    ["empty allow-list", { ...deploy, allowedCodeHashes: [] }, {}, "DEPLOY_CODE_HASH_LIST_MISSING"],
    [
      "code hash not allowed",
      deploy,
      { codeHash: "0x" + "cd".repeat(32) },
      "DEPLOY_CODE_HASH_NOT_ALLOWED",
    ],
    ["code hash missing", deploy, { codeHash: undefined }, "DEPLOY_FIELD_INVALID"],
    ["code hash undecodable", deploy, { codeHash: "0x1234" }, "DEPLOY_FIELD_INVALID"],
    ["non-zero value without maxValue", deploy, { value: "1" }, "DEPLOY_VALUE_NOT_ALLOWED"],
    [
      "value over maxValue",
      { ...deploy, maxValue: "5" },
      { value: "6" },
      "DEPLOY_VALUE_NOT_ALLOWED",
    ],
    ["value missing", deploy, { value: undefined }, "DEPLOY_FIELD_INVALID"],
    ["value not an integer", deploy, { value: "1.5" }, "DEPLOY_FIELD_INVALID"],
    [
      "no storage cap",
      { ...deploy, maxStorageDepositLimit: undefined },
      {},
      "DEPLOY_STORAGE_CAP_MISSING",
    ],
    ["storage limit null", deploy, { storageDepositLimit: null }, "DEPLOY_STORAGE_LIMIT_MISSING"],
    [
      "storage limit missing",
      deploy,
      { storageDepositLimit: undefined },
      "DEPLOY_STORAGE_LIMIT_MISSING",
    ],
    [
      "storage limit over cap",
      deploy,
      { storageDepositLimit: "10000000000001" },
      "DEPLOY_STORAGE_LIMIT_OVER_CAP",
    ],
    ["storage limit undecodable", deploy, { storageDepositLimit: "-1" }, "DEPLOY_FIELD_INVALID"],
    ["no gas cap", { ...deploy, maxGasLimit: undefined }, {}, "DEPLOY_GAS_CAP_MISSING"],
    ["no proof size cap", { ...deploy, maxProofSize: undefined }, {}, "DEPLOY_GAS_CAP_MISSING"],
    ["gas limit missing", deploy, { gasLimit: undefined }, "DEPLOY_GAS_LIMIT_MISSING"],
    ["proof size missing", deploy, { proofSize: undefined }, "DEPLOY_GAS_LIMIT_MISSING"],
    ["gas limit over cap", deploy, { gasLimit: "5000000001" }, "DEPLOY_GAS_LIMIT_OVER_CAP"],
    ["proof size over cap", deploy, { proofSize: "1000001" }, "DEPLOY_GAS_LIMIT_OVER_CAP"],
    ["gas limit undecodable", deploy, { gasLimit: "0x10" }, "DEPLOY_FIELD_INVALID"],
  ])("blocks: %s", (_n, pol, over, code) => {
    expect(blocks(checkDeployStep(inst(over), pol as DeployPolicy | undefined, SIGNER))).toContain(
      code,
    );
  });
  it("allows a value within maxValue", () => {
    expect(
      blocks(checkDeployStep(inst({ value: "5" }), { ...deploy, maxValue: "5" }, SIGNER)),
    ).toEqual([]);
  });
  it("map_account passes for the signer (SS58 or hex)", () => {
    expect(blocks(checkDeployStep(map(H.ALICE), undefined, SIGNER))).toEqual([]);
    expect(blocks(checkDeployStep(map(H.ALICE_HEX), undefined, SIGNER))).toEqual([]);
  });
  it.each([
    ["another account", H.BOB],
    ["no account", undefined],
    ["undecodable account", "not-an-address"],
  ])("map_account blocks %s", (_n, a) => {
    expect(blocks(checkDeployStep(map(a), deploy, SIGNER))).toEqual(["MAP_ACCOUNT_NOT_SIGNER"]);
  });
  it("evaluatePolicy runs the deploy rules and blocks", () => {
    const base = H.compilePlan();
    const { planDigest: _d, ...rest } = { ...base, steps: [inst({ value: "1" }), map(H.BOB)] };
    const plan = { ...rest, planDigest: "0x" } as Plan;
    plan.planDigest = planDigest(plan);
    const r = evaluatePolicy({ policy: H.policy({ deploy }), plan, facts: H.realFacts() });
    expect(r.allowed).toBe(false);
    const codes = r.rules.filter((x) => x.outcome === "block").map((x) => x.code);
    expect(codes).toContain("DEPLOY_VALUE_NOT_ALLOWED");
    expect(codes).toContain("MAP_ACCOUNT_NOT_SIGNER");
  });
});
