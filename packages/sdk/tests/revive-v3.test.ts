// revive.call on Portaldot V3. REAL fixtures: evidence/testnet-v3/runs/plan-revive-call-1792412445848.json (tx 0xec917338…7482,
// #102853, contract emitted LOG0) and plan-revive-terminate-1792412498767.json (tx 0xc0ad1497…338f, #102862, data 0x01, no event).
// The call bytes used are the signed extrinsic's call (`signingRequests[0].payload.method`) of that finalized tx; the events are the
// decoded events of that extrinsic (`lastSubmit.inclusion.events`). Tampered variants are SYNTHETIC, derived from the real ones.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex, Plan } from "@seam/compiler";
import {
  buildReceipt,
  decodeV3ReviveCall,
  verifyReviveCallV3Outcome,
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
const CALL = run("plan-revive-call-1792412445848.json");
const TERM = run("plan-revive-terminate-1792412498767.json");
const V3 = CALL.fingerprint as { specName: string; specVersion: number; ss58Prefix: number };
const DEST = "0x86b9cc2d456eed16a6872e1d5646f606a59cd95b";
const events = (rec: typeof CALL): ChainEvent[] =>
  rec.lastSubmit.inclusion.events.map((e: ChainEvent) => ({
    pallet: e.pallet,
    name: e.name,
    args: e.args,
  }));
const outcome = (rec: typeof CALL, over: Partial<StepOutcome> = {}): StepOutcome => {
  const s = rec.run.receipt.steps[0];
  return {
    actionId: s.actionId,
    status: "finalized",
    txHash: s.txHash,
    block: s.block,
    events: events(rec),
    callHex: rec.signingRequests[0].payload.method as Hex,
    ...over,
  };
};
const step = (
  rec: typeof CALL,
  effects?: Record<string, { emittedData?: Hex; emittedTopics?: Hex[] }>,
  o?: StepOutcome,
  runtime: unknown = V3,
) =>
  buildReceipt({
    plan: rec.plan as Plan,
    outcomes: [o ?? outcome(rec)],
    ...(runtime ? { runtime: runtime as typeof V3 } : {}),
    ...(effects ? { effects } : {}),
  }).steps[0]!;
const callHex: string = CALL.signingRequests[0].payload.method;

describe("decodeV3ReviveCall: the real V3 spec 3002 Revive.call layout", () => {
  it("decodes the real SEAM-compiled call bytes", () => {
    expect(decodeV3ReviveCall(callHex as Hex)).toEqual({
      palletIndex: 80,
      callIndex: 1,
      dest: DEST,
      value: "0",
      gasLimit: "5000000000",
      proofSize: "200000",
      storageDepositLimit: "10000000000000",
      data: "0x",
    });
    expect(decodeV3ReviveCall(TERM.signingRequests[0].payload.method)?.data).toBe("0x01");
  });
  it("undecodable bytes give undefined (truncated, trailing bytes, not hex)", () => {
    expect(decodeV3ReviveCall(callHex.slice(0, 30) as Hex)).toBeUndefined();
    expect(decodeV3ReviveCall((callHex + "ff") as Hex)).toBeUndefined();
    expect(decodeV3ReviveCall("0xzz" as Hex)).toBeUndefined();
  });
});

describe("REAL V3: revive.call default verdict (no explicit verdict)", () => {
  it("call args + success, no expected event: capped below effect_proven with basis call_args_and_success", () => {
    const s = step(CALL);
    expect([s.verification, s.coverage, s.code, s.basis]).toEqual([
      "unknown",
      "extrinsic_finalized",
      "effect_unproven",
      "call_args_and_success",
    ]);
    expect(s.reason).toMatch(/no per-call event/);
  });
  it("with the expected ContractEmitted (data 0x, no topics) from dest: verified, effect_proven", () => {
    const s = step(CALL, { call: { emittedData: "0x", emittedTopics: [] } });
    expect([s.verification, s.coverage, s.basis]).toEqual([
      "verified",
      "effect_proven",
      "call_args_success_and_emitted",
    ]);
    const r = buildReceipt({
      plan: CALL.plan as Plan,
      outcomes: [outcome(CALL)],
      runtime: V3,
      effects: { call: { emittedData: "0x" } },
    });
    expect(r.result).toBe("verified");
  });
  it("terminate call (data 0x01) emitted nothing: capped without an expectation, not_verified with one", () => {
    expect(step(TERM).basis).toBe("call_args_and_success");
    const s = step(TERM, { terminate: { emittedData: "0x" } });
    expect([s.verification, s.code]).toEqual(["not_verified", "effect_mismatch"]);
  });
  it("no runtime or another runtime: stays unsupported_runtime (layout not observed there)", () => {
    expect(step(CALL, undefined, undefined, null).code).toBe("unsupported_runtime");
    expect(step(CALL, undefined, undefined, { ...V3, specVersion: 3001 }).code).toBe(
      "unsupported_runtime",
    );
  });
  it("no call bytes reported: unknown (fail closed)", () => {
    const { callHex: _c, ...noCall } = outcome(CALL);
    const s = step(CALL, { call: { emittedData: "0x" } }, noCall);
    expect([s.verification, s.code]).toEqual(["unknown", "effect_unproven"]);
    expect(s.reason).toMatch(/call bytes/);
  });
});

describe("SYNTHETIC tampering of the real record", () => {
  const swap = (from: string, to: string) =>
    outcome(CALL, { callHex: callHex.replace(from, to) as Hex });
  it("tampered dest, value, data, weight or deposit limit: not_verified effect_mismatch", () => {
    const cases = [
      swap("86b9cc2d456eed16a6872e1d5646f606a59cd95b", "11".repeat(20)), // dest
      swap(
        "86b9cc2d456eed16a6872e1d5646f606a59cd95b00",
        "86b9cc2d456eed16a6872e1d5646f606a59cd95b04",
      ), // value 1
      outcome(CALL, { callHex: (callHex.slice(0, -2) + "0401") as Hex }), // data 0x01
      swap("0700f2052a01", "0700e40b5402"), // weight refTime 1e10
      swap("0b00a0724e1809", "0b0040e59c3012"), // deposit limit 2e13
    ];
    for (const o of cases) {
      const s = step(CALL, { call: { emittedData: "0x" } }, o);
      expect([s.verification, s.code]).toEqual(["not_verified", "effect_mismatch"]);
    }
  });
  it("undecodable call bytes: unknown", () => {
    const s = step(CALL, undefined, outcome(CALL, { callHex: (callHex + "00") as Hex }));
    expect([s.verification, s.code]).toEqual(["unknown", "effect_unproven"]);
  });
  it("missing ExtrinsicSuccess: not verified (receipt: tx_failed; verifier alone: unknown no_trace)", () => {
    const ev = events(CALL).filter((e) => e.name !== "ExtrinsicSuccess");
    expect(step(CALL, undefined, outcome(CALL, { events: ev })).code).toBe("tx_failed");
    const v = verifyReviveCallV3Outcome(
      { status: "finalized", events: ev, callHex: callHex as Hex, runtime: V3 },
      { ...CALL.plan.steps[0].decodedArgs, palletIndex: 80, callIndex: 1 },
    );
    expect([v.verification, v.code]).toEqual(["unknown", "no_trace"]);
  });
  it("failed dispatch: tx_failed", () => {
    const ev: ChainEvent[] = [{ pallet: "System", name: "ExtrinsicFailed", args: ["{}"] }];
    const s = step(CALL, undefined, outcome(CALL, { status: "failed", events: ev }));
    expect([s.verification, s.code]).toEqual(["not_verified", "tx_failed"]);
  });
  it("wrong emitter, wrong data or wrong topics: not_verified effect_mismatch", () => {
    const other = events(CALL).map((e) =>
      e.name === "ContractEmitted"
        ? { ...e, args: ["0x" + "22".repeat(20), ...e.args.slice(1)] }
        : e,
    );
    expect(step(CALL, { call: { emittedData: "0x" } }, outcome(CALL, { events: other })).code).toBe(
      "effect_mismatch",
    );
    expect(step(CALL, { call: { emittedData: "0xabcd" } }).code).toBe("effect_mismatch");
    expect(
      step(CALL, { call: { emittedData: "0x", emittedTopics: [("0x" + "33".repeat(32)) as Hex] } })
        .code,
    ).toBe("effect_mismatch");
  });
  it("explicit verdict wins; a forged verified one is downgraded", () => {
    const forged: OutcomeVerdict = {
      verification: "verified",
      coverage: "effect_proven",
      reason: "forged",
      matchedEvent: `Revive.ContractEmitted(${DEST}, 0xff, [])`,
    };
    const s = buildReceipt({
      plan: CALL.plan as Plan,
      outcomes: [outcome(CALL)],
      runtime: V3,
      verdicts: { call: forged },
    }).steps[0]!;
    expect(s.verification).toBe("unknown");
  });
});
