// Pre-sign plan-bytes check: gatePolicy / assertPolicyAllows / explainPolicy run @seam/compiler verifyPlan when
// manifest + liveFacts are given, and fail closed under requirePlanVerified. Fresh compile in-test, offline.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { compile, factsFromMetadata } from "@seam/compiler/browser";
import {
  callsToSign,
  definePolicy,
  evaluatePolicy,
  type Manifest,
  type Plan,
  type RuntimeFacts,
} from "../src/index.js";
import {
  gatePolicy,
  assertPolicyAllows,
  explainPolicy,
  PolicyBlockedError,
} from "../src/browser.js";
import * as H from "./helpers.js";

// Forge's fresh V3 fixture (bot2/fresh-v3-fixture a745260): a FRESH compile on spec 3002, not a recorded run.
// Sequential, one assets.transfer. Single/atomic variants below still compile in-test (the fixture has none).
const read = (p: string) => readFileSync(root(p), "utf8").trim();
const fx = JSON.parse(
  readFileSync(new URL("../../compiler/fixtures/v3-fresh-transfer.json", import.meta.url), "utf8"),
);
const root = (p: string) => fileURLToPath(new URL(`../../../${p.split("#")[0]}`, import.meta.url));
const V3 = read(fx.sources.metadata);
const fxFacts = factsFromMetadata({
  metadataHex: V3,
  ...fx.factsInput,
} as never) as unknown as RuntimeFacts;
const v3 = (genesis = "0x" + "11".repeat(32)): RuntimeFacts =>
  factsFromMetadata({
    metadataHex: V3,
    genesisHash: genesis,
    tokenSymbol: "tPOT",
    tokenDecimals: 14,
  } as never) as unknown as RuntimeFacts;
const facts = v3();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only mutable JSON
type J = any;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const redigest = (p: J): Plan => ({ ...p, planDigest: H.planDigest(p) });
const pay = (recipient: string, amount = "1000", id = "pay") => ({
  id,
  kind: "assets.transfer",
  args: { assetId: "1", amount, recipient },
});
const mint = {
  id: "mint",
  kind: "assets.mint",
  args: { assetId: "2", amount: "5", recipient: H.BOB },
};
const man = (actions: unknown[], atomic = false): Manifest =>
  ({
    version: 1,
    signer: { type: "ss58", value: H.ALICE },
    actions: (actions as object[]).map((a) => ({
      ...a,
      ...(atomic ? { preferredMode: "atomic" } : {}),
    })),
  }) as Manifest;
const single = man([pay(H.BOB)]);
const seq = man([pay(H.BOB), pay(H.BOB, "2000", "pay2")]);
const atomic = man([pay(H.BOB), mint], true);
const compileM = (m: Manifest, o = {}) => compile(m as never, facts as never, o) as unknown as Plan;
const policy = definePolicy({
  allowedAssets: ["1", "2"],
  allowedRecipients: [H.BOB],
  maxAmountPerAsset: { "*": "10000" },
  maxFee: "10000000000",
  allowedModes: ["sequential", "atomic_unverified"],
});
const input = (m: Manifest, p: Plan, over = {}) => ({
  policy,
  plan: p,
  facts,
  preflight: H.preflight(p),
  manifest: m,
  liveFacts: facts,
  ...over,
});
const strict = { requirePlanVerified: true };
const codes = (g: ReturnType<typeof gatePolicy>) => g.blockedBy.map((b) => b.code);
function forgedToCharlie(): Plan {
  const p: J = clone(compileM(single));
  p.steps[0].encodedCall = compileM(man([pay(H.CHARLIE)])).steps[0].encodedCall;
  return redigest(p);
}

describe("Forge's fresh V3 fixture", () => {
  const plan = fx.plan as Plan;
  const manifest = fx.manifest as Manifest;
  const [{ args }] = manifest.actions as { args: { assetId: string; recipient: string } }[];
  const fxPolicy = definePolicy({
    allowedAssets: [args.assetId],
    allowedRecipients: [args.recipient],
    maxAmountPerAsset: { "*": "10000" },
    maxFee: "10000000000",
  });
  const fxInput = (p: Plan) => ({
    policy: fxPolicy,
    plan: p,
    facts: fxFacts,
    preflight: H.preflight(p),
    manifest,
    liveFacts: fxFacts,
  });
  it("is what it says: digest and callsToSign match the plan", () => {
    expect(fx.plan.planDigest).toBe(fx.planDigest);
    expect(callsToSign(plan)).toEqual(fx.callsToSign);
    expect(fxFacts.fingerprintDigest).toBe(fx.fingerprintDigest);
  });
  it("passes the strict gate", () => {
    const g = gatePolicy(fxInput(plan), strict);
    expect(g.allowed, JSON.stringify(g.blockedBy)).toBe(true);
    expect(g.explanations.find((e) => e.rule === "plan_bytes")?.status).toBe("pass");
  });
  it("forged Charlie variant of the fixture (bytes pay Charlie, digest recomputed) blocks PLAN_BYTES_MISMATCH", () => {
    const evilM = clone(manifest) as J;
    evilM.actions[0].args.recipient = H.CHARLIE;
    const evil = compile(evilM, fxFacts as never) as unknown as Plan;
    const p: J = clone(plan);
    p.steps[0].encodedCall = evil.steps[0].encodedCall;
    const g = gatePolicy(fxInput(redigest(p)), strict);
    expect(g.allowed).toBe(false);
    expect(g.blockedBy.map((b) => b.code)).toEqual(["PLAN_BYTES_MISMATCH"]);
  });
});

