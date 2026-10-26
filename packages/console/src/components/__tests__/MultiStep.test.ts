// @vitest-environment node
// Multi-step LIVE orchestration (lib/multistep.ts) with fakes for the gates, signer and submit: nothing is signed or sent.
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newApprovalStore } from "../../lib/signflow";
import { callsToSignOf, runPlanSteps, SignedHolder } from "../../lib/multistep";
import { planCall } from "../../lib/liverequest";

// Fixture paths resolve from this test file, not process.cwd(), so `vitest --root packages/console` works from the repo root.
const CONSOLE_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");

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

const SIGNED = (i: number) => "0x" + `5${i}`.repeat(150);
function setup(
  plan: object,
  opts: { blockAt?: number; expiresInMs?: number; clock?: () => number } = {},
) {
  const holder = new SignedHolder();
  const clock = opts.clock ?? (() => Date.now());
  const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 60_000)).toISOString();
  const order: string[] = [];
  const gates = {
    preSign: vi.fn(async () => {
      order.push("preSign");
      return {
        gate: okGate,
        res: {
          ok: true as const,
          value: {
            approval: { hash: "0x" + "ab".repeat(32) },
            approvalInput: { envelope: { expiresAt } },
          } as never,
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
    return { ok: true as const, value: SIGNED(i) };
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
      now: () => new Date(clock()),
      store: newApprovalStore(),
      holder,
      freshFingerprint: async () => ({ fingerprint: {} }),
      sign,
      submitAndWait: submitAndWait as never,
      // These fakes return receipt-shaped outcomes; the real verifyStep path is tested in VerifySteps.test.ts.
      verifyOutcome: (_i, o) => o as never,
      gates: gates as never,
    });
  return { run, order, gates, sign, submitAndWait, holder };
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
      signedExtrinsics: [SIGNED(0), SIGNED(1)],
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

  it("step 1 dispatch error: step 2 is never sent and every signed byte is cleared", async () => {
    const t = setup(seqPlan);
    t.submitAndWait.mockResolvedValueOnce({
      ok: true,
      value: {
        ...finalized("a"),
        status: "failed" as never,
        verification: "not_verified" as never,
      },
    });
    const r = await t.run();
    expect(r.ok).toBe(false);
    expect(t.submitAndWait).toHaveBeenCalledTimes(1);
    expect(r.steps[0].status).toBe("failed");
    expect(r.stoppedAt).toBe(1);
    expect(t.holder.size).toBe(0);
    expect(t.holder.all()).toBeUndefined();
  });
  it("step 1 blocked at submit: nothing is sent and every signed byte is cleared", async () => {
    const t = setup(seqPlan, { blockAt: 0 });
    const r = await t.run();
    expect(t.submitAndWait).not.toHaveBeenCalled();
    expect(r.stoppedAt).toBe(0);
    expect(t.holder.size).toBe(0);
  });
  it("submit transport failure on step 1: failed, step 2 not sent, bytes cleared", async () => {
    const t = setup(seqPlan);
    t.submitAndWait.mockResolvedValueOnce({ ok: false, message: "node refused" } as never);
    const r = await t.run();
    expect(r.steps.map((s) => s.status)).toEqual(["failed", "not_run"]);
    expect(t.submitAndWait).toHaveBeenCalledTimes(1);
    expect(t.holder.size).toBe(0);
  });
  it("expired signing window: nothing is sent (SIGNING_WINDOW_EXPIRED)", async () => {
    const t = setup(seqPlan, { expiresInMs: -1 });
    const r = await t.run();
    expect(t.submitAndWait).not.toHaveBeenCalled();
    expect(r.message).toMatch(/SIGNING_WINDOW_EXPIRED/);
    expect(t.holder.size).toBe(0);
  });
  it("window expiring after step 1 stops step 2 before it is sent", async () => {
    let now = Date.now();
    const t = setup(seqPlan, { expiresInMs: 1000, clock: () => now });
    t.submitAndWait.mockImplementationOnce(async () => {
      now += 5000;
      return { ok: true as const, value: finalized("a") };
    });
    const r = await t.run();
    expect(t.submitAndWait).toHaveBeenCalledTimes(1);
    expect(r.stoppedAt).toBe(1);
    expect(r.message).toMatch(/SIGNING_WINDOW_EXPIRED/);
  });
  it("cancel (unmount) before sending: nothing sent, bytes cleared", async () => {
    const ac = new AbortController();
    const t = setup(seqPlan);
    t.sign.mockImplementation(async (i: number) => {
      if (i === 1) ac.abort();
      return { ok: true as const, value: SIGNED(i) };
    });
    const r = await runPlanSteps({
      chain: { preflight: async () => ({ steps: [] }) } as never,
      send: async () => null,
      input: { policy: {}, plan: seqPlan },
      facts: {},
      signer: "5x",
      ctx: { nonce: 7, mortalityBlocks: 64, checkpointNumber: 1, checkpointHash: "0x" },
      now: () => new Date(),
      store: newApprovalStore(),
      freshFingerprint: async () => ({ fingerprint: {} }),
      sign: t.sign,
      submitAndWait: t.submitAndWait as never,
      verifyOutcome: (_i, o) => o as never,
      gates: t.gates as never,
      holder: t.holder,
      signal: ac.signal,
    });
    expect(r.ok).toBe(false);
    expect(t.submitAndWait).not.toHaveBeenCalled();
    expect(t.holder.size).toBe(0);
  });
});

describe("signed bytes never leave memory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  it("not in console output, localStorage, the result, step messages or receipts, even when echoed back", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const ls = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    const t = setup(seqPlan, { blockAt: 1 });
    // A node echoing the bytes back in its reason must not leak them into the UI.
    t.submitAndWait.mockResolvedValueOnce({
      ok: true,
      value: { ...finalized("a"), reason: `included ${SIGNED(0)}` },
    });
    t.gates.preSubmit.mockImplementation(async (a: { sequential?: { sendIndex: number } }) =>
      a.sequential?.sendIndex === 1
        ? { ok: false as const, reason: "unavailable" as const, message: `bad ${SIGNED(1)}` }
        : { ok: true as const, value: { passed: [] } },
    );
    const r = await t.run();
    const text = JSON.stringify(r);
    for (const i of [0, 1]) expect(text).not.toContain(SIGNED(i).slice(2));
    expect(text).toContain("[signed bytes]");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(ls.setItem).not.toHaveBeenCalled();
  });
  it("console source has no console.*, localStorage or sessionStorage calls, and exports never take signed bytes", () => {
    const root = resolve(CONSOLE_DIR, "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) {
          if (f !== "__tests__") walk(p);
        } else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\bconsole\.(log|info|warn|error|debug|trace)\(/);
      expect(src, f).not.toMatch(/\b(localStorage|sessionStorage)\b/);
      // Downloads / exports: no signed bytes in their arguments.
      for (const m of src.matchAll(/(downloadJson|download|policyJson)\(([^)]*)\)/g))
        expect(m[2], f).not.toMatch(/signed/i);
    }
  });
  it("one facts snapshot: preSign, every preSubmit and the fresh-fingerprint read all see the run's facts object", async () => {
    const t = setup(seqPlan);
    await t.run();
    const sf = (t.gates.preSign.mock.calls[0] as never as [{ facts: unknown }])[0].facts;
    const sub = t.gates.preSubmit.mock.calls.map(
      (c) => (c as never as [{ facts: unknown }])[0].facts,
    );
    expect(sub).toHaveLength(2);
    for (const f of sub) expect(f).toBe(sf);
  });
  it("each step keeps the submit gate's runtimeLock (policy result) for the receipt", async () => {
    const t = setup(seqPlan);
    const lock = {
      lockBasis: "layout_hash" as const,
      preparedMetadataHash: "0x01",
      currentMetadataHash: "0x02",
    };
    t.gates.preSubmit.mockImplementation(async () => ({
      ok: true as const,
      value: { passed: [], runtimeLock: lock } as never,
    }));
    const r = await t.run();
    expect(r.steps.map((s) => s.runtimeLock)).toEqual([lock, lock]);
  });
});
