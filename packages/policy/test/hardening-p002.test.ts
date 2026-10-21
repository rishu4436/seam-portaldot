// P0-02 hardening: one adversarial case per line of the plan, each asserting a specific block code.
// Real compiled plan from the read-only mainnet snapshot fixture (no network). Signed-extrinsic cases use a stub
// decoder that reports what @seam/chain's parser would report; the decoder's own signature maths is tested in
// packages/chain, here we test that the submit gate acts on what it is told.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  evaluatePolicy,
  createApproval,
  checkBeforeSubmit,
  InMemoryApprovalStore,
  callsToSign,
  usageKey,
  parsePolicy,
  fingerprintDigest,
  type BoundApproval,
  type DecodedSignedExtrinsic,
  type Hex,
  type Plan,
  type Policy,
  type RuntimeFacts,
  type RuntimeFingerprint,
} from "../src/index.js";
import {
  gatePolicy,
  assertPolicyAllows,
  explainPolicy,
  PolicyBlockedError,
} from "../src/browser.js";
import * as H from "./helpers.js";

const facts = H.realFacts();
const fp = facts.fingerprint;
const MALLORY = H.CHARLIE; // valid prefix-42 address that is NOT on the recipient allow-list

function approvedRun(plan: Plan = H.compilePlan(), policy: Policy = H.policy()) {
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
const submit = (run: Run, over: Partial<Parameters<typeof checkBeforeSubmit>[0]> = {}) =>
  checkBeforeSubmit({
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
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);
const gateCodes = (g: ReturnType<typeof gatePolicy>) => g.blockedBy.map((b) => b.code);
const pre = (
  plan: Plan,
  policy: Policy = H.policy(),
  f: RuntimeFacts = facts,
  preflight = H.preflight(plan),
) => gatePolicy({ policy, plan, facts: f, preflight, manifest: H.demoManifest() });
const edited = (edit: (p: Plan) => void): Plan => {
  const p = structuredClone(H.compilePlan());
  edit(p);
  return { ...p, planDigest: H.planDigest(p) };
};
const factsWith = (over: Partial<RuntimeFingerprint>): RuntimeFacts => {
  const f = structuredClone(facts);
  f.fingerprint = { ...f.fingerprint, ...over };
  f.fingerprintDigest = fingerprintDigest(f.fingerprint);
  return f;
};
/** Stub trusted decoder: signed bytes "0x0N" decode to the plan's call N with the given overrides. */
function decoderFor(run: Run, over: (n: number) => Partial<DecodedSignedExtrinsic> = () => ({})) {
  const calls = callsToSign(run.plan) as Hex[];
  const xts = calls.map((_, n) => `0x0${n}` as Hex);
  const decode = (x: Hex): DecodedSignedExtrinsic => {
    const n = Number.parseInt(x.slice(2), 16);
    return {
      call: calls[n],
      signer: H.ALICE,
      nonce: run.envelope.nonce + n,
      genesisHash: fp.genesisHash,
      signatureValid: true,
      metadataHashMode: 0,
      ...over(n),
    };
  };
  return { signedExtrinsics: xts, decodeSignedExtrinsic: decode, requireTrustedDecoder: true };
}

describe("P0-02 baseline", () => {
  it("the untouched run passes both gates, with chain block and nonce supplied", () => {
    const run = approvedRun();
    expect(pre(run.plan).allowed).toBe(true);
    const r = submit(run, {
      ...decoderFor(run),
      currentBlockNumber: 2721460,
      currentAccountNonce: 5,
    });
    expect(r).toMatchObject({ ok: true, reasons: [] });
    expect(r.passed.map((p) => p.code)).toEqual(
      expect.arrayContaining(["mortality_valid", "nonce_current", "signed_bytes_match"]),
    );
  });
});

describe("P0-02 adversarial cases", () => {
  it("wrong signer: pre-sign SIGNER_MISMATCH, submit signed_signer_mismatch", () => {
    const m = H.demoManifest();
    m.signer.value = H.BOB;
    const plan = H.compilePlan();
    const g = gatePolicy({
      policy: H.policy(),
      plan,
      facts,
      preflight: H.preflight(plan),
      manifest: m,
    });
    expect(gateCodes(g)).toContain("SIGNER_MISMATCH");
    const run = approvedRun();
    expect(
      codes(
        submit(
          run,
          decoderFor(run, () => ({ signer: H.BOB })),
        ),
      ),
    ).toContain("signed_signer_mismatch");
  });
  it("wrong genesis: submit signed_chain_mismatch, and a different chain fingerprint is runtime_changed", () => {
    const run = approvedRun();
    const other = ("0x" + "99".repeat(32)) as Hex;
    expect(
      codes(
        submit(
          run,
          decoderFor(run, () => ({ genesisHash: other })),
        ),
      ),
    ).toContain("signed_chain_mismatch");
    expect(codes(submit(run, { currentFingerprint: { ...fp, genesisHash: other } }))).toContain(
      "runtime_changed",
    );
    expect(
      gateCodes(pre(H.compilePlan(), H.policy(), factsWith({ genesisHash: other }))),
    ).toContain("RUNTIME_MISMATCH");
  });
  it("changed recipient: pre-sign RECIPIENT_NOT_ALLOWED, after approval approval_mismatch", () => {
    const plan = edited((p) => (p.steps[0].decodedArgs.recipient = MALLORY));
    expect(gateCodes(pre(plan))).toContain("RECIPIENT_NOT_ALLOWED");
    expect(codes(submit(approvedRun(), { plan }))).toContain("approval_mismatch");
  });
  it("changed amount: pre-sign AMOUNT_OVER_LIMIT, after approval approval_mismatch", () => {
    const plan = edited((p) => (p.steps[0].decodedArgs.amount = "5000000000000001"));
    expect(gateCodes(pre(plan))).toContain("AMOUNT_OVER_LIMIT");
    expect(codes(submit(approvedRun(), { plan }))).toContain("approval_mismatch");
  });
  it("tampered call bytes: pre-sign PLAN_DIGEST_MISMATCH, decoded bytes signed_bytes_mismatch", () => {
    const p = structuredClone(H.compilePlan());
    p.steps[0].encodedCall = (p.steps[0].encodedCall!.slice(0, -2) + "ff") as Hex;
    expect(gateCodes(pre(p))).toContain("PLAN_DIGEST_MISMATCH");
    const run = approvedRun();
    const bad = (run.plan.steps[0].encodedCall!.slice(0, -2) + "ff") as Hex;
    expect(
      codes(
        submit(
          run,
          decoderFor(run, (n) => (n === 0 ? { call: bad } : {})),
        ),
      ),
    ).toContain("signed_bytes_mismatch");
  });
  it("invalid signature: signed_signature_invalid (gate level; signature maths lives in @seam/chain)", () => {
    const run = approvedRun();
    expect(
      codes(
        submit(
          run,
          decoderFor(run, () => ({ signatureValid: false })),
        ),
      ),
    ).toContain("signed_signature_invalid");
  });
  it("undecodable bytes or missing decoder fail closed", () => {
    const run = approvedRun();
    const d = decoderFor(run);
    expect(codes(submit(run, { ...d, decodeSignedExtrinsic: () => null }))).toContain(
      "signed_extrinsic_undecodable",
    );
    expect(codes(submit(run, { requireTrustedDecoder: true }))).toContain(
      "trusted_decoder_required",
    );
  });
  it("reused approval: approval_reused", () => {
    const run = approvedRun();
    const store = new InMemoryApprovalStore();
    store.markUsed(usageKey(run.approval.hash));
    expect(codes(submit(run, { store }))).toContain("approval_reused");
  });
  it("expired approval: approval_expired at submit, SIGNING_WINDOW_EXPIRED in the browser gate", () => {
    const run = approvedRun();
    expect(codes(submit(run, { now: new Date(Date.parse(run.approval.expiresAt)) }))).toContain(
      "approval_expired",
    );
    const g = gatePolicy(
      {
        policy: run.policy,
        plan: run.plan,
        facts,
        preflight: run.preflight,
        manifest: H.demoManifest(),
      },
      { envelope: run.envelope, now: new Date("2026-10-20T10:30:00Z") },
    );
    expect(gateCodes(g)).toEqual(["SIGNING_WINDOW_EXPIRED"]);
  });
  it("stale nonce: nonce_stale when the account nonce moved past it, nonce_gap below, signed_nonce_mismatch in bytes", () => {
    const run = approvedRun();
    expect(codes(submit(run, { currentAccountNonce: 6 }))).toContain("nonce_stale");
    expect(codes(submit(run, { currentAccountNonce: 4 }))).toContain("nonce_gap");
    expect(codes(submit(run, { currentAccountNonce: -1 }))).toContain("nonce_stale");
    expect(
      codes(
        submit(
          run,
          decoderFor(run, (n) => ({ nonce: 4 + n })),
        ),
      ),
    ).toContain("signed_nonce_mismatch");
  });
  it("stale nonce per sequential step: step 2 expects envelope nonce + 1", () => {
    const run = approvedRun();
    const store = new InMemoryApprovalStore();
    const done = {
      actionId: run.plan.steps[0].actionId,
      status: "finalized" as const,
      txHash: ("0x" + "11".repeat(32)) as Hex,
      block: { number: 10, hash: ("0x" + "11".repeat(32)) as Hex },
      events: ["x"],
      verification: "verified" as const,
      reason: "",
    };
    store.markUsed(usageKey(run.approval.hash, 0));
    const step2 = { store, sendIndex: 1, previousSteps: [done] };
    expect(codes(submit(run, { ...step2, currentAccountNonce: 5 }))).toContain("nonce_gap");
    expect(codes(submit(run, { ...step2, currentAccountNonce: 7 }))).toContain("nonce_stale");
    expect(codes(submit(run, { ...step2, currentAccountNonce: 6 }))).not.toContain("nonce_stale");
  });
  it("expired mortality: mortality_expired outside [checkpoint, checkpoint + mortalityBlocks)", () => {
    const run = approvedRun();
    const start = run.envelope.checkpoint.number;
    expect(codes(submit(run, { currentBlockNumber: start + 64 }))).toContain("mortality_expired");
    expect(codes(submit(run, { currentBlockNumber: start - 1 }))).toContain("mortality_expired");
    expect(codes(submit(run, { currentBlockNumber: Number.NaN }))).toContain("mortality_expired");
    expect(codes(submit(run, { currentBlockNumber: start + 63 }))).not.toContain(
      "mortality_expired",
    );
  });
  it("malformed mortality in the envelope: mortality_invalid", () => {
    const run = approvedRun();
    expect(codes(submit(run, { envelope: { ...run.envelope, mortalityBlocks: 0 } }))).toContain(
      "mortality_invalid",
    );
  });
  it("runtime upgrade: runtime_changed at submit, RUNTIME_MISMATCH pre-sign", () => {
    const run = approvedRun();
    const up = { ...fp, specVersion: fp.specVersion + 1 };
    expect(codes(submit(run, { currentFingerprint: up }))).toContain("runtime_changed");
    expect(
      gateCodes(pre(run.plan, H.policy(), factsWith({ specVersion: fp.specVersion + 1 }))),
    ).toContain("RUNTIME_MISMATCH");
  });
  it("layout mismatch: a metadata hash change without proof of an identical layout is runtime_changed", () => {
    const run = approvedRun();
    const changed = { ...fp, metadataHash: ("0x" + "77".repeat(32)) as Hex };
    // No metadata blobs: the layout path can't run, so it must not pass.
    expect(codes(submit(run, { currentFingerprint: changed }))).toContain("runtime_changed");
    // Blobs given but the extrinsics don't prove CheckMetadataHash mode 0: still refused.
    expect(
      codes(
        submit(run, {
          currentFingerprint: changed,
          preparedMetadataHex: "0x00",
          currentMetadataHex: "0x01",
          ...decoderFor(run, () => ({ metadataHashMode: 1 })),
        }),
      ),
    ).toContain("runtime_changed");
  });
  it("failed dry run: DRY_RUN_FAILED pre-sign, signed_dry_run_failed at submit; unknown blocks by default", () => {
    const plan = H.compilePlan();
    const pf = H.preflight(plan);
    pf.steps[1].dryRun = "failed";
    expect(gateCodes(pre(plan, H.policy(), facts, pf))).toContain("DRY_RUN_FAILED");
    pf.steps[1].dryRun = "unknown";
    expect(gateCodes(pre(plan, H.policy(), facts, pf))).toContain("DRY_RUN_UNKNOWN");
    const run = approvedRun();
    expect(codes(submit(run, { signedDryRun: ["ok", "failed", "ok"] }))).toContain(
      "signed_dry_run_failed",
    );
    expect(codes(submit(run, { signedDryRun: ["ok", "unknown", "ok"] }))).toContain(
      "signed_dry_run_missing",
    );
  });
  it("fee cap exceeded: FEE_OVER_LIMIT; unknown fee FEE_LIMIT_UNKNOWN", () => {
    const plan = H.compilePlan();
    const pf = H.preflight(plan);
    pf.totalFee = { value: "10000000001" };
    expect(gateCodes(pre(plan, H.policy(), facts, pf))).toContain("FEE_OVER_LIMIT");
    pf.totalFee = { unknown: true };
    expect(gateCodes(pre(plan, H.policy(), facts, pf))).toContain("FEE_LIMIT_UNKNOWN");
  });
  it("duplicate request: a concurrent second send is approval_reserved; after an ambiguous send approval_uncertain", () => {
    const run = approvedRun();
    const store = new InMemoryApprovalStore();
    const key = usageKey(run.approval.hash);
    expect(store.reserve(key, { idempotencyKey: "a" }).ok).toBe(true);
    expect(codes(submit(run, { store }))).toContain("approval_reserved");
    expect(store.reserve(key, { idempotencyKey: "b" }).ok).toBe(false);
    store.markUncertain(key, { note: "timeout" });
    expect(codes(submit(run, { store }))).toContain("approval_uncertain");
  });
  it("duplicate step ids in a plan: DUPLICATE_STEP (new)", () => {
    const plan = edited((p) => (p.steps[1].actionId = p.steps[0].actionId));
    expect(gateCodes(pre(plan))).toContain("DUPLICATE_STEP");
  });
});

describe("P0-02 malformed policy objects fail closed in the browser path (new)", () => {
  it("a NaN or fractional maxSteps can't disable the cap: the policy digest refuses it (POLICY_EVALUATION_ERROR); a negative one is MAX_STEPS_EXCEEDED", () => {
    for (const maxSteps of [Number.NaN, 1.5])
      expect(gateCodes(pre(H.compilePlan(), H.policy({ maxSteps })))).toEqual([
        "POLICY_EVALUATION_ERROR",
      ]);
    expect(gateCodes(pre(H.compilePlan(), H.policy({ maxSteps: -1 })))).toContain(
      "MAX_STEPS_EXCEEDED",
    );
  });
  it("allowedModes given as a string can't substring-match a mode: PLAN_MODE_NOT_ALLOWED", () => {
    const p = H.policy({ allowedModes: "sequential_or_atomic_verified" as never });
    expect(gateCodes(pre(H.compilePlan(), p))).toContain("PLAN_MODE_NOT_ALLOWED");
  });
  it("a non-numeric cap throws inside the engine and the gate reports POLICY_EVALUATION_ERROR", () => {
    expect(gateCodes(pre(H.compilePlan(), H.policy({ maxFee: "ten" })))).toEqual([
      "POLICY_EVALUATION_ERROR",
    ]);
  });
});

// ---------------- Demo C ----------------
const demoC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../demo/demo-c.json", import.meta.url)), "utf8"),
);
describe("Demo C: policy violation blocked before the wallet opens", () => {
  const parsed = parsePolicy(demoC.policy);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const policy = parsed.policy;
  for (const [name, c] of Object.entries(demoC.cases) as [
    string,
    { expectCode: string; manifest: never },
  ][]) {
    it(`${name}: gatePolicy blocks with ${c.expectCode}, explains it, and no signing request is made`, () => {
      const manifest = { ...(c.manifest as object), chain: H.demoManifest().chain } as never;
      const plan = H.compilePlan(manifest);
      const preflight = H.preflight(plan);
      const input = { policy, plan, facts, preflight, manifest };
      const requestSignature = vi.fn();
      // What the console does: gate first, only then build/send the signing request.
      const g = gatePolicy(input, { envelope: H.envelope(), now: H.NOW });
      if (g.allowed) requestSignature(plan);
      expect(g.allowed).toBe(false);
      expect(gateCodes(g)).toEqual([c.expectCode]);
      expect(requestSignature).not.toHaveBeenCalled();
      const msg = g.blockedBy[0].message;
      if (c.expectCode === "RECIPIENT_NOT_ALLOWED")
        expect(msg).toBe(
          `Recipient allowed (step pay): Fail. Blocked: recipient ${H.CHARLIE} is not on the allowed list.`,
        );
      else
        expect(msg).toBe(
          "Amount within limit (step pay): Fail. Blocked: amount 1000000000001 is over the limit of 1000000000000 for asset 1.",
        );
      expect(explainPolicy(g.result!).find((e) => e.code === c.expectCode)?.message).toBe(msg);
      expect(() => assertPolicyAllows(input)).toThrow(PolicyBlockedError);
      try {
        assertPolicyAllows(input);
      } catch (e) {
        expect((e as PolicyBlockedError).codes).toEqual([c.expectCode]);
      }
      // And no approval can be minted for it, so there is nothing to sign.
      const out = createApproval({
        manifestDigest: plan.manifestDigest,
        plan,
        envelope: H.envelope(),
        preflight,
        policy,
        policyResult: g.result!,
        fingerprint: fp,
        now: H.NOW,
      });
      expect(out.ok).toBe(false);
    });
  }
});
