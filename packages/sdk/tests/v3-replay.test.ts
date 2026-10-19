// Replays REAL Portaldot V3 runs (evidence/testnet-v3/runs, spec 3002) through Seam.execute. Each record holds what was
// planned, approved and signed, and what the chain returned. The mocked adapter returns those recorded outcomes (status,
// tx hash, block, the extrinsic's decoded events) instead of talking to a node. The wallet "signs" by returning the
// recorded call bytes (signingRequests[].payload.method): the records keep no signatures. So this checks how execute
// wires the receipt (runtime, call bytes), not any signature. Variants marked SYNTHETIC are derived from the real records.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex, Plan } from "@seam/compiler";
import { InMemoryApprovalStore } from "@seam/policy";
import {
  Seam,
  perStepOfBatch,
  verifyStep,
  type ChainAdapter,
  type ChainEvent,
  type ContractEffect,
  type Receipt,
  type StepOutcome,
  type WalletSigner,
} from "../src/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = any;
const load = (f: string): Rec =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../evidence/testnet-v3/runs/${f}`, import.meta.url)),
      "utf8",
    ),
  );
const SEQ = load("plan-sequential-1792411270138.json"); // [pay assets.transfer, nft nfts.mint], #102653 / #102657
const ATOMIC = load("plan-atomic-1792411355057.json"); // batch_all [mint assets.mint, nft nfts.mint], #102671
const CALL = load("plan-revive-call-1792412445848.json"); // revive.call, #102853, contract emitted LOG0 (data 0x, no topics)
const TERM = load("plan-revive-terminate-1792412498767.json"); // revive.call data 0x01, #102862, no contract event

const ev = (e: ChainEvent): ChainEvent => ({ pallet: e.pallet, name: e.name, args: e.args });
/** The outcomes the funded run recorded for each sent transaction (by actionId; "batch" for atomic). */
function recordedOutcomes(rec: Rec): Record<string, StepOutcome> {
  const list: StepOutcome[] = rec.nftVerdictReceipt
    ? rec.nftVerdictReceipt.outcomesUsed.map((o: StepOutcome) => ({
        ...o,
        events: o.events.map(ev),
      }))
    : rec.run.receipt.steps.map((s: Rec) => ({
        actionId: s.actionId,
        status: s.status,
        txHash: s.txHash,
        block: s.block,
        events: rec.lastSubmit.inclusion.events.map(ev),
      }));
  return Object.fromEntries(list.map((o) => [o.actionId, o]));
}

function replayAdapter(rec: Rec, over: Partial<Record<string, Partial<StepOutcome>>> = {}) {
  const outcomes = recordedOutcomes(rec);
  const submitted: Hex[] = [];
  const signer = rec.envelope.signer as string;
  const chain: ChainAdapter = {
    discover: async () => rec.facts,
    readFingerprint: async () => rec.fingerprint,
    preflight: async () => ({ preflight: rec.preflight, envelope: rec.envelope }),
    dryRunSigned: async (txs: Hex[]) => txs.map(() => "ok" as const),
    submit: async (tx: Hex, id: string) => {
      submitted.push(tx);
      const o = outcomes[id];
      if (!o) throw new Error(`no recorded outcome for ${id}`);
      return { ...o, ...over[id] };
    },
    verifySigned: (txs: Hex[], calls: Hex[]) => ({
      ok: txs.length === calls.length && txs.every((t, i) => t === calls[i]),
      signedCalls: txs,
      reasons: [],
    }),
    signedDecoder: () => (xt: Hex) => ({ call: xt, signer, signatureValid: true }),
  };
  return { chain, submitted };
}

const recordedWallet = (rec: Rec): WalletSigner => ({
  sign: async () =>
    rec.signingRequests.map((r: Rec) => ({
      signedTx: r.payload.method as Hex,
      signedCall: r.payload.method as Hex,
    })),
});

async function replay(
  rec: Rec,
  opts: {
    effects?: Record<string, ContractEffect>;
    facts?: Rec;
    over?: Partial<Record<string, Partial<StepOutcome>>>;
  } = {},
) {
  const { chain, submitted } = replayAdapter(rec, opts.over);
  const seam = new Seam(chain, new InMemoryApprovalStore());
  const r = await seam.execute({
    plan: rec.plan as Plan,
    preflight: rec.preflight,
    envelope: rec.envelope,
    policy: rec.policy,
    policyResult: rec.policyResult,
    facts: opts.facts ?? rec.facts,
    approval: rec.approval.approval,
    wallet: recordedWallet(rec),
    now: () => new Date(rec.gateChecks[0].at),
    ...(opts.effects ? { effects: opts.effects } : {}),
  });
  if (!r.ok) throw new Error(`${r.stage}: ${r.reason}`);
  return { receipt: r.receipt, stoppedReason: r.stoppedReason, submitted };
}
const brief = (r: Receipt, id: string) => {
  const s = r.steps.find((x) => x.actionId === id)!;
  return [s.verification, s.coverage, s.code ?? null];
};

describe("the records are what they claim (REAL)", () => {
  it("spec 3002 portaldot-v3, the approval covers the recorded plan, and the signed calls are the plan's calls", () => {
    for (const rec of [SEQ, ATOMIC, CALL, TERM]) {
      expect([rec.facts.fingerprint.specName, rec.facts.fingerprint.specVersion]).toEqual([
        "portaldot-v3",
        3002,
      ]);
      expect(rec.facts.fingerprint).toEqual(rec.fingerprint);
      expect(rec.approval.approval.binding.planDigest).toBe(rec.plan.planDigest);
      const planned =
        rec.plan.mode === "atomic_verified"
          ? [rec.plan.outerCall.encodedCall]
          : rec.plan.steps.map((s: Rec) => s.encodedCall);
      expect(rec.signingRequests.map((r: Rec) => r.payload.method)).toEqual(planned);
    }
  });
  it("the receipts SEAM wrote during the funded run had nfts.mint and revive.call at unsupported_runtime", () => {
    expect(SEQ.run.receipt.steps[1].code).toBe("unsupported_runtime");
    expect(ATOMIC.run.receipt.steps[1].code).toBe("unsupported_runtime");
    expect(CALL.run.receipt.steps[0].code).toBe("unsupported_runtime");
  });
});

describe("Seam.execute replay of REAL V3 runs: execute passes runtime and call bytes to the receipt", () => {
  it("sequential [pay, nft]: both sent once, nfts.mint verified / effect_proven, run verified", async () => {
    const { receipt, submitted, stoppedReason } = await replay(SEQ);
    expect(submitted).toEqual(SEQ.signingRequests.map((r: Rec) => r.payload.method));
    expect(stoppedReason).toBeUndefined();
    expect(brief(receipt, "pay")).toEqual(["verified", "effect_proven", null]);
    expect(brief(receipt, "nft")).toEqual(["verified", "effect_proven", null]);
    expect(receipt.result).toBe("verified");
    // Same tx hashes and blocks as recorded on chain.
    expect(receipt.steps.map((s) => [s.txHash, s.block?.number])).toEqual(
      SEQ.run.receipt.steps.map((s: Rec) => [s.txHash, s.block.number]),
    );
  });
  it("atomic batch_all [mint, nft]: one send, nfts.mint verified / effect_proven", async () => {
    const { receipt, submitted } = await replay(ATOMIC);
    expect(submitted).toEqual([ATOMIC.plan.outerCall.encodedCall]);
    expect(brief(receipt, "mint")).toEqual(["verified", "effect_proven", null]);
    expect(brief(receipt, "nft")).toEqual(["verified", "effect_proven", null]);
    expect(receipt.result).toBe("verified");
  });
  it("revive.call without an expected event: unknown / effect_unproven (call bytes + success only)", async () => {
    const { receipt } = await replay(CALL);
    expect(brief(receipt, "call")).toEqual(["unknown", "extrinsic_finalized", "effect_unproven"]);
    expect(receipt.steps[0]!.basis).toBe("call_args_and_success");
    expect(receipt.result).not.toBe("verified");
  });
  it("revive.call with the expected ContractEmitted (data 0x, no topics) that matches: verified / effect_proven", async () => {
    const { receipt } = await replay(CALL, {
      effects: { call: { emittedData: "0x", emittedTopics: [] } },
    });
    expect(brief(receipt, "call")).toEqual(["verified", "effect_proven", null]);
    expect(receipt.steps[0]!.basis).toBe("call_args_success_and_emitted");
    expect(receipt.result).toBe("verified");
  });
  it("revive.call with an expected event that does not match: not_verified / effect_mismatch", async () => {
    const { receipt } = await replay(CALL, { effects: { call: { emittedData: "0xabcd" } } });
    expect(brief(receipt, "call")).toEqual(["not_verified", "contract_emitted", "effect_mismatch"]);
    // the terminate call (data 0x01) emitted nothing at all
    const t = await replay(TERM, { effects: { terminate: { emittedData: "0x" } } });
    expect(brief(t.receipt, "terminate")).toEqual([
      "not_verified",
      "extrinsic_finalized",
      "effect_mismatch",
    ]);
  });
});

describe("fails closed (SYNTHETIC variants of the REAL records)", () => {
  it("facts claiming another runtime than the node reports: blocked before anything is sent", async () => {
    const other = (rec: Rec) => ({
      ...rec.facts,
      fingerprint: { ...rec.facts.fingerprint, specVersion: 3001 },
    });
    // The prepared fingerprint differs from the one the node reports, so the gate blocks before sending.
    await expect(replay(SEQ, { facts: other(SEQ) })).rejects.toThrow(/submit_gate/);
  });
  it("an adapter-reported call that differs from the plan is used as reported: effect_mismatch", async () => {
    const callHex = (CALL.plan.steps[0].encodedCall as string).replace(
      "86b9cc2d456eed16a6872e1d5646f606a59cd95b",
      "11".repeat(20),
    ) as Hex;
    const { receipt } = await replay(CALL, {
      effects: { call: { emittedData: "0x" } },
      over: { call: { callHex } },
    });
    expect(brief(receipt, "call")).toEqual([
      "not_verified",
      "extrinsic_finalized",
      "effect_mismatch",
    ]);
  });
  it("perStepOfBatch: a batch call that is not exactly the plan's steps gives no per-step call bytes", () => {
    const outer = ATOMIC.plan.outerCall.encodedCall as Hex;
    const batch = recordedOutcomes(ATOMIC).batch!;
    const ok = perStepOfBatch(ATOMIC.plan, [batch], outer);
    expect(ok.map((o) => [o.actionId, o.callHex])).toEqual([
      ["batch", outer],
      ["mint", ATOMIC.plan.steps[0].encodedCall],
      ["nft", ATOMIC.plan.steps[1].encodedCall],
    ]);
    for (const bad of [
      (outer + "00") as Hex, // trailing byte
      (outer.slice(0, 6) + "0c" + outer.slice(8)) as Hex, // wrong count
      undefined,
    ]) {
      const got = perStepOfBatch(
        ATOMIC.plan,
        [{ ...batch, ...(bad ? { callHex: bad } : {}) }],
        bad,
      );
      expect(got.slice(1).every((o) => o.callHex === undefined)).toBe(true);
    }
  });
});

describe("agreement with live re-verification (verify-live's verifyStep call, with runtime and call bytes)", () => {
  // verify-live.ts on this branch calls verifyStep(planStep, signer, outcome, effect) with no runtime and no callHex;
  // Sentinel is adding both (bot3/v3-verify-wiring). Until then this calls the SDK verifyStep directly the way
  // verify-live will: outcome from the chain (status finalized, hash, block, events, call bytes), plus the runtime.
  const live = (rec: Rec, receipt: Receipt, id: string, effect?: ContractEffect) => {
    const step = rec.plan.steps.find((s: Rec) => s.actionId === id);
    const atomic = rec.plan.mode === "atomic_verified";
    const o = recordedOutcomes(rec)[atomic ? "batch" : id]!;
    const outcome = atomic
      ? perStepOfBatch(rec.plan, [o], rec.plan.outerCall.encodedCall).find(
          (x) => x.actionId === id,
        )!
      : { ...o, callHex: rec.signingRequests[rec.plan.steps.indexOf(step)].payload.method };
    const again = verifyStep(
      step,
      rec.plan.signer.publicKey,
      outcome,
      effect,
      undefined,
      rec.fingerprint,
    );
    const mine = receipt.steps.find((s) => s.actionId === id)!;
    return [again.verification, again.coverage, mine.verification, mine.coverage];
  };
  it("nfts.mint (sequential and atomic) and revive.call (with and without the expected event) agree", async () => {
    const seq = (await replay(SEQ)).receipt;
    expect(live(SEQ, seq, "nft")).toEqual([
      "verified",
      "effect_proven",
      "verified",
      "effect_proven",
    ]);
    const atomic = (await replay(ATOMIC)).receipt;
    expect(live(ATOMIC, atomic, "nft")).toEqual([
      "verified",
      "effect_proven",
      "verified",
      "effect_proven",
    ]);
    const plain = (await replay(CALL)).receipt;
    expect(live(CALL, plain, "call")).toEqual([
      "unknown",
      "extrinsic_finalized",
      "unknown",
      "extrinsic_finalized",
    ]);
    const effect = { emittedData: "0x" as Hex, emittedTopics: [] };
    const withE = (await replay(CALL, { effects: { call: effect } })).receipt;
    expect(live(CALL, withE, "call", effect)).toEqual([
      "verified",
      "effect_proven",
      "verified",
      "effect_proven",
    ]);
  });
});
