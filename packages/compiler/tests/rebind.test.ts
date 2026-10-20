// rebindPlan: a plan survives a re-read of live facts only when allow-listed storage defaults drifted. Offline,
// on the committed real V3 spec 3002 metadata; drift is made with the chain package's metadata mutator.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withFallback } from "../../chain/tests/metadataMutate.js";
import * as browser from "../src/browser.js";
import {
  compile,
  computePlanDigest,
  factsFromMetadata,
  rebindPlan,
  SeamCompileError,
  type Manifest,
} from "../src/index.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const v3Hex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const demo = JSON.parse(
  readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
);
const manifest = demo.manifest as Manifest;
const facts = (metadataHex: string, extra: Record<string, unknown> = {}) =>
  factsFromMetadata({
    metadataHex,
    genesisHash: manifest.chain!.genesisHash,
    tokenSymbol: "tPOT",
    tokenDecimals: 14,
    ...extra,
  });
const drifted = () => withFallback(v3Hex, "Revive", "EthBlockBuilderIR", "0x00");
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(SeamCompileError);
    return (e as SeamCompileError).issues[0]!.code;
  }
  throw new Error("expected a throw");
};

describe("rebindPlan", () => {
  const planFacts = facts(v3Hex);
  const plan = compile(manifest, planFacts);

  it("same facts: returns the plan unchanged", () => {
    const r = rebindPlan(manifest, plan, planFacts, facts(v3Hex));
    expect(r.rebound).toBe(false);
    expect(r.plan).toBe(plan);
  });
  it("EthBlockBuilderIR drift: the old digest mismatches, rebind gives a new plan with identical calls", () => {
    const live = facts(drifted());
    expect(live.fingerprintDigest).not.toBe(plan.fingerprintDigest); // the FACTS_MISMATCH seen in the LIVE run
    const r = rebindPlan(manifest, plan, planFacts, live);
    expect(r.rebound).toBe(true);
    expect(r.plan.fingerprintDigest).toBe(live.fingerprintDigest);
    expect(r.plan.planDigest).toBe(computePlanDigest(r.plan));
    expect(r.plan.planDigest).not.toBe(plan.planDigest);
    expect(r.plan.steps.map((s) => s.encodedCall)).toEqual(plan.steps.map((s) => s.encodedCall));
    expect(r.plan.signer).toEqual(plan.signer);
    if (r.rebound) expect(r.previousPlanDigest).toBe(plan.planDigest);
  });
  it("any other storage default change fails closed with RUNTIME_CHANGED", () =>
    expect(
      code(() =>
        rebindPlan(
          manifest,
          plan,
          planFacts,
          facts(withFallback(v3Hex, "System", "Number", "0x2a000000")),
        ),
      ),
    ).toBe("RUNTIME_CHANGED"));
  it("a different genesis fails closed", () =>
    expect(
      code(() =>
        rebindPlan(
          manifest,
          plan,
          planFacts,
          facts(drifted(), { genesisHash: "0x" + "22".repeat(32) }),
        ),
      ),
    ).toBe("RUNTIME_CHANGED"));
  it("different token decimals fail closed", () =>
    expect(
      code(() => rebindPlan(manifest, plan, planFacts, facts(drifted(), { tokenDecimals: 12 }))),
    ).toBe("RUNTIME_CHANGED"));
  it("a plan that is not this manifest's compile is refused", () => {
    const other = compile(
      {
        ...manifest,
        signer: { type: "ss58", value: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty" },
      },
      planFacts,
    );
    expect(code(() => rebindPlan(manifest, other, planFacts, facts(drifted())))).toBe(
      "RUNTIME_CHANGED",
    );
  });
  it("tampered live facts are rejected by compile, never rebound", () => {
    const live = facts(drifted());
    expect(() =>
      rebindPlan(manifest, plan, planFacts, { ...live, fingerprintDigest: "0x" + "00".repeat(32) }),
    ).toThrow(SeamCompileError);
  });
  it("is exported from the browser entry as the same function", () =>
    expect(browser.rebindPlan).toBe(rebindPlan));
});
