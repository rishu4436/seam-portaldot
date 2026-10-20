// execute (buildReceipt) and verify-live (verifyReceiptLive) must agree on the REAL Portaldot V3 runs (spec 3002):
// evidence/testnet-v3/runs/plan-sequential-*, plan-atomic-* and plan-revive-call-*. The mock reader serves only what was
// recorded for those finalized txs: the decoded events, the plan signer, and the signed call bytes
// (`signingRequests[i].payload.method`). Tampered variants are SYNTHETIC, derived from the real ones.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex, Plan, RuntimeFingerprint } from "@seam/compiler";
import {
  buildReceipt,
  verifyReceiptLive,
  type ChainEvent,
  type ContractEffect,
  type Receipt,
  type ReceiptChainReader,
  type StepOutcome,
} from "../src/index.js";

const run = (f: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../evidence/testnet-v3/runs/${f}`, import.meta.url)),
      "utf8",
    ),
  );
const parse = (s: string): ChainEvent => {
  const m = /^([A-Za-z]+)\.([A-Za-z]+)\((.*)\)$/s.exec(s)!;
  return { pallet: m[1]!, name: m[2]!, args: m[3] ? m[3].split(", ") : [] };
};
const SEQ = run("plan-sequential-1792411270138.json");
const ATOMIC = run("plan-atomic-1792411355057.json");
const CALL = run("plan-revive-call-1792412445848.json");
// Each run carries the fingerprint it was planned on (metadata can differ between runs), so each uses its own.
const fp = (rec: typeof SEQ) => rec.fingerprint as RuntimeFingerprint;
const V3 = fp(SEQ);
const LIVE: RuntimeFingerprint = { ...V3, metadataHash: ("0x" + "ab".repeat(32)) as Hex };

type Rec = typeof SEQ;
/** What execute saw for each step: recorded tx, events and the signed call bytes. */
const outcomesOf = (rec: Rec, structured = false): StepOutcome[] =>
  (rec.run.receipt as Receipt).steps.map((s, i) => ({
    actionId: s.actionId,
    status: s.status,
    txHash: s.txHash,
    block: s.block,
    events: structured
      ? rec.lastSubmit.inclusion.events.map((e: ChainEvent) => ({
          pallet: e.pallet,
          name: e.name,
          args: e.args,
        }))
      : s.events.map(parse),
    callHex: (rec.signingRequests[i] ?? rec.signingRequests[0]).payload.method as Hex,
  }));

/** A read-only chain that returns exactly the recorded data. `callHex` can be overridden to simulate tampering. */
const readerOf = (outcomes: StepOutcome[], signer: Hex, callHex?: Hex): ReceiptChainReader => ({
  // The node's live fingerprint: the V3 runtime with drifted metadata (only the metadata hash differs).
  async runtimeFingerprint() {
    return LIVE;
  },
  async finalizedNumber() {
    return Math.max(...outcomes.map((o) => o.block!.number)) + 10;
  },
  async canonicalHash(n) {
    return outcomes.find((o) => o.block!.number === n)?.block!.hash ?? null;
  },
  async readTx(blockHash, txHash) {
    const o = outcomes.find((x) => x.block!.hash === blockHash && x.txHash === txHash);
    return o
      ? { extrinsicIndex: 1, signer, callHex: callHex ?? o.callHex, events: o.events }
      : null;
  },
});

const execute = (
  rec: Rec,
  opts: { structured?: boolean; effects?: Record<string, ContractEffect> } = {},
) => {
  const outcomes = outcomesOf(rec, opts.structured);
  const receipt: Receipt = buildReceipt({
    plan: rec.plan as Plan,
    outcomes,
    runtime: fp(rec),
    ...(opts.effects ? { effects: opts.effects } : {}),
  });
  return { receipt, outcomes, plan: rec.plan as Plan };
};

describe("REAL V3 runs: execute and verify-live agree", () => {
  it("the record's fingerprint is the plan's fingerprint", () => {
    for (const r of [SEQ, ATOMIC, CALL]) expect(r.fingerprintDigest).toBe(r.plan.fingerprintDigest);
  });

  it("sequential (assets.transfer + nfts.mint): both verified, chain_verified", async () => {
    const { receipt, outcomes, plan } = execute(SEQ);
    expect(receipt.steps.map((s) => s.verification)).toEqual(["verified", "verified"]);
    const live = await verifyReceiptLive(receipt, readerOf(outcomes, plan.signer.publicKey), {
      plan,
      runtime: V3,
    });
    expect(live.problems).toEqual([]);
    expect(live.status).toBe("chain_verified");
    expect(live.steps.map((s) => s.status)).toEqual(["chain_verified", "chain_verified"]);
  });

  it("atomic (assets.mint + nfts.mint in one batch_all): both verified, chain_verified", async () => {
    const { receipt, outcomes, plan } = execute(ATOMIC);
    expect(receipt.steps.map((s) => s.verification)).toEqual(["verified", "verified"]);
    const live = await verifyReceiptLive(receipt, readerOf(outcomes, plan.signer.publicKey), {
      plan,
      runtime: fp(ATOMIC),
    });
    expect(live.problems).toEqual([]);
    expect(live.status).toBe("chain_verified");
  });

  it("revive.call with no expected event: unknown on both sides, never chain_verified", async () => {
    const { receipt, outcomes, plan } = execute(CALL, { structured: true });
    expect(receipt.steps[0]!.verification).toBe("unknown");
    expect(receipt.steps[0]!.coverage).not.toBe("effect_proven");
    const live = await verifyReceiptLive(receipt, readerOf(outcomes, plan.signer.publicKey), {
      plan,
      runtime: fp(CALL),
    });
    expect(live.problems).toEqual([]);
    expect(live.status).toBe("unknown");
    expect(live.steps[0]!.status).toBe("unknown");
  });

  it("revive.call with the expected ContractEmitted from dest: verified on both sides, chain_verified", async () => {
    const effects = { call: { emittedData: "0x" as Hex, emittedTopics: [] } };
    const { receipt, outcomes, plan } = execute(CALL, { structured: true, effects });
    expect([receipt.steps[0]!.verification, receipt.steps[0]!.coverage]).toEqual([
      "verified",
      "effect_proven",
    ]);
    const live = await verifyReceiptLive(receipt, readerOf(outcomes, plan.signer.publicKey), {
      plan,
      effects,
      runtime: fp(CALL),
    });
    expect(live.problems).toEqual([]);
    expect(live.status).toBe("chain_verified");
  });
});

describe("SYNTHETIC: fail closed", () => {
  it("no runtime given: a verified nfts.mint is unknown, not chain_verified and not a false failure", async () => {
    const { receipt, outcomes, plan } = execute(SEQ);
    const live = await verifyReceiptLive(receipt, readerOf(outcomes, plan.signer.publicKey), {
      plan,
    });
    expect(live.problems).toEqual([]);
    expect(live.status).toBe("unknown");
    expect(live.steps.map((s) => s.status)).toEqual(["chain_verified", "unknown"]);
  });

  it("the revive.call run's own fingerprint is not the sequential run's: binding is per receipt", async () => {
    const { receipt, outcomes, plan } = execute(SEQ);
    if (CALL.fingerprintDigest === SEQ.fingerprintDigest) return;
    const live = await verifyReceiptLive(receipt, readerOf(outcomes, plan.signer.publicKey), {
      plan,
      runtime: fp(CALL),
    });
    expect(live.status).toBe("failed");
  });

  it("a runtime that is not the receipt's (spec 3001, or another metadata hash): failed", async () => {
    const { receipt, outcomes, plan } = execute(SEQ);
    for (const rt of [
      { ...V3, specVersion: 3001 },
      { ...V3, metadataHash: ("0x" + "00".repeat(32)) as Hex },
    ]) {
      const live = await verifyReceiptLive(receipt, readerOf(outcomes, plan.signer.publicKey), {
        plan,
        runtime: rt,
      });
      expect(live.status).toBe("failed");
      expect(live.problems.join(" ")).toMatch(/fingerprint digest differs/);
    }
  });

  it("revive.call: on-chain call bytes that differ from the plan give failed", async () => {
    const effects = { call: { emittedData: "0x" as Hex, emittedTopics: [] } };
    const { receipt, outcomes, plan } = execute(CALL, { structured: true, effects });
    const real = outcomes[0]!.callHex!;
    const tampered = (real.slice(0, -2) + (real.endsWith("00") ? "01" : "00")) as Hex;
    const live = await verifyReceiptLive(
      receipt,
      readerOf(outcomes, plan.signer.publicKey, tampered),
      { plan, effects, runtime: fp(CALL) },
    );
    expect(live.status).toBe("failed");
  });

  it("revive.call: call bytes unreadable from the block give unknown", async () => {
    const effects = { call: { emittedData: "0x" as Hex, emittedTopics: [] } };
    const { receipt, outcomes, plan } = execute(CALL, { structured: true, effects });
    const reader = readerOf(outcomes, plan.signer.publicKey);
    const noCall: ReceiptChainReader = {
      ...reader,
      async readTx(b, t) {
        const r = await reader.readTx(b, t);
        return r ? { ...r, callHex: undefined } : r;
      },
    };
    const live = await verifyReceiptLive(receipt, noCall, { plan, effects, runtime: fp(CALL) });
    expect(live.status).not.toBe("chain_verified");
  });
});

describe("SYNTHETIC: the pinned runtime must be the node's runtime", () => {
  const go = async (live: RuntimeFingerprint | null | "missing") => {
    const { receipt, outcomes, plan } = execute(SEQ);
    const base = readerOf(outcomes, plan.signer.publicKey);
    const reader: ReceiptChainReader =
      live === "missing"
        ? { ...base, runtimeFingerprint: undefined }
        : { ...base, runtimeFingerprint: async () => live };
    return verifyReceiptLive(receipt, reader, { plan, runtime: V3 });
  };
  it("metadata hash drift only: pinned runtime used, chain_verified, drift noted", async () => {
    const live = await go(LIVE);
    expect(live.status).toBe("chain_verified");
    expect(live.notes.join(" ")).toMatch(/metadata hash differs/);
  });
  it("another genesis, spec, transaction version or ss58: failed", async () => {
    for (const bad of [
      { ...LIVE, genesisHash: ("0x" + "01".repeat(32)) as Hex },
      { ...LIVE, specVersion: 3003 },
      { ...LIVE, specName: "portaldot" },
      { ...LIVE, transactionVersion: LIVE.transactionVersion + 1 },
      { ...LIVE, ss58Prefix: 0 },
    ]) {
      const live = await go(bad);
      expect(live.status).toBe("failed");
      expect(live.problems.join(" ")).toMatch(/node is not the runtime this receipt is for/);
    }
  });
  it("live runtime unreadable or not provided: pinned runtime not used, unknown (never chain_verified)", async () => {
    for (const x of [null, "missing"] as const) {
      const live = await go(x);
      expect(live.status).toBe("unknown");
      expect(live.notes.join(" ")).toMatch(/runtime could not be read/);
    }
  });
});
