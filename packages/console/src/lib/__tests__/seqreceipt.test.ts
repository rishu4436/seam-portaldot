// Sequential 2-step LIVE receipt: the real engine (preSign -> createApproval, policy gate) on a compiled 2-step plan with
// the recorded V3 preflight; signing, the submit gate and sending are fakes (no keys, no wallet, nothing broadcast).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApproval } from "@seam/policy/browser";
import { compile, factsFromMetadata } from "@seam/compiler/browser";
import * as chainBrowser from "@seam/chain/browser";
import { newApprovalStore, preSign, type ChainFns } from "../signflow";
import { runPlanSteps } from "../multistep";
import { runPolicyGate } from "../policygate";
import { buildSequentialReceipt } from "../seqreceipt";

const root = (p: string) => resolve(process.cwd(), "../..", p);
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
// The demo sequential policy, allowing two steps.
const policy = { ...seq.policy, maxSteps: 2 };
const pay = demo.manifest.actions[0];
const manifest = {
  ...demo.manifest,
  actions: [
    { ...pay, id: "pay1", preferredMode: "sequential" },
    { ...pay, id: "pay2", preferredMode: "sequential" },
  ],
};
const plan = compile(manifest as never, facts as never) as unknown as {
  mode: string;
  planDigest: string;
  signer: { publicKey: string };
  steps: { actionId: string; decodedArgs: Record<string, string> }[];
};
// The recorded single-step preflight, given once per step (same call, same dry-run result).
const preflight2 = {
  ...recorded,
  steps: plan.steps.map((s) => ({ ...recorded.steps[0], actionId: s.actionId })),
};
const chain: ChainFns = {
  preflight: vi.fn(async () => preflight2),
  signedExtrinsicDecoder: (() => () => {
    throw new Error("no decoding in this test");
  }) as never,
  blockTimeFromFacts: chainBrowser.blockTimeFromFacts as never,
  buildSigningEnvelope: chainBrowser.buildSigningEnvelope as never,
};
const signer = plan.signer.publicKey;
const recipient = "0x76d0e8b40899d424129b4ec688f889b3ce5cb12cadfa72c8898f4cb25d7cb172";
const SIGNED = (i: number) => "0x" + `7${i}`.repeat(120);
const outcome = (i: number) => ({
  actionId: plan.steps[i]!.actionId,
  status: "finalized" as const,
  txHash: "0x" + String(i + 1).repeat(64),
  block: { number: 120000 + i, hash: "0x" + `c${i}`.repeat(32) },
  extrinsicIndex: 1 + i,
  events: [
    { pallet: "Assets", name: "Transferred", args: ["806707", signer, recipient, "1"] },
    {
      pallet: "TransactionPayment",
      name: "TransactionFeePaid",
      args: [signer, String(1470877249652 + i), "0"],
    },
    { pallet: "System", name: "ExtrinsicSuccess", args: [] },
  ],
});

async function run(opts: { stopAfterFirst?: boolean } = {}) {
  const submitAndWait = vi.fn(async (i: number) => ({
    ok: true as const,
    value: outcome(i) as never,
  }));
  const r = await runPlanSteps({
    chain,
    send: async () => null,
    input: { policy, plan, manifest } as never,
    facts,
    signer: demo.manifest.signer.value,
    ctx: {
      nonce: 5,
      mortalityBlocks: 64,
      checkpointNumber: 119990,
      checkpointHash: "0x" + "ab".repeat(32),
    },
    now: () => new Date(),
    store: newApprovalStore(),
    freshFingerprint: async () => (facts as { fingerprint: unknown }).fingerprint,
    sign: vi.fn(async (i: number) => ({ ok: true as const, value: SIGNED(i) })),
    submitAndWait,
    gates: {
      preSign,
      policyGate: runPolicyGate,
      // The submit gate decodes real signatures; here it is a fake that blocks step 2 when asked.
      preSubmit: vi.fn(async (a: { sequential?: { sendIndex: number } }) =>
        opts.stopAfterFirst && a.sequential?.sendIndex === 1
          ? {
              ok: false as const,
              reason: "unavailable" as const,
              message: "Blocked at submit (test).",
            }
          : { ok: true as const, value: { passed: [] } },
      ) as never,
    },
  });
  return { r, submitAndWait, receipt: JSON.parse(JSON.stringify(buildSequentialReceipt(r))) };
}
const rerun = (i: Record<string, unknown>) => {
  const a = createApproval({ ...i, now: new Date(i.now as string) } as never);
  return a.ok ? a.approval.hash : `refused: ${a.reason}`;
};

