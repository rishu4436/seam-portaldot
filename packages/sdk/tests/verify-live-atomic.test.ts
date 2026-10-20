// verify-live on atomic plans and not_verified receipts.
// REAL: evidence/testnet-v3/runs/plan-atomic-* (batch_all of assets.mint + nfts.mint, #102671), plan-sequential-* and
// plan-revive-call-* (#102853). SYNTHETIC: an atomic plan wrapping the real revive.call bytes in batch_all (V3 has no real
// atomic revive.call yet), and tampered variants of the real records.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex, Plan, RuntimeFingerprint } from "@seam/compiler";
import {
  buildReceipt,
  perStepOfBatch,
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
const ATOMIC = run("plan-atomic-1792411355057.json");
const SEQ = run("plan-sequential-1792411270138.json");
const CALL = run("plan-revive-call-1792412445848.json");
const fp = (rec: typeof SEQ) => rec.fingerprint as RuntimeFingerprint;
const LIVE: RuntimeFingerprint = { ...fp(SEQ), metadataHash: ("0x" + "ab".repeat(32)) as Hex };

/** One read-only tx: what the chain returns for it. */
interface Tx {
  txHash: Hex;
  block: { number: number; hash: Hex };
  events: ChainEvent[];
  callHex?: Hex;
}
const readerOf = (txs: Tx[], signer: Hex): ReceiptChainReader => ({
  // The node's live fingerprint: the V3 runtime with drifted metadata (only the metadata hash differs).
  async runtimeFingerprint() {
    return LIVE;
  },
  async finalizedNumber() {
    return Math.max(...txs.map((t) => t.block.number)) + 10;
  },
  async canonicalHash(n) {
    return txs.find((t) => t.block.number === n)?.block.hash ?? null;
  },
  async readTx(blockHash, txHash) {
    const t = txs.find((x) => x.block.hash === blockHash && x.txHash === txHash);
    return t
      ? {
          extrinsicIndex: 1,
          signer,
          events: t.events,
          ...(t.callHex ? { callHex: t.callHex } : {}),
        }
      : null;
  },
});

/** Execute's side of an atomic run: one batch outcome, split per step exactly as flow.ts does. */
const executeAtomic = (
  plan: Plan,
  tx: Tx,
  runtime: RuntimeFingerprint,
  effects?: Record<string, ContractEffect>,
) =>
  buildReceipt({
    plan,
    outcomes: perStepOfBatch(
      plan,
      [
        {
          actionId: "batch",
          status: "finalized",
          txHash: tx.txHash,
          block: tx.block,
          events: tx.events,
        },
      ],
      tx.callHex,
    ),
    runtime,
    ...(effects ? { effects } : {}),
  });

describe("atomic plans: each step re-checks against its own slice of the on-chain batch", () => {
  const s = ATOMIC.run.receipt.steps[0];
  const realTx: Tx = {
    txHash: s.txHash,
    block: s.block,
    events: s.events.map(parse),
    callHex: ATOMIC.signingRequests[0].payload.method as Hex,
  };
  const plan = ATOMIC.plan as Plan;

  it("REAL atomic run (assets.mint + nfts.mint): execute and verify-live agree, chain_verified", async () => {
    const receipt = executeAtomic(plan, realTx, fp(ATOMIC));
    expect(receipt.steps.map((x) => x.verification)).toEqual(["verified", "verified"]);
    const live = await verifyReceiptLive(receipt, readerOf([realTx], plan.signer.publicKey), {
      plan,
      runtime: fp(ATOMIC),
    });
    expect(live.problems).toEqual([]);
    expect(live.status).toBe("chain_verified");
  });

  // SYNTHETIC atomic revive.call: the real V3 revive.call bytes, wrapped as batch_all([call]) with the real batch_all index.
  const callBytes = CALL.signingRequests[0].payload.method as string;
  const batchAll = (ATOMIC.plan.outerCall.encodedCall as string).slice(0, 6);
  const outer = `${batchAll}04${callBytes.slice(2)}` as Hex;
  const aplan = {
    ...(CALL.plan as Plan),
    mode: "atomic_verified",
    outerCall: { ...(ATOMIC.plan.outerCall as Plan["outerCall"]), encodedCall: outer },
  } as Plan;
  const cs = CALL.run.receipt.steps[0];
  const callTx: Tx = {
    txHash: cs.txHash,
    block: cs.block,
    events: CALL.lastSubmit.inclusion.events.map((e: ChainEvent) => ({
      pallet: e.pallet,
      name: e.name,
      args: e.args,
    })),
    callHex: outer,
  };
  const effects = { call: { emittedData: "0x" as Hex, emittedTopics: [] } };

  it("atomic revive.call with its expected event: verified on both sides, no contradiction", async () => {
    const receipt = executeAtomic(aplan, callTx, fp(CALL), effects);
    expect([receipt.steps[0]!.verification, receipt.steps[0]!.coverage]).toEqual([
      "verified",
      "effect_proven",
    ]);
    const live = await verifyReceiptLive(receipt, readerOf([callTx], aplan.signer.publicKey), {
      plan: aplan,
      effects,
      runtime: fp(CALL),
    });
    expect(live.problems).toEqual([]);
    expect(live.status).toBe("chain_verified");
  });

  it("atomic revive.call without an expected event: unknown on both sides", async () => {
    const receipt = executeAtomic(aplan, callTx, fp(CALL));
    expect(receipt.steps[0]!.verification).toBe("unknown");
    const live = await verifyReceiptLive(receipt, readerOf([callTx], aplan.signer.publicKey), {
      plan: aplan,
      runtime: fp(CALL),
    });
    expect(live.problems).toEqual([]);
    expect(live.status).toBe("unknown");
  });

  it("an on-chain batch that is not the planned one: failed, and no step gets call bytes", async () => {
    const receipt = executeAtomic(aplan, callTx, fp(CALL), effects);
    const other = (outer.slice(0, -2) + (outer.endsWith("00") ? "01" : "00")) as Hex;
    const live = await verifyReceiptLive(
      receipt,
      readerOf([{ ...callTx, callHex: other }], aplan.signer.publicKey),
      { plan: aplan, effects, runtime: fp(CALL) },
    );
    expect(live.status).toBe("failed");
    expect(
      perStepOfBatch(
        aplan,
        [{ ...callTx, actionId: "batch", status: "finalized", callHex: other }],
        undefined,
      ).find((o) => o.actionId === "call")?.callHex,
    ).toBeUndefined();
  });
});

describe("not_verified receipts re-check as failed, with a problem listed", () => {
  const outcomesOf = (rec: typeof SEQ): StepOutcome[] =>
    (rec.run.receipt as Receipt).steps.map((s, i) => ({
      actionId: s.actionId,
      status: s.status,
      txHash: s.txHash!,
      block: s.block!,
      events: s.events.map(parse),
      callHex: rec.signingRequests[i].payload.method as Hex,
    }));
  const txsOf = (o: StepOutcome[]): Tx[] =>
    o.map((x) => ({ txHash: x.txHash!, block: x.block!, events: x.events, callHex: x.callHex! }));

  it("SYNTHETIC: Nfts.Issued for the wrong item: the receipt says not_verified, verify-live fails", async () => {
    const o = outcomesOf(SEQ);
    o[1] = {
      ...o[1]!,
      events: o[1]!.events.map((e) =>
        e.pallet === "Nfts" && e.name === "Issued"
          ? { ...e, args: [e.args[0]!, "99", e.args[2]!] }
          : e,
      ),
    };
    const plan = SEQ.plan as Plan;
    const receipt = buildReceipt({ plan, outcomes: o, runtime: fp(SEQ) });
    expect(receipt.steps[1]!.verification).toBe("not_verified");
    const live = await verifyReceiptLive(receipt, readerOf(txsOf(o), plan.signer.publicKey), {
      plan,
      runtime: fp(SEQ),
    });
    expect(live.status).toBe("failed");
    expect(live.steps[1]!.status).toBe("failed");
    expect(live.problems.join(" ")).toMatch(/nft: the receipt says not_verified/);
  });

  it("SYNTHETIC: the receipt says verified but the chain re-check gives not_verified (wrong expected data): failed", async () => {
    const c = CALL.run.receipt.steps[0];
    const tx: Tx = {
      txHash: c.txHash,
      block: c.block,
      events: CALL.lastSubmit.inclusion.events.map((e: ChainEvent) => ({
        pallet: e.pallet,
        name: e.name,
        args: e.args,
      })),
      callHex: CALL.signingRequests[0].payload.method as Hex,
    };
    const plan = CALL.plan as Plan;
    const receipt = buildReceipt({
      plan,
      outcomes: [{ actionId: c.actionId, status: "finalized", ...tx }],
      runtime: fp(CALL),
      effects: { call: { emittedData: "0x" } },
    });
    expect(receipt.steps[0]!.verification).toBe("verified");
    const live = await verifyReceiptLive(receipt, readerOf([tx], plan.signer.publicKey), {
      plan,
      runtime: fp(CALL),
      effects: { call: { emittedData: "0xabcd" } },
    });
    expect(live.status).toBe("failed");
    expect(live.problems.join(" ")).toMatch(/give not_verified/);
  });
});
