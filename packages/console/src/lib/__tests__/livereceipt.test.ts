// @vitest-environment node
// The downloadable LIVE receipt carries verifyStep's per-step verdicts and an SDK-schema result. Built from REAL V3 records
// (evidence/testnet-v3/runs: the sequential run's "pay" assets.transfer #102653, the atomic batch #102671); offline.
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLiveReceipt } from "../livereceipt";
import { computePlanDigest } from "@seam/compiler/browser";
import { effectFromOutcome, PER_STEP_FROM_BATCH, stepVerdicts } from "../stepverify";
import type { EffectVerdict } from "../effectcheck";
import type { LiveOutcome } from "../live";

// Fixture paths resolve from this test file, not process.cwd(), so `vitest --root packages/console` works from the repo root.
const CONSOLE_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");

const rec = (f: string) =>
  JSON.parse(readFileSync(resolve(CONSOLE_DIR, "../../evidence/testnet-v3/runs", f), "utf8"));
const SEQ = rec("plan-sequential-1792411270138.json");
const ATOMIC = rec("plan-atomic-1792411355057.json");
const strip = (o: {
  actionId: string;
  status: string;
  txHash: string;
  block: { number: number; hash: string };
  events: { pallet: string; name: string; args: string[] }[];
}) => ({
  actionId: o.actionId,
  status: o.status,
  txHash: o.txHash,
  block: o.block,
  events: o.events.map((e) => ({ pallet: e.pallet, name: e.name, args: e.args })),
});
const payOutcome = strip(SEQ.nftVerdictReceipt.outcomesUsed[0]);
const out = (o: { txHash: string; block: { number: number; hash: string } }) =>
  ({
    status: "unverified",
    message: "",
    coverage: "extrinsic_finalized",
    simulation: "none",
    signing: "binding_ok",
    txState: "finalized",
    provenance: "unknown",
    rpcAttempts: 1,
    submitted: true,
    txHash: o.txHash,
    block: o.block,
  }) as unknown as LiveOutcome;
const effectOf = (steps: ReturnType<typeof stepVerdicts>): EffectVerdict =>
  steps.every((s) => s.verification === "verified")
    ? { verdict: "effect_proven", extrinsicIndex: -1, event: {}, steps, checkedAt: "t" }
    : { verdict: "not_verified", reason: "x", steps, checkedAt: "t" };
const ctx = {
  step: SEQ.plan.steps[0],
  signerAccountId: SEQ.plan.signer.publicKey,
  runtime: SEQ.facts.fingerprint,
};

describe("receipt carries the verifyStep verdict", () => {
  it("recorded V3 transfer, effect proven: per-step verdict and result 'verified' (never chain_verified)", () => {
    const steps = stepVerdicts(ctx, payOutcome as never, undefined);
    const r = buildLiveReceipt({
      out: out(payOutcome),
      effect: effectOf(steps),
      checked: true,
    });
    expect(r.result).toBe("verified");
    expect(r.verification).toBe("effect_proven");
    expect(r.liveStatusAtFinalization).toBe("unverified");
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({
      actionId: "pay",
      status: "finalized",
      verification: "verified",
      coverage: "effect_proven",
    });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/"chain_verified"/);
    expect(text).not.toMatch(/0x[0-9a-f]{200,}/i); // no signed or call bytes
  });
  it("unknown effect (no runtime facts for nfts.mint) stays not_verified", () => {
    const nft = strip(SEQ.nftVerdictReceipt.outcomesUsed[1]);
    const steps = stepVerdicts(
      { ...ctx, step: SEQ.plan.steps[1], runtime: undefined },
      nft as never,
      undefined,
    );
    expect(steps[0].verification).toBe("unknown");
    const r = buildLiveReceipt({ out: out(nft), effect: effectOf(steps), checked: true });
    expect(r.result).toBe("not_verified");
    expect(r.verification).toBe("unverified");
  });
  it("no verifyStep check at all (legacy / not checked) is never verified", () => {
    expect(buildLiveReceipt({ out: out(payOutcome), checked: true }).result).toBe("not_verified");
    const legacy = buildLiveReceipt({
      out: out(payOutcome),
      effect: { verdict: "effect_proven", extrinsicIndex: 1, event: {}, checkedAt: "t" },
      checked: true,
    });
    expect(legacy.result).toBe("not_verified");
  });
  it("tampered outcome (amount changed) -> not_verified", () => {
    const bad = structuredClone(payOutcome);
    bad.events.find((e) => e.name === "Transferred")!.args[3] = "501";
    const steps = stepVerdicts(ctx, bad as never, undefined);
    const r = buildLiveReceipt({ out: out(bad), effect: effectOf(steps), checked: true });
    expect(r.steps[0].verification).toBe("not_verified");
    expect(r.result).toBe("not_verified");
  });
  it("atomic: per-step verdicts from the batch outcome, labelled", () => {
    const batch = strip(ATOMIC.nftVerdictReceipt.outcomesUsed[0]);
    const steps = stepVerdicts(
      {
        step: undefined,
        plan: ATOMIC.plan,
        signerAccountId: ATOMIC.plan.signer.publicKey,
        runtime: ATOMIC.facts.fingerprint,
      },
      batch as never,
      undefined,
    );
    const r = buildLiveReceipt({ out: out(batch), effect: effectOf(steps), checked: true });
    expect(r.steps.map((s) => s.verification)).toEqual(["verified", "verified"]);
    expect(r.steps.every((s) => s.reason.startsWith(PER_STEP_FROM_BATCH))).toBe(true);
    expect(r.result).toBe("verified");
  });
});

