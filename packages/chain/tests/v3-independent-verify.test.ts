import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script helpers, no type declarations
import {
  canon,
  classify,
  compareEvents,
  deltaMatches,
  planCallMatch,
  parseEventString,
  splitArgs,
} from "../scripts/v3-independent-lib.mjs";

const H = "0x" + "11".repeat(32);
const ok = {
  canonicalHash: H,
  recordedBlockHash: H,
  blockNumber: 100,
  finalizedNumber: 200,
  extrinsicIndex: 1,
  recordedIndex: 1,
  callMatch: true,
  signerMatch: true,
  dispatch: { ok: true },
  events: { match: true, differences: [] },
};

describe("v3 independent verification: classification", () => {
  it("verified when every independent check holds", () => {
    expect(classify(ok).outcome).toBe("verified");
  });
  it("rollback probe: an expected ExtrinsicFailed with the expected error is expected_dispatch_failure, not success", () => {
    const r = classify(
      { ...ok, dispatch: { ok: false, error: "assets.BalanceLow" } },
      { expectFailure: true, expectedError: "assets.BalanceLow" },
    );
    expect(r.outcome).toBe("expected_dispatch_failure");
  });
  it("expected failure but chain succeeded -> mismatch", () => {
    expect(classify(ok, { expectFailure: true, expectedError: "assets.BalanceLow" }).outcome).toBe(
      "mismatch",
    );
  });
  it("expected failure with a different module error -> mismatch", () => {
    const r = classify(
      { ...ok, dispatch: { ok: false, error: "assets.NoAccount" } },
      { expectFailure: true, expectedError: "assets.BalanceLow" },
    );
    expect(r.outcome).toBe("mismatch");
  });
  it("unexpected dispatch failure -> mismatch", () => {
    expect(classify({ ...ok, dispatch: { ok: false, error: "nfts.NoPermission" } }).outcome).toBe(
      "mismatch",
    );
  });
  it("non-canonical block hash -> mismatch", () => {
    expect(classify({ ...ok, canonicalHash: "0x" + "22".repeat(32) }).outcome).toBe("mismatch");
  });
  it("block above the finalized head -> mismatch", () => {
    expect(classify({ ...ok, blockNumber: 300 }).outcome).toBe("mismatch");
  });
  it("tx hash not in block -> mismatch", () => {
    expect(classify({ ...ok, extrinsicIndex: null }).outcome).toBe("mismatch");
  });
  it("call, signer, index or events differ -> mismatch", () => {
    expect(classify({ ...ok, callMatch: false }).outcome).toBe("mismatch");
    expect(classify({ ...ok, signerMatch: false }).outcome).toBe("mismatch");
    expect(classify({ ...ok, recordedIndex: 2 }).outcome).toBe("mismatch");
    expect(classify({ ...ok, events: { match: false, differences: ["x"] } }).outcome).toBe(
      "mismatch",
    );
  });
  it("pruned state or no dispatch event -> unverifiable, never verified", () => {
    expect(classify({ readError: "state pruned" }).outcome).toBe("unverifiable");
    expect(classify({ ...ok, dispatch: undefined }).outcome).toBe("unverifiable");
  });
});

describe("v3 independent verification: event comparison", () => {
  it("parses receipt event strings with JSON args", () => {
    const e = parseEventString(
      'System.ExtrinsicSuccess({"class":"Normal","weight":{"refTime":1,"proofSize":2}})',
    );
    expect(e).toEqual({
      pallet: "System",
      name: "ExtrinsicSuccess",
      args: ['{"class":"Normal","weight":{"refTime":1,"proofSize":2}}'],
    });
    expect(splitArgs("0, 2, [1, 2], 0x")).toEqual(["0", "2", "[1, 2]", "0x"]);
  });
  it("ss58 and hex public key compare equal; numbers and JSON key order normalise", () => {
    expect(canon("5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1")).toBe(
      "0x80270a11d7b2e2b8b2dfb1ca3a45ab3b3f2339613709108c72f04074a8048467",
    );
    expect(canon('{"b":1,"a":"Yes"}')).toEqual(canon({ a: "yes", b: "1" }));
  });
  it("empty bytes rendered as '' do not equal 0x (decoder must render Bytes as hex)", () => {
    const exp = [{ pallet: "Revive", name: "ContractEmitted", args: ["0xab", "0x", "[]"] }];
    expect(
      compareEvents(exp, [{ pallet: "Revive", name: "ContractEmitted", args: ["0xab", "0x", []] }])
        .match,
    ).toBe(true);
    expect(
      compareEvents(exp, [{ pallet: "Revive", name: "ContractEmitted", args: ["0xab", "", []] }])
        .match,
    ).toBe(false);
  });
  it("reports missing, extra, reordered and changed events", () => {
    const a = { pallet: "Assets", name: "Transferred", args: ["1", "2"] };
    const b = { pallet: "System", name: "ExtrinsicSuccess", args: [] };
    expect(compareEvents([a, b], [a]).differences[0]).toMatch(/missing on chain/);
    expect(compareEvents([a], [a, b]).differences[0]).toMatch(/unexpected/);
    expect(compareEvents([a, b], [b, a]).match).toBe(false);
    expect(compareEvents([a], [{ ...a, args: ["1", "3"] }]).differences[0]).toMatch(/args differ/);
  });
});

describe("v3 independent verification: plan call bytes and balance deltas", () => {
  const step = (h: string) => ({ encodedCall: h });
  it("single-step plan: call bytes must equal the step (case-insensitive)", () => {
    expect(planCallMatch({ steps: [step("0xAB01")] }, { callHex: "0xab01" }).match).toBe(true);
    expect(planCallMatch({ steps: [step("0xab01")] }, { callHex: "0xab02" }).match).toBe(false);
  });
  it("multi-step plan: batch inner calls must equal the steps in order", () => {
    const plan = { steps: [step("0x01"), step("0x02")] };
    expect(planCallMatch(plan, { callHex: "0xff", innerCallHexes: ["0x01", "0x02"] }).match).toBe(
      true,
    );
    expect(planCallMatch(plan, { callHex: "0xff", innerCallHexes: ["0x02", "0x01"] }).match).toBe(
      false,
    );
    expect(planCallMatch(plan, { callHex: "0xff" }).match).toBe(false);
  });
  it("a plan without encoded calls is not comparable (null), never a match", () => {
    expect(planCallMatch({ steps: [] }, { callHex: "0x01" }).match).toBeNull();
  });
  it("deltaMatches is exact", () => {
    expect(deltaMatches("5", "4", "-1")).toBe(true);
    expect(deltaMatches("100000000000000", "98529120200481", "-1470879799519")).toBe(true);
    expect(deltaMatches("5", "3", "-1")).toBe(false);
  });
});
