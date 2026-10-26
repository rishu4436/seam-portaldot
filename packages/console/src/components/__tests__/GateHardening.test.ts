// @vitest-environment node
// Live gate hardening: the live console compiles the plan fresh from the Manifest on the live facts and never signs a
// stored plan; createApproval requirePlanVerified and checkBeforeSubmit live: true; every block code in plain words;
// Sentinel's Demo C. Real @seam/policy + @seam/compiler on committed V3 spec 3002 metadata. Nothing is signed or sent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { compile, factsFromMetadata } from "@seam/compiler/browser";
import { blockTimeFromFacts, buildSigningEnvelope } from "@seam/chain/browser";
import {
  BLOCK_CODE_TEXT,
  proofSizeText,
  blockCodeText,
  liveReadsFor,
  newApprovalStore,
  preSign,
  preSubmit,
  type ChainFns,
} from "../../lib/signflow";
import { runPlanSteps } from "../../lib/multistep";
import { demoCCases, runDemoC } from "../../lib/democ";

const root = (p: string) => fileURLToPath(new URL(`../../../../../${p}`, import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(root(p), "utf8"));
const demo = json("packages/console/src/demo/v3-demo-transfer.json");
const seq = json("packages/console/src/demo/v3-demo-transfer-policy-sequential.json");
const recorded = json("evidence/testnet-v3/preflight-1792509095721.json").result;
const facts = factsFromMetadata({
  metadataHex: readFileSync(
    root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
    "utf8",
  ).trim(),
  genesisHash: demo.manifest.chain.genesisHash,
  tokenSymbol: "tPOT",
  tokenDecimals: 14,
});
const fresh = compile(demo.manifest, facts as never) as unknown as { planDigest: string };
const ctx = {
  nonce: 0,
  mortalityBlocks: 64,
  checkpointNumber: 118892,
  checkpointHash: "0x" + "11".repeat(32),
};
const now = new Date();
const chain = (): ChainFns => ({
  preflight: vi.fn(async () => recorded),
  signedExtrinsicDecoder: () => () => null,
  blockTimeFromFacts: blockTimeFromFacts as never,
  buildSigningEnvelope: buildSigningEnvelope as never,
});
const liveCompile = {
  manifest: demo.manifest,
  compile: (m: unknown, f: unknown) => compile(m as never, f as never),
};
const base = {
  send: async () => null,
  facts,
  signer: demo.manifest.signer.value,
  ctx,
  now,
};

const freshFixture = json("packages/compiler/fixtures/v3-fresh-transfer.json");

describe("live gate hardening", () => {
  it("the console's live compile equals Forge's fresh V3 fixture (not a recorded run)", () => {
    expect(fresh.planDigest).toBe(freshFixture.planDigest);
  });

  it("the recorded demo plan is not what the Manifest compiles to now", () => {
    expect(demo.plan.planDigest).not.toBe(fresh.planDigest);
  });

  it("signing the stored demo plan is refused: STORED_PLAN_REFUSED, the wallet never opens", async () => {
    const c = chain();
    const r = await preSign({
      ...base,
      chain: c,
      input: { policy: seq.policy, plan: demo.plan, manifest: demo.manifest },
      live: liveCompile,
    });
    expect(r.res.ok).toBe(false);
    expect(!r.res.ok && r.res.message).toMatch(/STORED_PLAN_REFUSED/);
    expect(c.preflight).not.toHaveBeenCalled();
  });

  it("even if the stored plan slips past the compile step, createApproval(requirePlanVerified) refuses it", async () => {
    const r = await preSign({
      ...base,
      chain: chain(),
      input: { policy: seq.policy, plan: demo.plan, manifest: demo.manifest },
      // a compile that hands back the stored plan instead of compiling (the bypass)
      live: { manifest: demo.manifest, compile: () => demo.plan },
    });
    expect(r.res.ok).toBe(false);
    expect(!r.res.ok && r.res.message).toMatch(/call bytes are not what the Manifest compiles to/);
  });

  it("a multi-step live run with the stored plan stops before any signing request", async () => {
    const sign = vi.fn();
    const r = await runPlanSteps({
      ...base,
      chain: chain(),
      input: { policy: seq.policy, plan: demo.plan, manifest: demo.manifest },
      now: () => now,
      store: newApprovalStore(),
      freshFingerprint: async () => ({ fingerprint: facts.fingerprint }),
      sign,
      submitAndWait: vi.fn(),
      live: { ...liveCompile, readBlockNumber: async () => 1, readAccountNonce: async () => 0 },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/STORED_PLAN_REFUSED/);
    expect(sign).not.toHaveBeenCalled();
    expect(r.signRequests).toBe(0);
  });

  it("a Manifest that doesn't compile on the live runtime blocks (LIVE_COMPILE_FAILED)", async () => {
    const r = await preSign({
      ...base,
      chain: chain(),
      input: { policy: seq.policy, plan: undefined, manifest: {} },
      live: { manifest: {}, compile: liveCompile.compile },
    });
    expect(!r.res.ok && r.res.message).toMatch(/LIVE_COMPILE_FAILED/);
  });

  it("no Manifest blocks with live_manifest_missing", async () => {
    const r = await preSign({
      ...base,
      chain: chain(),
      input: { policy: seq.policy, plan: undefined },
      live: { manifest: undefined, compile: liveCompile.compile },
    });
    expect(!r.res.ok && r.res.message).toMatch(/live_manifest_missing/);
  });

  it("fresh compile: the plan approved is the fresh compile, verified against the Manifest, then live submit blocks on missing live inputs", async () => {
    const c = chain();
    const pre = await preSign({
      ...base,
      chain: c,
      input: { policy: seq.policy, plan: undefined, manifest: demo.manifest },
      live: liveCompile,
    });
    if (!pre.res.ok) throw new Error(pre.res.message);
    expect((pre.res.value.approvalInput.plan as { planDigest: string }).planDigest).toBe(
      fresh.planDigest,
    );
    expect(pre.res.value.live?.manifest).toBe(demo.manifest);
    const s = await preSubmit({
      chain: c,
      send: base.send,
      pre: pre.res.value,
      facts,
      signedTx: "0x1234",
      now,
      store: newApprovalStore(),
      freshFingerprint: async () => ({ fingerprint: facts.fingerprint }),
      liveReads: {
        readBlockNumber: async () => undefined,
        readAccountNonce: async () => undefined,
      },
    });
    expect(s.ok).toBe(false);
    const msg = !s.ok ? s.message : "";
    for (const code of ["live_block_missing", "live_nonce_missing", "live_signed_calls_missing"]) {
      expect(msg).toContain(code);
      expect(msg).toContain(BLOCK_CODE_TEXT[code]);
    }
    expect(msg).toMatch(/Nothing was sent/);
    expect(msg).not.toContain("0x1234");
  });

  it("every live block code has plain words", () => {
    for (const code of [
      "live_block_missing",
      "live_nonce_missing",
      "live_manifest_missing",
      "live_facts_missing",
      "live_signed_calls_missing",
      "manifest_digest_mismatch",
      "live_facts_mismatch",
      "plan_bytes_mismatch",
      "PLAN_BYTES_MISMATCH",
      "mortality_expired",
      "mortality_invalid",
      "nonce_stale",
      "nonce_gap",
      "policy_result_forged",
      "policy_result_unverified",
      "STORED_PLAN_REFUSED",
      "DEPLOY_PROOF_SIZE_UNKNOWN",
      "DEPLOY_GAS_LIMIT_MISSING",
      "CALL_PROOF_SIZE_UNKNOWN",
      "PROOF_SIZE_CALL_INFO_MISMATCH",
      "PROOF_SIZE_CALL_INFO_MISSING",
      "CALL_GAS_LIMIT_MISSING",
      "PROOF_SIZE_ESTIMATE_OVER_LIMIT",
    ]) {
      expect(BLOCK_CODE_TEXT[code], code).toBeTruthy();
      expect(blockCodeText(code)).toBe(`${code}: ${BLOCK_CODE_TEXT[code]}`);
    }
    expect(blockCodeText("SOMETHING_NEW")).toMatch(/no plain description/);
  });

  it("live reads: hex header number and nonce; anything unreadable stays unknown", async () => {
    const ok = liveReadsFor(
      async (m) => (m === "chain_getHeader" ? { number: "0x1d0e7" } : 7),
      "5Grw",
    );
    expect(await ok.readBlockNumber()).toBe(119_015);
    expect(await ok.readAccountNonce()).toBe(7);
    const bad = liveReadsFor(async () => {
      throw new Error("down");
    }, "5Grw");
    expect(await bad.readBlockNumber()).toBeUndefined();
    expect(await bad.readAccountNonce()).toBeUndefined();
  });
});

describe("live Revive proof size", () => {
  it("the live pre-sign gate gets requireMeasuredProofSize and requirePlanVerified", async () => {
    const gate = vi.fn(() => ({
      ok: false as const,
      codes: ["PROOF_SIZE_CALL_INFO_MISSING"],
      explanations: [],
      message: "x",
    }));
    const r = await preSign({
      ...base,
      chain: chain(),
      input: { policy: seq.policy, plan: undefined, manifest: demo.manifest },
      live: liveCompile,
      gate,
    });
    expect((gate.mock.calls[0] as unknown[])[1]).toMatchObject({
      requireMeasuredProofSize: true,
      requirePlanVerified: true,
    });
    expect(!r.res.ok && r.res.message).toContain(BLOCK_CODE_TEXT.PROOF_SIZE_CALL_INFO_MISSING);
  });
  it("both proof sizes shown; unknown is never shown as 0", () => {
    expect(
      proofSizeText({
        dryRunProofSize: { value: "12998" },
        callInfoProofSize: { value: "1007725" },
      }),
    ).toBe("Proof size: dry run 12998, call info 1007725.");
    expect(
      proofSizeText({ dryRunProofSize: { unknown: true }, callInfoProofSize: undefined }),
    ).toBe("Proof size: dry run unknown, call info unknown.");
    expect(proofSizeText({})).toBeUndefined();
  });
});

describe("Demo C: policy violation blocked before the wallet opens", () => {
  const cases = demoCCases();
  it("has the cases", () => expect(cases.length).toBeGreaterThan(0));
  for (const c of cases)
    it(`${c.id}: blocked with ${c.expectCode}, no signing request`, () => {
      const requestSignature = vi.fn();
      const { gate } = runDemoC({
        c,
        facts,
        chain: demo.manifest.chain,
        compile: liveCompile.compile,
        preflight: (plan) => ({
          steps: (plan as { steps: { actionId: string }[] }).steps.map((s) => ({
            actionId: s.actionId,
            weight: { value: "200000000" },
            fee: { value: "1500000000" },
            storageDeposit: { value: "0" },
            dryRun: "ok",
          })),
          totalFee: { value: "1500000000" },
        }),
        envelope: { expiresAt: new Date(now.getTime() + 600_000).toISOString() },
        now,
        requestSignature,
      });
      expect(gate.ok).toBe(false);
      expect(!gate.ok && gate.codes).toEqual([c.expectCode]);
      expect(requestSignature).not.toHaveBeenCalled();
    });
});
