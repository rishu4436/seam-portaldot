// Default nfts.mint receipt verification. Two kinds of data are used and labelled:
// - REAL: events and plans recorded on the hosted Portaldot V3 testnet (spec 3002) in evidence/testnet-v3/runs.
// - SYNTHETIC: hand-made outcomes, to show the failure cases fail closed.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex, Plan } from "@seam/compiler";
import {
  buildReceipt,
  checkReceipt,
  nftsShapeFor,
  V3_SPEC3002_NFTS_SHAPE,
  verifyNftsMintOutcome,
  type ChainEvent,
  type OutcomeVerdict,
  type StepOutcome,
} from "../src/index.js";

const run = (f: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../evidence/testnet-v3/runs/${f}`, import.meta.url)),
      "utf8",
    ),
  );
/** Receipt event strings are `Pallet.name(a, b, c)`; split back into a ChainEvent (args with commas only occur in System events). */
const parse = (s: string): ChainEvent => {
  const m = /^([A-Za-z]+)\.([A-Za-z]+)\((.*)\)$/s.exec(s)!;
  return { pallet: m[1]!, name: m[2]!, args: m[3] ? m[3].split(", ") : [] };
};
const outcomesFrom = (receipt: {
  steps: {
    actionId: string;
    status: StepOutcome["status"];
    txHash: Hex;
    block: { number: number; hash: Hex };
    events: string[];
  }[];
}): StepOutcome[] =>
  receipt.steps.map((s) => ({
    actionId: s.actionId,
    status: s.status,
    txHash: s.txHash,
    block: s.block,
    events: s.events.map(parse),
  }));

const SEQ = run("plan-sequential-1792411270138.json");
const ATOMIC = run("plan-atomic-1792411355057.json");
const V3 = SEQ.fingerprint as { specName: string; specVersion: number; ss58Prefix: number };

describe("REAL V3 evidence: nfts.mint verified by default, no explicit verdict", () => {
  it("sequential plan [pay, nft] from the funded run: both steps verified, receipt intact", () => {
    const r = buildReceipt({
      plan: SEQ.plan as Plan,
      outcomes: outcomesFrom(SEQ.run.receipt),
      runtime: V3,
    });
    const nft = r.steps.find((s) => s.actionId === "nft")!;
    expect([nft.verification, nft.coverage]).toEqual(["verified", "effect_proven"]);
    expect(r.result).toBe("verified");
    expect(checkReceipt(r)).toBe(true);
    // Same per-step answer as the recorded run's explicit-verdict receipt.
    const recorded = SEQ.nftVerdictReceipt.receipt.steps.find(
      (s: { actionId: string }) => s.actionId === "nft",
    );
    expect([nft.verification, nft.coverage]).toEqual([recorded.verification, recorded.coverage]);
  });
  it("atomic_verified plan [mint, nft] (one batch_all): verified", () => {
    const r = buildReceipt({
      plan: ATOMIC.plan as Plan,
      outcomes: outcomesFrom(ATOMIC.run.receipt),
      runtime: ATOMIC.fingerprint,
    });
    expect(r.steps.map((s) => s.verification)).toEqual(["verified", "verified"]);
    expect(r.result).toBe("verified");
  });
  it("the raw nfts.mint record (owner in SS58 form) matches the expected AccountId", () => {
    const raw = run("nfts-mint-1792409706466.json");
    const v = verifyNftsMintOutcome(
      {
        status: "finalized",
        events: raw.events,
        observedShape: true,
        shape: V3_SPEC3002_NFTS_SHAPE,
        ss58Prefix: 42,
      },
      {
        collection: "0",
        item: "0",
        mintTo: "0x80270a11d7b2e2b8b2dfb1ca3a45ab3b3f2339613709108c72f04074a8048467",
      },
    );
    expect([v.verification, v.coverage]).toEqual(["verified", "effect_proven"]);
  });
  it('the same real events without runtime facts are capped at contract_emitted ("not verified on V3")', () => {
    const r = buildReceipt({ plan: SEQ.plan as Plan, outcomes: outcomesFrom(SEQ.run.receipt) });
    const nft = r.steps.find((s) => s.actionId === "nft")!;
    expect([nft.verification, nft.coverage, nft.code]).toEqual([
      "unknown",
      "contract_emitted",
      "v3_shape_unobserved",
    ]);
    expect(nft.reason).toMatch(/not verified on V3/);
    expect(r.result).toBe("not_verified");
  });
  it("a different runtime (spec 3001, or another spec name) is capped", () => {
    for (const rt of [
      { ...V3, specVersion: 3001 },
      { ...V3, specName: "portaldot" },
    ]) {
      expect(nftsShapeFor(rt).observed).toBe(false);
      const nft = buildReceipt({
        plan: SEQ.plan as Plan,
        outcomes: outcomesFrom(SEQ.run.receipt),
        runtime: rt,
      }).steps[1]!;
      expect(nft.verification).toBe("unknown");
      expect(nft.coverage).toBe("contract_emitted");
    }
    expect(nftsShapeFor(V3).observed).toBe(true);
  });
});

describe("SYNTHETIC failure cases on the real plan shape", () => {
  const plan = SEQ.plan as Plan;
  const base = outcomesFrom(SEQ.run.receipt);
  const withNft = (events: ChainEvent[], status: StepOutcome["status"] = "finalized") => [
    base[0]!,
    { ...base[1]!, status, events },
  ];
  const OWNER = "0x80270a11d7b2e2b8b2dfb1ca3a45ab3b3f2339613709108c72f04074a8048467";
  const OK = { pallet: "System", name: "ExtrinsicSuccess", args: ["{}"] };
  const nftStep = (o: StepOutcome[], verdicts?: Record<string, OutcomeVerdict>) =>
    buildReceipt({ plan, outcomes: o, runtime: V3, ...(verdicts ? { verdicts } : {}) }).steps[1]!;

  it("wrong item, collection or owner: not_verified effect_mismatch", () => {
    for (const args of [
      ["0", "9", OWNER],
      ["1", "2", OWNER],
      ["0", "2", "0x" + "11".repeat(32)],
    ]) {
      const s = nftStep(withNft([{ pallet: "Nfts", name: "Issued", args }, OK]));
      expect([s.verification, s.code]).toEqual(["not_verified", "effect_mismatch"]);
    }
  });
  it("failed dispatch: tx_failed", () => {
    const s = nftStep(
      withNft([{ pallet: "System", name: "ExtrinsicFailed", args: ["Module", "{}"] }], "failed"),
    );
    expect([s.verification, s.code]).toEqual(["not_verified", "tx_failed"]);
  });
  it("no Nfts event: extrinsic_finalized, unknown", () => {
    const s = nftStep(withNft([OK]));
    expect([s.verification, s.coverage]).toEqual(["unknown", "extrinsic_finalized"]);
  });
  it("an explicit verdict still wins over the default", () => {
    const capped: OutcomeVerdict = {
      verification: "unknown",
      coverage: "contract_emitted",
      code: "v3_shape_unobserved",
      reason: "caller says capped",
    };
    const s = nftStep(base, { nft: capped });
    expect([s.verification, s.reason]).toEqual(["unknown", "caller says capped"]);
  });
  it("a forged verified verdict is still downgraded", () => {
    const forged: OutcomeVerdict = {
      verification: "verified",
      coverage: "effect_proven",
      reason: "forged",
      matchedEvent: "Nfts.Issued(0, 99, 0x00)",
    };
    expect(nftStep(base, { nft: forged }).verification).toBe("unknown");
  });
});