describe("builder transfer #119634 (Chainsmith fb95dac read-only verification)", () => {
  // Chain data straight from Chainsmith's evidence on main; the fixture only holds the old receipt's values.
  const chain = JSON.parse(
    readFileSync(
      resolve(CONSOLE_DIR, "../../evidence/testnet-v3/builder-transfer-119634-verification.json"),
      "utf8",
    ),
  ).chain;
  const F = {
    ...JSON.parse(
      readFileSync(
        resolve(CONSOLE_DIR, "src/lib/__tests__/fixtures/builder-transfer-119634.json"),
        "utf8",
      ),
    ),
    txHash: chain.hash,
    block: chain.block,
    extrinsicIndex: chain.extrinsicIndex,
    fee: chain.fee,
    events: chain.events,
  };
  const demo = JSON.parse(
    readFileSync(resolve(CONSOLE_DIR, "src/demo/v3-demo-transfer.json"), "utf8"),
  );
  // Same transfer as the demo plan's step (asset 806707, amount 1, same recipient); signer is the builder account.
  const signerAccountId = F.events.find((e: { name: string }) => e.name === "Transferred").args[1];
  const outcome = {
    actionId: "pay",
    status: "finalized" as const,
    txHash: F.txHash,
    block: F.block,
    events: F.events,
  };
  const ctx119 = {
    step: demo.plan.steps[0],
    signerAccountId,
    runtime: { specName: "portaldot-v3", specVersion: 3002 },
    plan: demo.plan,
  };
  const effect = effectFromOutcome(ctx119, outcome as never, undefined, F.extrinsicIndex, "t");
  const oldOut = {
    ...out(outcome),
    status: F.oldReceipt.result,
    fee: F.oldReceipt.fee,
  } as LiveOutcome;
  const engineApprovalHash = "0x" + "e1".repeat(32);
  const r = buildLiveReceipt({
    out: oldOut,
    effect,
    checked: true,
    engineApprovalHash,
    compiledPlan: demo.plan,
  });
  it("1) effect proven -> result verified (old receipt said unverified)", () => {
    expect(F.oldReceipt.result).toBe("unverified");
    expect(effect.verdict).toBe("effect_proven");
    expect(r.result).toBe("verified");
    expect(r.steps[0].verification).toBe("verified");
  });
  it("2) fee is the actual TransactionFeePaid fee; the estimate is kept separately", () => {
    expect(F.oldReceipt.fee).toBe("1470877255420");
    expect(r.fee).toBe("1470877249652");
    expect(r.fee).toBe(F.fee);
    expect(r.feeEstimate).toBe("1470877255420");
    expect(r.feeBasis).toMatch(/TransactionFeePaid/);
  });
  it("3) extrinsicIndex and the matched Assets.Transferred event are filled from the inclusion", () => {
    expect(F.oldReceipt.effect.extrinsicIndex).toBe(-1);
    expect(r.effect).toMatchObject({
      extrinsicIndex: 1,
      event: {
        pallet: "Assets",
        name: "Transferred",
        assetId: "806707",
        from: signerAccountId,
        to: "0x76d0e8b40899d424129b4ec688f889b3ce5cb12cadfa72c8898f4cb25d7cb172",
        amount: "1",
      },
    });
  });
  it("4) approvalHash is the engine's createApproval hash, never the plan digest", () => {
    expect(F.oldReceipt.approvalHash).toBe(F.oldReceipt.planDigest); // the bug
    expect(r.approvalHash).toBe(engineApprovalHash);
    expect(buildLiveReceipt({ out: oldOut, effect, checked: true }).approvalHash).toBeNull();
  });
  it("5) the compiled plan is in the receipt and its digest recomputes", () => {
    const p = r.plan as typeof demo.plan;
    expect(computePlanDigest(p)).toBe(demo.plan.planDigest);
    expect(JSON.stringify(r)).not.toMatch(/0x[0-9a-f]{200,}/i);
  });
  it("tampered inclusion (amount 2) -> not_verified, no event claimed", () => {
    const bad = structuredClone(outcome);
    bad.events.find((e: { name: string }) => e.name === "Transferred").args[3] = "2";
    const e2 = effectFromOutcome(ctx119, bad as never, undefined, 1, "t");
    expect(e2.verdict).toBe("not_verified");
    expect(buildLiveReceipt({ out: oldOut, effect: e2, checked: true }).result).toBe(
      "not_verified",
    );
  });
});
