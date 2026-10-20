// @vitest-environment node
// Multi-step LIVE with Quill's real verifyStep (@seam/sdk/browser) over the REAL Portaldot V3 sequential run
// evidence/testnet-v3/runs/plan-sequential-1792411270138.json ([pay assets.transfer #102653, nft nfts.mint #102657]).
// The chain outcomes (status, tx hash, block, decoded events) are the recorded ones; the gates, signer and submit are
// fakes, so nothing is signed or sent. The records keep no signatures: the fake "signed bytes" are placeholders and
// the fake decoder returns the recorded call bytes (signingRequests[].payload.method).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canRunNextStep } from "@seam/policy/browser";
import { newApprovalStore } from "../../lib/signflow";
import { runPlanSteps, SignedHolder, type ReceiptStepLike } from "../../lib/multistep";
import { atomicStepReceipts, verifyPlanStep } from "../../lib/stepverify";

const rec = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "../../evidence/testnet-v3/runs/plan-sequential-1792411270138.json"),
    "utf8",
  ),
);
type Outcome = {
  actionId: string;
  status: "finalized";
  txHash: `0x${string}`;
  block: { number: number; hash: `0x${string}` };
  events: { pallet: string; name: string; args: string[] }[];
};
const outcomes: Outcome[] = rec.nftVerdictReceipt.outcomesUsed.map((o: Outcome) => ({
  actionId: o.actionId,
  status: o.status,
  txHash: o.txHash,
  block: o.block,
  events: o.events.map((e) => ({ pallet: e.pallet, name: e.name, args: e.args })),
}));
const calls: string[] = rec.signingRequests.map(
  (r: { payload: { method: string } }) => r.payload.method,
);
const SIGNED = (i: number) => "0x" + `e${i}`.repeat(150);

function run(outs: Outcome[], facts: unknown = rec.facts, R = rec, callList = calls) {
  const holder = new SignedHolder();
  const submitAndWait = vi.fn(async (i: number) => ({ ok: true as const, value: outs[i] }));
  const decode = vi.fn((x: string) => ({ call: callList[[SIGNED(0), SIGNED(1)].indexOf(x)] }));
  const ok = { ok: true as const, explanations: [] };
  const p = runPlanSteps({
    chain: {
      preflight: async () => ({ steps: [] }),
      signedExtrinsicDecoder: () => decode,
    } as never,
    send: async () => null,
    input: { policy: {}, plan: R.plan },
    facts,
    signer: R.envelope.signer,
    ctx: { nonce: 0, mortalityBlocks: 64, checkpointNumber: 1, checkpointHash: "0x" },
    now: () => new Date(),
    store: newApprovalStore(),
    freshFingerprint: async () => ({}),
    sign: async (i) => ({ ok: true, value: SIGNED(i) }),
    submitAndWait: submitAndWait as never,
    holder,
    gates: {
      preSign: async () => ({
        gate: ok,
        res: {
          ok: true,
          value: {
            approval: { hash: "0x" + "ab".repeat(32) },
            approvalInput: { envelope: { expiresAt: new Date(Date.now() + 60_000).toISOString() } },
          },
        },
      }),
      policyGate: () => ok,
      preSubmit: async () => ({ ok: true, value: { passed: [] } }),
    } as never,
  });
  return { p, submitAndWait, decode, holder };
}

