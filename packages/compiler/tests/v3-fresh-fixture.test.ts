// The fresh V3 fixture (fixtures/v3-fresh-transfer.json) must equal a compile run now, pass verifyPlan, and its
// generator's --check must pass. It is a fresh offline compile, not a recorded run.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, factsFromMetadata, verifyPlan, type Manifest, type Plan } from "../src/index.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const fx = JSON.parse(
  readFileSync(root("packages/compiler/fixtures/v3-fresh-transfer.json"), "utf8"),
) as {
  label: string;
  sources: { metadata: string; metadataHash: string };
  factsInput: { genesisHash: string; tokenSymbol: string; tokenDecimals: number };
  manifest: Manifest;
  fingerprintDigest: string;
  plan: Plan;
  planDigest: string;
  callsToSign: string[];
};
const facts = factsFromMetadata({
  metadataHex: readFileSync(root(fx.sources.metadata), "utf8").trim(),
  ...fx.factsInput,
} as Parameters<typeof factsFromMetadata>[0]);

describe("fresh V3 transfer fixture", () => {
  it("is labelled as a fresh compile", () =>
    expect(fx.label).toBe("fresh compile, not a recorded run"));

  it("equals a fresh compile on the committed spec 3002 metadata", () => {
    expect(facts.fingerprint.metadataHash).toBe(fx.sources.metadataHash);
    expect(facts.fingerprintDigest).toBe(fx.fingerprintDigest);
    const plan = compile(fx.manifest, facts);
    expect(plan).toEqual(fx.plan);
    expect(plan.planDigest).toBe(fx.planDigest);
    expect(plan.steps.map((s) => s.encodedCall)).toEqual(fx.callsToSign);
  });

  it("passes verifyPlan with its own callsToSign", () => {
    const r = verifyPlan(fx.manifest, fx.plan, facts, {
      signedCalls: fx.callsToSign as `0x${string}`[],
    });
    expect(r).toMatchObject({ ok: true, planDigest: fx.planDigest, fingerprintDiffers: false });
  });

  it("generator --check passes", () => {
    const out = execFileSync(
      process.execPath,
      [root("packages/compiler/scripts/gen-fresh-fixture.mjs"), "--check"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out).toMatch(/up to date/);
  });
});

// Why the recorded console demo (packages/console/src/demo/v3-demo-transfer.json) fails verifyPlan with
// PLAN_BODY_MISMATCH: its generator injected the atomic run's batchAllRollbackProof, which is bound to metadataHash
// 0x1c8226aa… (not the committed spec 3002 blob), so its plan carries a "proof is rejected" modeReason. Read-only.
describe("recorded console demo planDigest", () => {
  const demo = JSON.parse(
    readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
  ) as { manifest: Manifest; plan: Plan };
  const run = JSON.parse(
    readFileSync(root("evidence/testnet-v3/runs/plan-atomic-1792411355057.json"), "utf8"),
  ) as { facts: { behaviour?: Record<string, unknown> } };

  it("differs from a plain fresh compile only in modeReason", () => {
    expect(verifyPlan(demo.manifest, demo.plan, facts).ok).toBe(false);
    const fresh = compile(demo.manifest, facts);
    expect(fresh.steps).toEqual(demo.plan.steps);
    expect({ ...fresh, modeReason: "", planDigest: "" }).toEqual({
      ...demo.plan,
      modeReason: "",
      planDigest: "",
    });
  });

  it("is reproduced exactly when the atomic run's rejected rollback proof is injected", () => {
    const withProof = factsFromMetadata({
      metadataHex: readFileSync(root(fx.sources.metadata), "utf8").trim(),
      ...fx.factsInput,
      batchAllRollback: run.facts.behaviour?.batchAllRollback,
      batchAllRollbackProof: run.facts.behaviour?.batchAllRollbackProof,
    } as Parameters<typeof factsFromMetadata>[0]);
    expect(compile(demo.manifest, withProof).planDigest).toBe(demo.plan.planDigest);
  });
});
