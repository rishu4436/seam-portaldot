// @vitest-environment node
// Submit blocked by signed_dry_run_failed: the console shows and records the dry-run detail exactly as @seam/chain's
// preflightReport returned it (checkBeforeSubmit reports only the code). Real @seam/policy gate, real V3 spec 3002
// facts; the chain's preflightReport is stubbed with the exact detail strings its dryRunOne produces. Nothing is signed.
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factsFromMetadata } from "@seam/compiler/browser";
import { blockTimeFromFacts, buildSigningEnvelope } from "@seam/chain/browser";
import {
  newApprovalStore,
  preSign,
  preSubmit,
  type BlockDetail,
  type ChainDryRun,
  type ChainFns,
} from "../../lib/signflow";
import { buildLiveReceipt } from "../../lib/livereceipt";
import { buildSequentialReceipt } from "../../lib/seqreceipt";

// Fixture paths resolve from this test file, not process.cwd(), so `vitest --root packages/console` works from the repo root.
const CONSOLE_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");

const root = (p: string) => resolve(CONSOLE_DIR, "../..", p);
const json = (p: string) => JSON.parse(readFileSync(root(p), "utf8"));
const demo = json("packages/console/src/demo/v3-demo-transfer.json");
const seq = json("packages/console/src/demo/v3-demo-transfer-policy-sequential.json");
const recorded = json("evidence/testnet-v3/preflight-1792509095721.json").result;
const META = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const facts = factsFromMetadata({
  metadataHex: META,
  genesisHash: demo.manifest.chain.genesisHash,
  tokenSymbol: "tPOT",
  tokenDecimals: 14,
});
const AT = { number: 120600, hash: "0x" + "5a".repeat(32) };
const SIGNED = "0x" + "c3".repeat(60);
const DISPATCH: ChainDryRun = {
  outcome: "failed",
  detail:
    "system_dryRun: dispatch failed: assets.BalanceLow: Account balance must be greater than or equal to the transfer amount.",
};
const STALE: ChainDryRun = {
  outcome: "failed",
  detail: "system_dryRun: invalid transaction: Stale",
};
const ctx = {
  nonce: 0,
  mortalityBlocks: 64,
  checkpointNumber: 118892,
  checkpointHash: "0x" + "11".repeat(32),
};
const now = new Date();
const input = { policy: seq.policy, plan: demo.plan, manifest: demo.manifest };

const chain = (dry: ChainDryRun | undefined, withReport = true): ChainFns => {
  const result = (o?: { signedExtrinsics?: string[] }) =>
    o?.signedExtrinsics
      ? { ...recorded, steps: recorded.steps.map((s: object) => ({ ...s, dryRun: "failed" })) }
      : recorded;
  return {
    preflight: vi.fn(async (_s, _p, _f, o) => result(o)),
    ...(withReport
      ? {
          preflightReport: vi.fn(async (_s, _p, _f, o) => ({
            result: result(o),
            atBlock: AT,
            transactions: [dry ? { dryRun: dry } : {}],
          })),
        }
      : {}),
    signedExtrinsicDecoder: () => () => null,
    blockTimeFromFacts: blockTimeFromFacts as never,
    buildSigningEnvelope: buildSigningEnvelope as never,
  };
};

async function blocked(c: ChainFns) {
  const pre = await preSign({
    chain: c,
    send: async () => null,
    input,
    facts,
    signer: demo.manifest.signer.value,
    ctx,
    now,
  });
  if (!pre.res.ok) throw new Error(pre.res.message);
  const s = await preSubmit({
    chain: c,
    send: async () => null,
    pre: pre.res.value,
    facts,
    signedTx: SIGNED,
    now,
    store: newApprovalStore(),
    freshFingerprint: async () => ({ fingerprint: facts.fingerprint }),
  });
  if (s.ok) throw new Error("expected a block");
  return s;
}

const seqResult = (bd: BlockDetail | undefined, message: string) =>
  ({
    ok: false,
    signRequests: 2,
    stoppedAt: 1,
    message,
    steps: [
      { index: 0, actionId: "s0", status: "sent", message: "ok", sendIndex: 0 },
      { index: 1, actionId: "s1", status: "blocked", message, ...(bd ? { blockDetail: bd } : {}) },
    ],
  }) as never;
