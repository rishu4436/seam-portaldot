// @vitest-environment node
// preSign / preSubmit with the REAL @seam/policy engine, the real demo plan, the sequential demo policy, facts from the
// committed V3 spec 3002 metadata and the real live V3 preflight result recorded by Chainsmith
// (evidence/testnet-v3/preflight-1792509095721.json). Only the chain calls are stubbed; nothing is signed or sent.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factsFromMetadata } from "@seam/compiler/browser";
import { blockTimeFromFacts, buildSigningEnvelope, SeamChainError } from "@seam/chain/browser";
import {
  engineApprovalCheck,
  newApprovalStore,
  preSign,
  preSubmit,
  type ChainFns,
} from "../../lib/signflow";

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
const ctx = {
  nonce: 0,
  mortalityBlocks: 64,
  checkpointNumber: 118892,
  checkpointHash: "0x" + "11".repeat(32),
};
const now = new Date();
const chain = (dryRun = "unknown"): ChainFns => ({
  preflight: vi.fn(async (_s, _p, _f, o?: { signedExtrinsics?: string[] }) =>
    o?.signedExtrinsics
      ? { ...recorded, steps: recorded.steps.map((s: object) => ({ ...s, dryRun })) }
      : recorded,
  ),
  signedExtrinsicDecoder: () => () => null,
  // Chainsmith's real envelope builder; the block time comes from the V3 spec 3002 metadata itself.
  blockTimeFromFacts: blockTimeFromFacts as never,
  buildSigningEnvelope: buildSigningEnvelope as never,
});
const input = { policy: seq.policy, plan: demo.plan, manifest: demo.manifest };
const base = {
  send: async () => null,
  input,
  facts,
  signer: demo.plan.signer.ss58 ?? demo.manifest.signer.value,
  ctx,
  now,
};

describe("signing gates (real engine)", () => {
  it("the real preflight passes the gate and the engine binds an approval", async () => {
    const r = await preSign({ ...base, chain: chain() });
    expect(r.res.ok ? "ok" : r.res.message).toBe("ok");
    expect(r.gate?.ok).toBe(true);
    expect(r.res.ok && r.res.value.approval.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("blocks before signing without a preflight producer result", async () => {
    const c = chain();
    c.preflight = async () => {
      throw new Error("node down");
    };
    const r = await preSign({ ...base, chain: c });
    expect(!r.res.ok && r.res.message).toMatch(/Preflight failed/);
  });
  it("the real V3 metadata gives a block time, so the envelope is built and LIVE gets past the gate", async () => {
    expect(blockTimeFromFacts(facts as never)).toBeGreaterThan(0);
    const r = await preSign({ ...base, chain: chain() });
    expect(
      r.res.ok && (r.res.value.approvalInput.envelope as { expiresAt: string }).expiresAt,
    ).toBe(new Date(now.getTime() + 63 * blockTimeFromFacts(facts as never)!).toISOString());
  });
  it("blocks before signing when the block time is unknown (NODE_MISSING_VALUE)", async () => {
    const c = {
      ...chain(),
      buildSigningEnvelope: () => {
        throw new SeamChainError(
          "NODE_MISSING_VALUE",
          "block time not in metadata; pass options.blockTimeMs",
        );
      },
    };
    const r = await preSign({ ...base, chain: c as never });
    expect(!r.res.ok && r.res.message).toMatch(/NODE_MISSING_VALUE.*block time/);
  });
  it("blocks before signing when the envelope builder is missing", async () => {
    const r = await preSign({ ...base, chain: { ...chain(), buildSigningEnvelope: undefined } });
    expect(!r.res.ok && r.res.message).toMatch(/envelope builder/);
  });
  it("blocks the atomic-only policy on mode before signing", async () => {
    const r = await preSign({ ...base, input: { ...input, policy: demo.policy }, chain: chain() });
    expect(!r.res.ok && r.gate && !r.gate.ok && r.gate.codes).toContain("PLAN_MODE_NOT_ALLOWED");
  });
  it("submit is blocked when the signed dry run is not ok, or the bytes can't be decoded", async () => {
    const c = chain("unknown");
    const pre = await preSign({ ...base, chain: c });
    if (!pre.res.ok) throw new Error(pre.res.message);
    const s = await preSubmit({
      chain: c,
      send: base.send,
      pre: pre.res.value,
      facts,
      signedTx: "0x1234",
      requests: [{}],
      now,
      store: newApprovalStore(),
      freshFingerprint: async () => facts.fingerprint,
    });
    expect(s.ok).toBe(false);
    expect(!s.ok && s.message).toMatch(/Blocked at submit/);
    expect(c.preflight).toHaveBeenLastCalledWith(base.send, demo.plan, facts, {
      signedExtrinsics: ["0x1234"],
    });
  });
  it("submit is blocked when the runtime can't be re-read", async () => {
    const c = chain("ok");
    const pre = await preSign({ ...base, chain: c });
    if (!pre.res.ok) throw new Error(pre.res.message);
    const s = await preSubmit({
      chain: c,
      send: base.send,
      pre: pre.res.value,
      facts,
      signedTx: "0x1234",
      requests: [{}],
      now,
      store: newApprovalStore(),
      freshFingerprint: async () => undefined,
    });
    expect(!s.ok && s.message).toMatch(/re-read the runtime/);
  });

  it("demo Approve comes from the real engine: allowed with the real preflight, blocked for atomic-only", async () => {
    const args = { chain: chain(), send: base.send, readFacts: async () => facts, now };
    expect((await engineApprovalCheck({ ...args, input })).ok).toBe(true);
    const bad = await engineApprovalCheck({ ...args, input: { ...input, policy: demo.policy } });
    expect(!bad.ok && bad.codes).toContain("PLAN_MODE_NOT_ALLOWED");
    const nofacts = await engineApprovalCheck({ ...args, readFacts: async () => undefined, input });
    expect(!nofacts.ok && nofacts.codes).toEqual(["FACTS_UNAVAILABLE"]);
  });
});
