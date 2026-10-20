// @vitest-environment node
// Multi-step LIVE orchestration (lib/multistep.ts) with fakes for the gates, signer and submit: nothing is signed or sent.
import { describe, expect, it, vi } from "vitest";
import { newApprovalStore } from "../../lib/signflow";
import { callsToSignOf, runPlanSteps } from "../../lib/multistep";
import { planCall } from "../../lib/liverequest";

const step = (id: string, hex: string) => ({
  actionId: id,
  kind: "assets.transfer",
  capability: "Assets.transfer_keep_alive",
  decodedArgs: {},
  encodedCall: hex,
  status: "ok",
});
const seqPlan = { mode: "sequential", steps: [step("a", "0x01"), step("b", "0x02")] };
const atomicPlan = {
  mode: "atomic_verified",
  steps: [step("a", "0x01"), step("b", "0x02")],
  outerCall: { encodedCall: "0x0a0b" },
};
const okGate = { ok: true as const, explanations: [] };
const finalized = (id: string) => ({
  actionId: id,
  status: "finalized" as const,
  txHash: "0xaa",
  block: { number: 1, hash: "0xbb" },
  events: [],
  verification: "verified" as const,
  reason: "ok",
});

function setup(plan: object, opts: { blockAt?: number } = {}) {
  const order: string[] = [];
  const gates = {
    preSign: vi.fn(async () => {
      order.push("preSign");
      return {
        gate: okGate,
        res: {
          ok: true as const,
          value: { approval: { hash: "0x" + "ab".repeat(32) } } as never,
        },
      };
    }),
    policyGate: vi.fn(() => {
      order.push("gate");
      return okGate;
    }),
    preSubmit: vi.fn(async (a: { sequential?: { sendIndex: number } }) => {
      const i = a.sequential?.sendIndex ?? -1;
      order.push(`check${i}`);
      return i === opts.blockAt
        ? { ok: false as const, reason: "unavailable" as const, message: "Blocked at submit (x)." }
        : { ok: true as const, value: { passed: [] } };
    }),
  };
  const sign = vi.fn(async (i: number, _c: unknown, nonce: number) => {
    order.push(`sign${i}@${nonce}`);
    return { ok: true as const, value: `0xs${i}` };
  });
  const submitAndWait = vi.fn(async (i: number) => {
    order.push(`send${i}`);
    return { ok: true as const, value: finalized(["a", "b"][i]) };
  });
  const run = () =>
    runPlanSteps({
      chain: { preflight: vi.fn(async () => ({ steps: [] })) } as never,
      send: async () => null,
      input: { policy: {}, plan },
      facts: {},
      signer: "5x",
      ctx: { nonce: 7, mortalityBlocks: 64, checkpointNumber: 1, checkpointHash: "0x" },
      now: () => new Date(),
      store: newApprovalStore(),
      freshFingerprint: async () => ({}),
      sign,
      submitAndWait,
      gates: gates as never,
    });
  return { run, order, gates, sign, submitAndWait };
}

describe("multi-step LIVE", () => {
  it("atomic plan: one signing request for the batch_all call, one gate, one submit check", async () => {
    expect(callsToSignOf(atomicPlan as never)).toMatchObject({
      ok: true,
      value: [{ callHex: "0x0a0b", actionIds: ["a", "b"] }],
    });
    const t = setup(atomicPlan);
    const r = await t.run();
    expect(r.ok).toBe(true);
    expect(r.signRequests).toBe(1);
    expect(t.order).toEqual(["preSign", "sign0@7", "check-1", "send0"]);
  });
  it("sequential 2-step: signs in order (nonce n+i), then gate + checkBeforeSubmit per step with sendIndex", async () => {
    const t = setup(seqPlan);
    const r = await t.run();
    expect(r.ok).toBe(true);
    expect(t.order).toEqual([
      "preSign",
      "sign0@7",
      "sign1@8",
      "check0",
      "send0",
      "gate",
      "check1",
      "send1",
    ]);
    const calls = t.gates.preSubmit.mock.calls.map(
      (c) => (c as never as [{ sequential: object }])[0].sequential,
    );
    expect(calls[0]).toEqual({
      signedExtrinsics: ["0xs0", "0xs1"],
      sendIndex: 0,
      previousSteps: [],
    });
    expect(calls[1]).toMatchObject({ sendIndex: 1, previousSteps: [finalized("a")] });
  });
  it("a blocked step 2 is never sent, and the UI result names the step and reason", async () => {
    const t = setup(seqPlan, { blockAt: 1 });
    const r = await t.run();
    expect(r.ok).toBe(false);
    expect(t.submitAndWait).toHaveBeenCalledTimes(1);
    expect(t.order).not.toContain("send1");
    expect(r.stoppedAt).toBe(1);
    expect(r.message).toMatch(/Stopped at step 2 \(b\): Blocked at submit/);
    expect(r.steps.map((s) => s.status)).toEqual(["sent", "blocked"]);
  });
  it("a policy block before step 2 stops it, and a non-final step 1 stops step 2", async () => {
    const t = setup(seqPlan);
    t.gates.policyGate.mockReturnValueOnce({
      ok: false,
      codes: ["FEE_LIMIT"],
      explanations: [],
      message: "x",
    } as never);
    const r = await t.run();
    expect(r.ok).toBe(false);
    expect(t.submitAndWait).toHaveBeenCalledTimes(1);
    const u = setup(seqPlan);
    u.submitAndWait.mockResolvedValueOnce({
      ok: true,
      value: { ...finalized("a"), verification: "unknown" as never },
    });
    const r2 = await u.run();
    expect(r2.stoppedAt).toBe(1);
    expect(u.order).not.toContain("check1");
  });
  it("planCall no longer pretends to sign a multi-step sequential plan as one call", () => {
    const r = planCall({ mode: "sequential", signer: "5x", steps: [{}, {}] } as never);
    expect(!r.ok && r.message).toMatch(/step by step/);
  });
});