describe("honest fresh plans pass the strict pre-sign gate", () => {
  for (const [name, m, o] of [
    ["single", single, {}],
    ["sequential", seq, {}],
    ["atomic", atomic, { allowAtomicUnverified: true }],
  ] as const)
    it(name, () => {
      const g = gatePolicy(input(m, compileM(m, o)), strict);
      expect(g.allowed).toBe(true);
      expect(g.explanations.find((e) => e.rule === "plan_bytes")).toMatchObject({
        status: "pass",
        code: "OK",
      });
    });
});

describe("edited plans are blocked before the wallet opens", () => {
  it("plan paying Charlie with a recomputed digest: PLAN_BYTES_MISMATCH with Forge's issues and a plain line", () => {
    const p = forgedToCharlie();
    const g = gatePolicy(input(single, p), strict);
    expect(g.allowed).toBe(false);
    expect(codes(g)).toEqual(["PLAN_BYTES_MISMATCH"]);
    const b = g.blockedBy[0];
    expect((b.issues as { code: string }[]).map((i) => i.code)).toContain("STEP_BYTES_MISMATCH");
    expect(b.message).toMatch(
      /^Call bytes match the Manifest: Fail\. Blocked: the plan's call bytes are not what the Manifest compiles to on the live runtime \(.*STEP_BYTES_MISMATCH at step 1.*\)\.$/,
    );
    expect(explainPolicy(g.result!).find((e) => e.code === "PLAN_BYTES_MISMATCH")?.message).toBe(
      b.message,
    );
    const signer = vi.fn();
    try {
      assertPolicyAllows(input(single, p));
      signer();
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyBlockedError);
      expect((e as PolicyBlockedError).codes).toEqual(["PLAN_BYTES_MISMATCH"]);
    }
    expect(signer).not.toHaveBeenCalled();
  });
  it("edited atomic outer call is blocked", () => {
    const p: J = clone(compileM(atomic, { allowAtomicUnverified: true }));
    p.outerCall.encodedCall = p.outerCall.encodedCall.slice(0, -2) + "ff";
    expect(codes(gatePolicy(input(atomic, redigest(p))))).toContain("PLAN_BYTES_MISMATCH");
  });
  it("live facts for another runtime than `facts` block", () => {
    const g = gatePolicy(
      input(single, compileM(single), { liveFacts: v3("0x" + "33".repeat(32)) }),
    );
    expect(codes(g)).toContain("PLAN_BYTES_MISMATCH");
  });
  it("facts injected into the plan are ignored", () => {
    const p: J = clone(forgedToCharlie());
    p.facts = v3();
    expect(codes(gatePolicy(input(single, redigest(p))))).toContain("PLAN_BYTES_MISMATCH");
  });
});

describe("strict gate fails closed on missing inputs; default stays backward compatible", () => {
  it("missing manifest, liveFacts, or both", () => {
    const p = compileM(single);
    for (const over of [
      { manifest: undefined },
      { liveFacts: undefined },
      { manifest: undefined, liveFacts: undefined },
    ]) {
      const g = gatePolicy(input(single, p, over), strict);
      expect(g.allowed).toBe(false);
      expect(codes(g)).toEqual(["PLAN_BYTES_MISMATCH"]);
      expect(g.blockedBy[0].message).toMatch(/can't be checked/);
    }
    // the engine flag works directly too
    expect(
      evaluatePolicy({ ...input(single, p, { liveFacts: undefined }), requirePlanVerified: true })
        .allowed,
    ).toBe(false);
  });
  it("default (no strict, no liveFacts): no plan_bytes rule at all, as before", () => {
    const g = gatePolicy(input(single, forgedToCharlie(), { liveFacts: undefined }));
    expect(g.allowed).toBe(true);
    expect(g.explanations.some((e) => e.rule === "plan_bytes")).toBe(false);
  });
});
