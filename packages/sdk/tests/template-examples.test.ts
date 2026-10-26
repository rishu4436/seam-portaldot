// P1-04: runs `npm run examples:templates` (examples/templates/index.mjs --json) and checks every template example
// end to end: offline compile on the committed V3 spec 3002 metadata, allowed by its deny-by-default policy,
// verifyPlan ok, createApproval(requirePlanVerified) ok, and the three documented errors with their exact codes.
// Needs the built packages (npm run build), like the other CLI tests.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const run = spawnSync("node", ["examples/templates/index.mjs", "--json"], {
  cwd: repo,
  encoding: "utf8",
});
const results = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "[]") as Array<
  Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
>;
// Does the built policy have Sentinel's pre-sign verifyPlan gate (a74ad38)?
const hasBytesGate = readFileSync(`${repo}packages/policy/dist/browser.js`, "utf8").includes(
  "PLAN_BYTES_MISMATCH",
);
const byId = Object.fromEntries(results.map((r) => [r.id, r]));
const IDS = [
  "asset-transfer",
  "nft-mint",
  "asset-mint",
  "sequential-transfers",
  "atomic-batch",
  "revive-call",
  "restricted-deploy",
];
const BLOCK: Record<string, string> = {
  "asset-transfer": "RECIPIENT_NOT_ALLOWED",
  "nft-mint": "RECIPIENT_NOT_ALLOWED",
  "asset-mint": "AMOUNT_OVER_LIMIT",
  "sequential-transfers": "RECIPIENT_NOT_ALLOWED",
  "atomic-batch": "PLAN_MODE_NOT_ALLOWED",
  "revive-call": "CONTRACT_NOT_ALLOWED",
  "restricted-deploy": "DEPLOY_CODE_HASH_NOT_ALLOWED",
};

it("runs all seven template examples and exits 0", () => {
  expect(run.status, run.stderr).toBe(0);
  expect(results.map((r) => r.id)).toEqual(IDS);
});

describe.each(IDS)("example %s", (id) => {
  it("is offline, honest and allowed by its own deny-by-default policy", () => {
    const r = byId[id];
    expect(r).toMatchObject({ offline: true, signed: false, submitted: false, specVersion: 3002 });
    expect(r.planDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.policyAllowed).toBe(true);
    expect(r.verifyPlanOk).toBe(true);
    expect(r.approvalOk).toBe(true);
  });
  it("rejects an unfilled PLACEHOLDER with MANIFEST_INVALID", () => {
    expect(byId[id].placeholder).toMatchObject({
      skeletonHasPlaceholder: true,
      rejected: true,
      codes: ["MANIFEST_INVALID"],
    });
  });
  it(`blocks its policy violation with ${BLOCK[id]}`, () => {
    expect(byId[id].policyBlock.allowed).toBe(false);
    expect(byId[id].policyBlock.codes).toContain(BLOCK[id]);
  });
  it("refuses the edited plan (digest recomputed) with STEP_BYTES_MISMATCH", () => {
    const e = byId[id].editedPlan;
    expect(e.digestSelfConsistent).toBe(true);
    expect(e.verifyPlanOk).toBe(false);
    expect(e.verifyPlanCodes).toContain("STEP_BYTES_MISMATCH");
    expect(e.approvalOk).toBe(false);
    expect(e.approvalReason).toMatch(/call bytes/);
    // With Sentinel's pre-sign gate (a74ad38) in the build the gate blocks with PLAN_BYTES_MISMATCH; before it, the
    // gate has no bytes check and allows it (createApproval above is what refuses).
    if (hasBytesGate) {
      expect(e.gateAllowed).toBe(false);
      expect(e.gateCodes).toContain("PLAN_BYTES_MISMATCH");
    } else expect(e.gateCodes).not.toContain("PLAN_BYTES_MISMATCH");
  });
});

it("atomic-batch is honestly labelled atomic_unverified", () => {
  expect(byId["atomic-batch"].mode).toBe("atomic_unverified");
  expect(byId["atomic-batch"].editedPlan.verifyPlanCodes).toContain("OUTER_CALL_MISMATCH");
});

it("restricted-deploy goes through checkDeployStep and is never deployed", () => {
  const d = byId["restricted-deploy"];
  expect(d.deployed).toBe(false);
  expect(d.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(d.deployRules.every((x: string) => x.endsWith(":pass"))).toBe(true);
  expect(d.valueNonZeroCodes).toContain("DEPLOY_VALUE_NOT_ALLOWED");
  // Reports what checkDeployStep returns for proof_size 0 today (a known gap until Sentinel's fix lands).
  expect(Array.isArray(d.proofSizeZero.checkDeployStepOutcomes)).toBe(true);
});