const liveOut = (bd: BlockDetail | undefined, message: string) =>
  ({
    status: "blocked",
    message,
    coverage: "none",
    simulation: "none",
    signing: "submit_blocked",
    signingCode: "signed_dry_run_failed",
    txState: "unknown",
    provenance: "unknown",
    rpcAttempts: 0,
    submitted: false,
    ...(bd ? { blockDetail: bd } : {}),
  }) as never;

function checkRecorded(s: { message: string; blockDetail?: BlockDetail }) {
  const live = buildLiveReceipt({ out: liveOut(s.blockDetail, s.message), checked: false });
  const sr = buildSequentialReceipt(seqResult(s.blockDetail, s.message));
  expect(live.blockDetail).toEqual(s.blockDetail);
  expect(sr.steps[1]!.blockDetail).toEqual(s.blockDetail);
  expect("blockDetail" in sr.steps[0]!).toBe(false);
  for (const r of [live, sr]) {
    const t = JSON.stringify(r);
    expect(t).not.toContain(SIGNED.slice(2, 40));
    expect(t).not.toMatch(/metadataHex/);
    expect(t).not.toContain(META.slice(2, 200));
  }
}

describe("signed dry-run block detail", () => {
  it("dispatch error: shown in the message and the multi-step panel, recorded in both receipts", async () => {
    const s = await blocked(chain(DISPATCH));
    expect(s.message).toMatch(/signed_dry_run_failed/);
    expect(s.message).toContain(
      `Dry-run detail: failed, ${DISPATCH.detail} (dry run at block #120600, 0x5a5a5a5a…).`,
    );
    expect(s.blockDetail).toMatchObject({
      code: "signed_dry_run_failed",
      dryRun: DISPATCH,
      dryRunAt: AT,
    });
    checkRecorded(s);
  });
  it("validity error (Invalid::Stale): shown and recorded", async () => {
    const s = await blocked(chain(STALE));
    expect(s.message).toContain("invalid transaction: Stale");
    expect(s.blockDetail).toMatchObject({
      code: "signed_dry_run_failed",
      dryRun: STALE,
      dryRunAt: AT,
    });
    checkRecorded(s);
  });
  it("no detail from the chain: the UI says so plainly, and no block or dry run is invented", async () => {
    for (const c of [chain(undefined), chain(undefined, false)]) {
      const s = await blocked(c);
      expect(s.message).toContain("Dry-run detail: no detail reported by the gate.");
      expect(s.blockDetail).toEqual({ code: "signed_dry_run_failed", source: expect.any(String) });
      checkRecorded(s);
    }
  });
  it("sequential step 2: preSubmit dry-runs every signed tx in signing order and reports transactions[sendIndex]", async () => {
    const c = chain(undefined);
    c.preflightReport = vi.fn(async (_s, _p, _f, o) => ({
      result: {
        ...recorded,
        steps: [
          { actionId: "a", dryRun: "failed" },
          { actionId: "b", dryRun: "failed" },
        ],
      },
      atBlock: AT,
      transactions: (o?.signedExtrinsics ?? []).map((_x: string, j: number) => ({
        dryRun: j === 0 ? STALE : DISPATCH,
      })),
    }));
    const pre = await preSign({
      chain: c,
      send: async () => null,
      input,
      facts,
      signer: demo.manifest.signer.value,
      ctx,
      now,
    });
    if (!pre.res.ok) throw new Error(pre.res.message);
    const all = ["0x" + "a1".repeat(40), "0x" + "b2".repeat(40)];
    const s = await preSubmit({
      chain: c,
      send: async () => null,
      pre: pre.res.value,
      facts,
      signedTx: all[1]!,
      now,
      store: newApprovalStore(),
      freshFingerprint: async () => ({ fingerprint: facts.fingerprint }),
      sequential: { signedExtrinsics: all, sendIndex: 1, previousSteps: [] },
    });
    expect((c.preflightReport as ReturnType<typeof vi.fn>).mock.calls[0]![3]).toEqual({
      signedExtrinsics: all,
    });
    expect(!s.ok && s.blockDetail?.dryRun).toEqual(DISPATCH);
  });
});
