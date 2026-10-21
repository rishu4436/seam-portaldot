// @vitest-environment node
// Persisted non-secret run state (lib/runstore.ts): recovery after a refresh, reconciliation by tx hash (read only),
// no rebroadcast (persisted single-flight guard + single-use approvals), and no secrets in storage.
// Gates, signer and submit are fakes; nothing is signed or sent.
import { describe, expect, it, vi } from "vitest";
import { usageKey } from "@seam/policy/browser";
import { runPlanSteps } from "../multistep";
import {
  assertNoSecrets,
  PersistedApprovalStore,
  RUN_STORE_KEY,
  RunStore,
  type KV,
  type TxLookup,
} from "../runstore";

const memKV = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const H = "0x" + "ab".repeat(32);
const TX = (i: number) => "0x" + `${i}e`.repeat(32);
const SIGNED = (i: number) => "0x" + `5${i}`.repeat(150);
const step = (id: string, hex: string) => ({
  actionId: id,
  kind: "assets.transfer",
  capability: "Assets.transfer_keep_alive",
  decodedArgs: {},
  encodedCall: hex,
  status: "ok",
});
const plan = {
  mode: "sequential",
  planDigest: "0x" + "cd".repeat(32),
  steps: [step("a", "0x01"), step("b", "0x02")],
};
const okGate = { ok: true as const, explanations: [] };

function run(kv: KV, opts: { submit?: (i: number) => unknown; blockAt?: number } = {}) {
  const runStore = new RunStore(kv);
  const store = new PersistedApprovalStore(runStore);
  const submitAndWait = vi.fn(async (i: number) =>
    opts.submit
      ? (opts.submit(i) as never)
      : {
          ok: true as const,
          value: {
            actionId: ["a", "b"][i],
            status: "finalized",
            txHash: TX(i),
            block: { number: 100 + i, hash: "0x" + `${i}b`.repeat(32) },
            events: [],
            verification: "verified",
            reason: "ok",
          },
        },
  );
  const p = runPlanSteps({
    chain: { preflight: vi.fn() } as never,
    send: async () => null,
    input: { policy: {}, plan },
    facts: {},
    signer: "5x",
    ctx: { nonce: 4, mortalityBlocks: 64, checkpointNumber: 1, checkpointHash: "0x" },
    now: () => new Date(),
    store,
    runStore,
    freshFingerprint: async () => ({ fingerprint: {} }),
    sign: vi.fn(async (i: number) => ({ ok: true as const, value: SIGNED(i) })),
    submitAndWait: submitAndWait as never,
    verifyOutcome: (_i, o) => o as never,
    gates: {
      preSign: vi.fn(async () => ({
        gate: okGate,
        res: {
          ok: true as const,
          value: {
            approval: { hash: H },
            approvalInput: { envelope: { expiresAt: new Date(Date.now() + 60_000).toISOString() } },
          } as never,
        },
      })),
      policyGate: vi.fn(() => okGate),
      preSubmit: vi.fn(async (a: { sequential?: { sendIndex: number } }) =>
        a.sequential?.sendIndex === opts.blockAt
          ? {
              ok: false as const,
              reason: "unavailable" as const,
              message: "Blocked at submit (x).",
            }
          : { ok: true as const, value: { passed: [] } },
      ),
    } as never,
  });
  return { p, runStore, store, submitAndWait };
}

