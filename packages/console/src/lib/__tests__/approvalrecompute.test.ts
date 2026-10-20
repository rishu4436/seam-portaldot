// approvalHash must be recomputable from the receipt alone: rerun @seam/policy createApproval on receipt.approvalInputs.
// Uses the demo plan and recorded V3 preflight with the real preSign; nothing is signed (no keys, no wallet).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApproval } from "@seam/policy/browser";
import { factsFromMetadata } from "@seam/compiler/browser";
import * as chainBrowser from "@seam/chain/browser";
import { preSign, type ChainFns } from "../signflow";
import { buildLiveReceipt } from "../livereceipt";
import type { LiveOutcome } from "../live";

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
const chain: ChainFns = {
  preflight: vi.fn(async () => recorded),
  signedExtrinsicDecoder: chainBrowser.signedExtrinsicDecoder as never,
  blockTimeFromFacts: chainBrowser.blockTimeFromFacts as never,
  buildSigningEnvelope: chainBrowser.buildSigningEnvelope as never,
};

async function receipt() {
  const now = new Date();
  const pre = await preSign({
    chain,
    send: async () => null,
    input: { policy: seq.policy, plan: demo.plan, manifest: demo.manifest } as never,
    facts,
    signer: demo.manifest.signer.value,
    ctx: {
      nonce: 1,
      mortalityBlocks: 64,
      checkpointNumber: 118300,
      checkpointHash: "0x" + "ab".repeat(32),
    },
    now,
  });
  if (!pre.res.ok) throw new Error(pre.res.message);
  const v = pre.res.value;
  const r = buildLiveReceipt({
    out: { status: "unverified", coverage: "none", txHash: "0x01" } as unknown as LiveOutcome,
    checked: true,
    engineApprovalHash: v.approval.hash,
    approvalInputs: { ...v.approvalInput, now: v.approvedAt },
    compiledPlan: demo.plan,
  });
  // What a verifier holds: the downloaded JSON.
  return JSON.parse(JSON.stringify(r)) as ReturnType<typeof buildLiveReceipt>;
}
const rerun = (i: Record<string, unknown>) => {
  const a = createApproval({ ...i, now: new Date(i.now as string) } as never);
  return a.ok ? a.approval.hash : `refused: ${a.reason}`;
};

describe("receipt.approvalInputs reproduce receipt.approvalHash", () => {
  it("rerunning createApproval from the downloaded receipt gives the same hash (not the plan digest)", async () => {
    const r = await receipt();
    expect(r.approvalHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.approvalHash).not.toBe(demo.plan.planDigest);
    expect(Object.keys(r.approvalInputs!).sort()).toEqual(
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
    expect(rerun(r.approvalInputs!)).toBe(r.approvalHash);
    // No signed-bytes or secret fields anywhere (prose like "a fake signature" in preflight notes is fine).
    expect(JSON.stringify(r)).not.toMatch(
      /"(signedTx|signedExtrinsics?|signature|seed|mnemonic|privateKey|secretKey|password)":/i,
    );
  });
  type Obj = Record<string, unknown>;
  const o = (x: unknown) => x as Obj;
  const tamper: [string, (i: Obj) => void][] = [
    ["manifestDigest", (i) => (i.manifestDigest = "0x" + "11".repeat(32))],
    ["plan", (i) => (o((o(i.plan).steps as unknown[])[0]).actionId = "other")],
    ["envelope", (i) => (o(i.envelope).nonce = (o(i.envelope).nonce as number) + 1)],
    ["preflight", (i) => (o((o(i.preflight).steps as unknown[])[0]).dryRun = "tampered")],
    [
      "policy",
      (i) => (o(i.policy).maxApprovalSeconds = (o(i.policy).maxApprovalSeconds as number) + 1),
    ],
    [
      "policyResult",
      (i) => (o(i.policyResult).rules as unknown[]).push({ id: "x", outcome: "pass", reason: "x" }),
    ],
    ["fingerprint", (i) => (o(i.fingerprint).specVersion = 1)],
    ["now", (i) => (i.now = new Date(Date.parse(i.now as string) - 10 * 60_000).toISOString())],
  ];
  for (const [field, f] of tamper)
    it(`tampering ${field} no longer reproduces approvalHash`, async () => {
      const r = await receipt();
      const i = structuredClone(r.approvalInputs!) as Obj;
      f(i);
      expect(rerun(i)).not.toBe(r.approvalHash);
    });
  it("no engine approval -> approvalInputs null", () => {
    const r = buildLiveReceipt({
      out: { status: "finalized", coverage: "none" } as unknown as LiveOutcome,
      checked: false,
      approvalInputs: { now: "x" },
    });
    expect(r.approvalHash).toBeNull();
    expect(r.approvalInputs).toBeNull();
  });
});
