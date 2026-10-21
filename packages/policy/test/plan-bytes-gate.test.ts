// Plan-bytes gate: createApproval / checkBeforeSubmit recompile the Manifest on the LIVE facts (@seam/compiler
// verifyPlan) and require every call byte to match. Real committed V3 spec 3002 metadata, offline. Attack pattern
// from packages/compiler/tests/step-bytes.test.ts: an honest-looking plan whose bytes pay Charlie, digest recomputed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, factsFromMetadata, computeManifestDigest } from "@seam/compiler/browser";
import {
  evaluatePolicy,
  createApproval,
  checkBeforeSubmit,
  InMemoryApprovalStore,
  callsToSign,
  definePolicy,
  type BoundApproval,
  type Hex,
  type Manifest,
  type Plan,
  type RuntimeFacts,
} from "../src/index.js";
import { gatePolicy } from "../src/browser.js";
import * as H from "./helpers.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const V3 = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const v3 = (genesis = "0x" + "11".repeat(32)): RuntimeFacts =>
  factsFromMetadata({
    metadataHex: V3,
    genesisHash: genesis,
    tokenSymbol: "tPOT",
    tokenDecimals: 14,
  } as never) as unknown as RuntimeFacts;
const facts = v3();
const fp = facts.fingerprint;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only mutable JSON
type J = any;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const redigest = (p: J): Plan => ({ ...p, planDigest: H.planDigest(p) });

const man = (actions: Manifest["actions"], atomic = false): Manifest =>
  ({
    version: 1,
    signer: { type: "ss58", value: H.ALICE },
    actions: actions.map((a) => ({ ...a, ...(atomic ? { preferredMode: "atomic" } : {}) })),
  }) as Manifest;
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
const transfer = man([pay(H.BOB) as never]);
const payTo = (r: string) => man([pay(r) as never]);
const seqM = man([pay(H.BOB) as never, pay(H.BOB, "2000", "pay2") as never]);
const atomicM = man([pay(H.BOB) as never, mint as never], true);
const ATOMIC = { allowAtomicUnverified: true };
const plan = (m: Manifest, o = {}) => compile(m as never, facts as never, o) as unknown as Plan;

const policy = definePolicy({
  allowedAssets: ["1", "2"],
  allowedRecipients: [H.BOB],
  maxAmountPerAsset: { "*": "10000" },
  maxFee: "10000000000",
  allowedModes: ["sequential", "atomic_unverified"],
});

function approve(m: Manifest, p: Plan, verify: boolean, extra = {}) {
  const preflight = H.preflight(p);
  const policyResult = evaluatePolicy({ policy, plan: p, facts, preflight });
  const envelope = H.envelope();
  const base = {
    manifestDigest: p.manifestDigest,
    plan: p,
    envelope,
    preflight,
    policy,
    policyResult,
    fingerprint: fp,
  };
  const out = createApproval({
    ...base,
    now: H.NOW,
    ...(verify ? { manifest: m, liveFacts: facts } : {}),
    ...extra,
  });
  return { base, out, m };
}
type A = ReturnType<typeof approve>;
const submit = (a: A, over: Record<string, unknown> = {}) =>
  checkBeforeSubmit({
    ...a.base,
    approval: (a.out as { approval: BoundApproval }).approval,
    preparedFingerprint: fp,
    currentFingerprint: fp,
    signedCalls: callsToSign(a.base.plan) as Hex[],
    signedDryRun: callsToSign(a.base.plan).map(() => "ok" as const),
    now: H.NOW,
    store: new InMemoryApprovalStore(),
    ...over,
  });
const liveOk = (a: A) => ({
  live: true,
  manifest: a.m,
  liveFacts: facts,
  currentBlockNumber: H.envelope().checkpoint.number + 1,
  currentAccountNonce: H.envelope().nonce,
});
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

/** The hole: decodedArgs still say Bob (so the policy passes), the bytes pay Charlie, digest recomputed. */
function forgedToCharlie(): Plan {
  const honest: J = clone(plan(transfer));
  const evil = plan(payTo(H.CHARLIE));
  honest.steps[0].encodedCall = evil.steps[0].encodedCall;
  return redigest(honest);
}

describe("honest plans pass on V3 spec 3002", () => {
  for (const [name, m, o] of [
    ["single", transfer, {}],
    ["sequential", seqM, {}],
    ["atomic", atomicM, ATOMIC],
  ] as const) {
    it(`${name}: createApproval (required) and live checkBeforeSubmit pass`, () => {
      const p = plan(m, o);
      expect(computeManifestDigest(m as never)).toBe(p.manifestDigest);
      const a = approve(m, p, true, { requirePlanVerified: true });
      expect(a.out.ok).toBe(true);
      const r = submit(a, liveOk(a));
      expect(r).toMatchObject({ ok: true, reasons: [] });
      expect(r.passed.map((x) => x.code)).toContain("plan_bytes_verified");
    });
  }
});