describe("persisted run state", () => {
  it("records plan digest, approval hash, phase, step statuses, tx hashes, nonces and blocks under a versioned key", async () => {
    const kv = memKV();
    const { p } = run(kv);
    expect((await p).ok).toBe(true);
    const saved = JSON.parse(kv.data.get(RUN_STORE_KEY)!);
    expect(saved.version).toBe(1);
    const r = saved.runs[H];
    expect(r).toMatchObject({
      approvalHash: H,
      planDigest: plan.planDigest,
      phase: "finalized",
      mode: "sequential",
    });
    expect(
      r.steps.map(
        (s: { status: string; txHash: string; nonce: number; block: { number: number } }) => [
          s.status,
          s.txHash,
          s.nonce,
          s.block.number,
        ],
      ),
    ).toEqual([
      ["finalized", TX(0), 4, 100],
      ["finalized", TX(1), 5, 101],
    ]);
    expect(saved.used).toEqual([usageKey(H as never, 0), usageKey(H as never, 1)]);
    expect(Object.keys(saved.sends).sort()).toEqual([`${H}#0`, `${H}#1`]);
  });
  it("storage never contains signed bytes, signatures or metadata", async () => {
    const kv = memKV();
    await run(kv, { blockAt: 1 }).p;
    const raw = kv.data.get(RUN_STORE_KEY)!;
    for (const i of [0, 1]) expect(raw).not.toContain(SIGNED(i).slice(2, 40));
    expect(raw).not.toMatch(/signedTx|signature|metadataHex|encodedCall|callHex/i);
    expect(() => assertNoSecrets(JSON.stringify({ x: SIGNED(0) }))).toThrow();
    expect(() => assertNoSecrets(JSON.stringify({ metadataHex: "0x00" }))).toThrow();
  });
  it("after a refresh, the same approval can't be sent again (persisted guard + single-use approval)", async () => {
    const kv = memKV();
    await run(kv).p;
    const again = run(kv);
    const r = await again.p;
    expect(r.ok).toBe(false);
    expect(again.submitAndWait).not.toHaveBeenCalled();
    expect(again.store.has(usageKey(H as never, 0))).toBe(true);
  });
  it("recovery: signed-but-unsent steps become not_sent and the run abandoned (bytes are gone); nothing is sent", async () => {
    const kv = memKV();
    const rs = new RunStore(kv);
    rs.upsertRun({
      approvalHash: H,
      planDigest: plan.planDigest,
      phase: "signed",
      steps: [
        { index: 0, actionId: "a", status: "signed", nonce: 4, updatedAt: "t" },
        { index: 1, actionId: "b", status: "signed", nonce: 5, updatedAt: "t" },
      ],
    });
    const lookup = vi.fn();
    const [r] = await new RunStore(kv).recover(lookup as never);
    expect(r!.phase).toBe("abandoned");
    expect(r!.steps.map((s) => s.status)).toEqual(["not_sent", "not_sent"]);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("reconciliation: a tx hash is looked up on chain (found / failed / not seen), never re-sent", async () => {
    const kv = memKV();
    const rs = new RunStore(kv);
    rs.upsertRun({
      approvalHash: H,
      phase: "submitted",
      fromBlock: 120,
      steps: [0, 1, 2].map((i) => ({
        index: i,
        actionId: `s${i}`,
        status: "submitted" as const,
        txHash: TX(i),
        updatedAt: "t",
      })),
    });
    const lookup: TxLookup = vi.fn(async (q: { txHash: string }) =>
      q.txHash === TX(0)
        ? {
            status: "found" as const,
            blockNumber: 125,
            blockHash: "0x" + "99".repeat(32),
            extrinsicIndex: 2,
            success: true,
          }
        : q.txHash === TX(1)
          ? {
              status: "found" as const,
              blockNumber: 126,
              blockHash: "0x" + "aa".repeat(32),
              extrinsicIndex: 1,
              success: false,
            }
          : { status: "not_found" as const, scannedFrom: 120, scannedTo: 190 },
    );
    const [r] = await new RunStore(kv).recover(lookup);
    expect(r!.steps.map((s) => s.status)).toEqual(["in_block", "failed", "uncertain"]);
    expect(r!.steps[0]!.block?.number).toBe(125);
    expect(r!.steps[2]!.note).toMatch(/not seen in blocks #120\.\.#190 \(not proof/);
    expect(r!.phase).toBe("uncertain");
    expect(lookup).toHaveBeenCalledTimes(3);
    expect((lookup as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({
      txHash: TX(0),
      fromBlock: 120,
    });
  });
  it("a claimed send with no tx hash is uncertain and stays guarded; without a lookup nothing is invented", async () => {
    const kv = memKV();
    const rs = new RunStore(kv);
    rs.upsertRun({
      approvalHash: H,
      phase: "submitting",
      steps: [
        { index: 0, actionId: "a", status: "submitting", updatedAt: "t" },
        { index: 1, actionId: "b", status: "submitted", txHash: TX(1), updatedAt: "t" },
      ],
    });
    expect(rs.claimSend(H, 0)).toBe(true);
    const [r] = await new RunStore(kv).recover(undefined);
    expect(r!.steps[0]).toMatchObject({ status: "uncertain" });
    expect(r!.steps[1]!.note).toMatch(/reconcile unavailable/);
    expect(r!.steps[1]!.status).toBe("submitted");
    expect(r!.phase).toBe("uncertain");
    expect(new RunStore(kv).claimSend(H, 0)).toBe(false);
  });
});
