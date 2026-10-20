// @vitest-environment node
// The builder policy, derived only from a compiled plan, checked by the REAL @seam/policy engine with the recorded live V3
// preflight (evidence/testnet-v3/preflight-1792509095721.json) and facts from the committed V3 spec 3002 metadata.
// Nothing is signed or sent; only the chain calls are stubbed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factsFromMetadata } from "@seam/compiler/browser";
import { runPolicyGate } from "../../lib/policygate";
import { preSign, type ChainFns } from "../../lib/signflow";
import {
  DEFAULT_BUILDER_FEE_CAP,
  derivePolicy,
  policyJson,
  readPolicyJson,
  tightenPolicy,
} from "../../lib/builderpolicy";

const root = (p: string) => resolve(process.cwd(), "../..", p);
const json = (p: string) => JSON.parse(readFileSync(root(p), "utf8"));
const demo = json("packages/console/src/demo/v3-demo-transfer.json");
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
const plan = demo.plan;
const recipient = "5EkVZovjHsUQ2YLa2CnaVND8259u5c9h8eBtmRVweBpBVHXB";
const derive = () => {
  const d = derivePolicy(plan);
  if (!d.ok) throw new Error(d.message);
  return d.policy;
};
const gate = (policy: unknown) =>
  runPolicyGate({ policy, plan, manifest: demo.manifest, facts, preflight: recorded });

describe("builder policy (real engine)", () => {
  it("is derived strictly from the plan: its own asset, recipient, amount, mode and a fee cap", () => {
    const p = derive();
    expect(p.allowedCapabilities).toEqual(["Assets.transfer_keep_alive"]);
    expect(p.allowedAssets).toEqual(["806707"]);
    expect(p.allowedRecipients).toEqual([recipient]);
    expect(p.maxAmountPerAsset).toEqual({ "806707": "1", "*": "0" });
    expect(p.allowedModes).toEqual(["sequential"]);
    expect(p.maxSteps).toBe(1);
    expect(p.maxNativeValue).toBe("0");
    expect(p.maxFee).toBe(DEFAULT_BUILDER_FEE_CAP);
    expect(p.allowUnknown).toEqual({ storageDeposit: true, dryRun: true });
  });
  it("allows its own plan with the recorded V3 preflight", () => {
    const g = gate(derive());
    expect(g.ok ? "ok" : g.codes).toBe("ok");
    expect(g.explanations.length).toBeGreaterThan(0);
  });
  it("goes on through preSign to an engine-bound approval", async () => {
    const chain: ChainFns = {
      preflight: vi.fn(async () => recorded),
      signedExtrinsicDecoder: () => () => null,
      blockTimeFromFacts: () => 6000,
    };
    const r = await preSign({
      chain,
      send: async () => null,
      input: { policy: derive(), plan, manifest: demo.manifest },
      facts,
      signer: plan.signer.ss58 ?? demo.manifest.signer.value,
      ctx: {
        nonce: 0,
        mortalityBlocks: 64,
        checkpointNumber: 118892,
        checkpointHash: "0x" + "11".repeat(32),
      },
      now: new Date(),
    });
    expect(r.res.ok ? "ok" : r.res.message).toBe("ok");
    expect(r.res.ok && r.res.value.approval.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("tightening the amount below the plan blocks with the real code", () => {
    const t = tightenPolicy(derive(), { amounts: { "806707": "0" } });
    if (!t.ok) throw new Error(t.issues.join());
    const g = gate(t.policy);
    expect(g.ok).toBe(false);
    expect(
      !g.ok && g.explanations.some((x) => x.rule === "amount_limit" && x.status === "fail"),
    ).toBe(true);
  });
  it("removing the recipient blocks with the real code", () => {
    const t = tightenPolicy(derive(), { removeRecipients: [recipient] });
    if (!t.ok) throw new Error(t.issues.join());
    const g = gate(t.policy);
    expect(g.ok).toBe(false);
    expect(
      !g.ok && g.explanations.some((x) => x.rule === "recipient_allowed" && x.status === "fail"),
    ).toBe(true);
  });
  it("a fee cap below the preflight fee blocks", () => {
    const t = tightenPolicy(derive(), { maxFee: "1" });
    if (!t.ok) throw new Error(t.issues.join());
    expect(gate(t.policy).ok).toBe(false);
  });
  it("never loosens beyond the plan", () => {
    const t = tightenPolicy(derive(), {
      maxFee: "9" + DEFAULT_BUILDER_FEE_CAP,
      amounts: { "806707": "2", "1": "5" },
    });
    expect(t.ok).toBe(false);
    expect(!t.ok && t.issues.length).toBe(3);
  });
  it("has no default without a plan", () => {
    expect(derivePolicy(undefined as never).ok).toBe(false);
    expect(runPolicyGate({ policy: undefined, plan }).ok).toBe(false);
  });
  it("export JSON round-trips through the policy package's parsePolicy", () => {
    const t = tightenPolicy(derive(), { maxFee: "4000000000000" });
    if (!t.ok) throw new Error(t.issues.join());
    const back = readPolicyJson(policyJson(t.policy));
    expect(back.ok && back.policy).toEqual(t.policy);
    expect(back.ok && gate(back.policy).ok).toBe(true);
  });
});