describe("forged plans and bytes are blocked", () => {
  it("edited plan paying Charlie passes the policy (decodedArgs say Bob) ...", () => {
    const p = forgedToCharlie();
    const g = gatePolicy({ policy, plan: p, facts, preflight: H.preflight(p) });
    expect(g.allowed).toBe(true); // the engine reads decodedArgs; this is why the bytes gate exists
  });
  it("... but createApproval refuses it when given manifest + liveFacts", () => {
    const a = approve(transfer, forgedToCharlie(), true);
    expect(a.out.ok).toBe(false);
    expect(!a.out.ok && a.out.reason).toMatch(/call bytes.*STEP_BYTES_MISMATCH/);
  });
  it("... and requirePlanVerified refuses an approval without manifest + liveFacts", () => {
    const a = approve(transfer, forgedToCharlie(), false, { requirePlanVerified: true });
    expect(a.out.ok).toBe(false);
  });
  it("... and checkBeforeSubmit blocks plan_bytes_mismatch (approval made without verification), live or not", () => {
    const a = approve(transfer, forgedToCharlie(), false);
    expect(a.out.ok).toBe(true);
    const live = submit(a, liveOk(a));
    expect(codes(live)).toContain("plan_bytes_mismatch");
    const issues = live.reasons.find((x) => x.code === "plan_bytes_mismatch")!.issues as {
      code: string;
    }[];
    expect(issues.map((i) => i.code)).toContain("STEP_BYTES_MISMATCH");
    expect(codes(submit(a, { manifest: transfer, liveFacts: facts }))).toContain(
      "plan_bytes_mismatch",
    );
  });
  it("edited signed bytes on an honest plan: plan_bytes_mismatch (and signed_bytes_mismatch)", () => {
    const a = approve(transfer, plan(transfer), true);
    const evil = plan(payTo(H.CHARLIE)).steps[0].encodedCall as Hex;
    const r = submit(a, { ...liveOk(a), signedCalls: [evil] });
    expect(codes(r)).toEqual(
      expect.arrayContaining(["plan_bytes_mismatch", "signed_bytes_mismatch"]),
    );
  });
  it("edited atomic outer call: blocked", () => {
    const p: J = clone(plan(atomicM, ATOMIC));
    p.outerCall.encodedCall = p.outerCall.encodedCall.slice(0, -2) + "ff";
    const forged = redigest(p);
    expect(approve(atomicM, forged, true).out.ok).toBe(false);
    const a = approve(atomicM, forged, false);
    if (a.out.ok) expect(codes(submit(a, liveOk(a)))).toContain("plan_bytes_mismatch");
  });
  it("manifest digest mismatch: manifest_digest_mismatch", () => {
    const a = approve(transfer, plan(transfer), false);
    const r = submit(a, { ...liveOk(a), manifest: payTo(H.CHARLIE) });
    expect(codes(r)).toContain("manifest_digest_mismatch");
    expect(approve(payTo(H.CHARLIE), plan(transfer), true).out.ok).toBe(false);
  });
  it("facts injected into the plan are ignored: only liveFacts count", () => {
    const p: J = clone(forgedToCharlie());
    p.facts = v3(); // attacker-supplied facts riding in the plan
    const forged = redigest(p);
    const a = approve(transfer, forged, false);
    expect(codes(submit(a, liveOk(a)))).toContain("plan_bytes_mismatch");
    // and an honest plan checked against a different live runtime is not accepted either
    const b = approve(transfer, plan(transfer), false);
    const other = v3("0x" + "33".repeat(32));
    expect(codes(submit(b, { ...liveOk(b), liveFacts: other }))).toContain("live_facts_mismatch");
  });
});

describe("live mode: every required input missing blocks with its own code", () => {
  const a = approve(transfer, plan(transfer), true);
  const cases: [string, Record<string, unknown>][] = [
    ["live_block_missing", { currentBlockNumber: undefined }],
    ["live_nonce_missing", { currentAccountNonce: undefined }],
    ["live_manifest_missing", { manifest: undefined }],
    ["live_facts_missing", { liveFacts: undefined }],
    ["live_signed_calls_missing", { signedCalls: [] }],
  ];
  for (const [code, over] of cases)
    it(code, () => {
      const r = submit(a, { ...liveOk(a), ...over });
      expect(r.ok).toBe(false);
      expect(codes(r)).toContain(code);
    });
  it("non-live without manifest + liveFacts: call bytes only compared with the plan (documented weaker)", () => {
    const f = approve(transfer, forgedToCharlie(), false);
    expect(submit(f).ok).toBe(true);
    expect(codes(submit(f, { live: true }))).toEqual(
      expect.arrayContaining([
        "live_block_missing",
        "live_nonce_missing",
        "live_manifest_missing",
        "live_facts_missing",
      ]),
    );
  });
});