describe("sequential multi-step receipt", () => {
  it("compiles a 2-step sequential plan", () => {
    expect(plan.mode).toBe("sequential");
    expect(plan.steps).toHaveLength(2);
  });
  it("2-step run: one engine approval, recomputable from approvalInputs, not the plan digest; per-step entries", async () => {
    const { r, receipt } = await run();
    expect(r.ok ? "ok" : r.message).toBe("ok");
    expect(receipt.approvalHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.approvalHash).not.toBe(plan.planDigest);
    expect(Object.keys(receipt.approvalInputs).sort()).toEqual(
      [
        "envelope",
        "fingerprint",
        "manifestDigest",
        "now",
        "plan",
        "policy",
        "policyResult",
        "preflight",
      ].sort(),
    );
    expect(rerun(receipt.approvalInputs)).toBe(receipt.approvalHash);
    expect(receipt.result).toBe("verified");
    expect(receipt.partialRun).toBe(false);
    expect(receipt.steps).toEqual(
      [0, 1].map((i) => ({
        index: i,
        actionId: plan.steps[i]!.actionId,
        sent: true,
        sendIndex: i,
        status: "finalized",
        txHash: outcome(i).txHash,
        block: outcome(i).block,
        extrinsicIndex: 1 + i,
        fee: String(1470877249652 + i),
        event: {
          pallet: "Assets",
          name: "Transferred",
          assetId: "806707",
          from: signer,
          to: recipient,
          amount: "1",
        },
        verification: "verified",
        reason: expect.any(String),
      })),
    );
  });
  it("tampering any approval input breaks the recompute", async () => {
    const { receipt } = await run();
    type O = Record<string, unknown>;
    const o = (x: unknown) => x as O;
    const cases: ((i: O) => void)[] = [
      (i) => (i.manifestDigest = "0x" + "11".repeat(32)),
      (i) => (o((o(i.plan).steps as unknown[])[1]).actionId = "x"),
      (i) => (o(i.envelope).nonce = (o(i.envelope).nonce as number) + 1),
      (i) => (o((o(i.preflight).steps as unknown[])[1]).dryRun = "tampered"),
      (i) => (o(i.policy).maxApprovalSeconds = (o(i.policy).maxApprovalSeconds as number) + 1),
      (i) => (o(i.policyResult).allowed = !o(i.policyResult).allowed),
      (i) => (o(i.fingerprint).specVersion = 1),
      (i) => (i.now = new Date(Date.parse(i.now as string) - 600_000).toISOString()),
    ];
    for (const f of cases) {
      const i = structuredClone(receipt.approvalInputs) as O;
      f(i);
      expect(rerun(i)).not.toBe(receipt.approvalHash);
    }
  });
  it("stopped after step 1: not verified, step 2 listed as not sent with the reason", async () => {
    const { submitAndWait, receipt } = await run({ stopAfterFirst: true });
    expect(submitAndWait).toHaveBeenCalledTimes(1);
    expect(receipt.result).toBe("not_verified");
    expect(receipt.partialRun).toBe(true);
    expect(receipt.stoppedAt).toBe(1);
    expect(receipt.stopReason).toMatch(/Stopped at step 2.*Blocked at submit/);
    expect(receipt.steps[0]).toMatchObject({ sent: true, sendIndex: 0, verification: "verified" });
    expect(receipt.steps[1]).toMatchObject({
      sent: false,
      sendIndex: null,
      txHash: null,
      verification: "not_sent",
    });
    expect(receipt.approvalHash).not.toBeNull();
    expect(rerun(receipt.approvalInputs)).toBe(receipt.approvalHash);
  });
  it("no signed bytes in the receipt", async () => {
    for (const stopAfterFirst of [false, true]) {
      const text = JSON.stringify((await run({ stopAfterFirst })).receipt);
      for (const i of [0, 1]) expect(text).not.toContain(SIGNED(i).slice(2));
      expect(text).not.toMatch(/"(signedTx|signedExtrinsics?|signature)":/);
    }
  });
});