describe("verifyStep gates the next step (real V3 records)", () => {
  it("the recorded run verifies both steps with verifyStep and the V3 runtime facts", async () => {
    const t = run(outcomes);
    const r = await t.p;
    expect(r.ok ? "ok" : r.message).toBe("ok");
    expect(r.steps.map((s) => s.receipt?.verification)).toEqual(["verified", "verified"]);
    expect(t.submitAndWait).toHaveBeenCalledTimes(2);
    // outcome.callHex came from the in-memory signed bytes through the decoder.
    expect(t.decode).toHaveBeenCalledWith(SIGNED(0));
    expect(t.decode).toHaveBeenCalledWith(SIGNED(1));
    // The policy engine's canRunNextStep agrees the run may continue after step 1.
    expect(canRunNextStep([r.steps[0].receipt as never]).ok).toBe(true);
    const text = JSON.stringify(r);
    expect(text).not.toContain(SIGNED(0).slice(2));
    expect(t.holder.size).toBe(0);
  });
  it("tampered copy (step 1 amount changed): step 1 not verified, step 2 never sent, bytes cleared", async () => {
    const bad = structuredClone(outcomes);
    const ev = bad[0].events.find((e) => e.pallet === "Assets" && e.name === "Transferred")!;
    ev.args[3] = "501";
    const t = run(bad);
    const r = await t.p;
    expect(r.ok).toBe(false);
    expect(r.steps[0].receipt?.verification).toBe("not_verified");
    expect(t.submitAndWait).toHaveBeenCalledTimes(1);
    expect(r.stoppedAt).toBe(1);
    expect(canRunNextStep([r.steps[0].receipt as never]).ok).toBe(false);
    expect(t.holder.size).toBe(0);
  });
  it("tampered recipient also stops step 2", async () => {
    const bad = structuredClone(outcomes);
    const ev = bad[0].events.find((e) => e.name === "Transferred")!;
    ev.args[2] = "0x" + "00".repeat(32);
    const r = await run(bad).p;
    expect(r.stoppedAt).toBe(1);
  });
  it("without the V3 runtime facts the nfts.mint step stays unknown (fail closed)", () => {
    const step = rec.plan.steps[1];
    const v = verifyPlanStep(step, rec.plan.signer.publicKey, outcomes[1], undefined, calls[1]);
    expect(v.verification).toBe("unknown");
    const w = verifyPlanStep(
      step,
      rec.plan.signer.publicKey,
      outcomes[1],
      rec.facts.fingerprint,
      calls[1],
    );
    expect(w.verification).toBe("verified");
  });
  it("a failed step 1 (ExtrinsicFailed) stops step 2", async () => {
    const bad = structuredClone(outcomes);
    bad[0].events = bad[0].events.map((e) =>
      e.name === "ExtrinsicSuccess" ? { ...e, name: "ExtrinsicFailed" } : e,
    );
    const t = run(bad);
    const r = await t.p;
    expect(r.steps[0].receipt?.verification as ReceiptStepLike["verification"]).toBe(
      "not_verified",
    );
    expect(t.submitAndWait).toHaveBeenCalledTimes(1);
  });

  describe("atomic (real V3 batch #102671, perStepOfBatch)", () => {
    const A = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "../../evidence/testnet-v3/runs/plan-atomic-1792411355057.json"),
        "utf8",
      ),
    );
    const batch: Outcome = (() => {
      const o = A.nftVerdictReceipt.outcomesUsed[0];
      return {
        actionId: o.actionId,
        status: o.status,
        txHash: o.txHash,
        block: o.block,
        events: o.events.map((e: Outcome["events"][0]) => ({
          pallet: e.pallet,
          name: e.name,
          args: e.args,
        })),
      };
    })();
    const batchCall: string = A.signingRequests[0].payload.method;
    it("one signing request; each step is per-step verified from the batch outcome", async () => {
      const t = run([batch], A.facts, A, [batchCall]);
      const r = await t.p;
      expect(r.ok ? "ok" : r.message).toBe("ok");
      expect(r.signRequests).toBe(1);
      expect(r.steps.map((s) => s.receipt?.verification)).toEqual(["verified", "verified"]);
      expect(
        r.steps.every((s) => /^per-step verified from the batch outcome/.test(s.message)),
      ).toBe(true);
      expect(JSON.stringify(r)).not.toMatch(/chain_verified/);
    });
    it("tampered batch copy (Assets.Issued amount changed): that step is not verified", async () => {
      const bad = structuredClone(batch);
      const ev = bad.events.find((e) => e.pallet === "Assets" && e.name === "Issued")!;
      ev.args[ev.args.length - 1] = "999999";
      const r = await run([bad], A.facts, A, [batchCall]).p;
      expect(r.steps[0].receipt?.verification).toBe("not_verified");
      expect(r.steps[1].receipt?.verification).toBe("verified");
      const direct = atomicStepReceipts(
        A.plan,
        bad as never,
        batchCall,
        A.plan.signer.publicKey,
        A.facts.fingerprint,
      );
      expect(direct.map((x) => x.verification)).toEqual(["not_verified", "verified"]);
    });
  });
});
