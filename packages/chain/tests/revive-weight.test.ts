import { describe, expect, it } from "vitest";
import {
  decodeWeightV2Prefix,
  reviveWeightBound,
  staticProofOverhead,
} from "../src/revive-weight.js";

// Raw prefix of the real ReviveApi_instantiate answer for SeamEscrowOne-r1 on V3 spec 3002
// (evidence/testnet-v3/revive-proof-size-1793018489327.json): two compact Weights, proof_size byte 0x00.
const RAW = "0xca18460100ca184601000100e05384bffa140000000000000000000100";

describe("decodeWeightV2Prefix", () => {
  it("hand-decodes compact ref_time/proof_size the same as the metadata decoder", () => {
    const d = decodeWeightV2Prefix(RAW);
    expect(d.weightConsumed).toEqual({ refTime: "5342770", proofSize: "0" });
    expect(d.weightRequired).toEqual({ refTime: "5342770", proofSize: "0" });
    expect(d.bytesRead).toBe(10);
  });
  it("decodes every compact mode", () => {
    // 1-byte 0x04=1, 2-byte 0x1501=69, 4-byte, big-int 0x03 + 4 bytes (u32::MAX-ish)
    const d = decodeWeightV2Prefix("0x04" + "1501" + "feffffff" + "03ffffffff");
    expect(d.weightConsumed).toEqual({ refTime: "1", proofSize: "69" });
    expect(d.weightRequired).toEqual({ refTime: "1073741823", proofSize: "4294967295" });
  });
  it("throws on truncated input", () => {
    expect(() => decodeWeightV2Prefix("0xca18")).toThrow(/truncated/);
    expect(() => decodeWeightV2Prefix("0xzz")).toThrow(/hex/);
  });
});

describe("reviveWeightBound", () => {
  it("proof_size 0 is unknown, never a passed bound", () => {
    const b = reviveWeightBound({ weightRequired: { refTime: 5342770, proofSize: 0 } }, 0.2);
    expect(b.known).toBe(false);
    if (!b.known) {
      expect(b.refTime).toBe("6411324");
      expect(b.reason).toMatch(/unknown/);
    }
  });
  it("missing proof_size or ref_time is unknown", () => {
    expect(reviveWeightBound({ weightRequired: { refTime: "10" } }, 0).known).toBe(false);
    expect(reviveWeightBound({ weightRequired: null }, 0)).toMatchObject({
      known: false,
      refTime: null,
    });
  });
  it("applies the margin to both parts, rounding up", () => {
    expect(
      reviveWeightBound({ weightRequired: { refTime: "0x0a", proofSize: "3" } }, 0.25),
    ).toEqual({
      known: true,
      refTime: "13",
      proofSize: "4",
      marginPct: 25,
    });
  });
  it("rejects a bad margin", () => {
    expect(() => reviveWeightBound({ weightRequired: { refTime: 1, proofSize: 1 } }, -1)).toThrow();
  });
});

describe("staticProofOverhead", () => {
  it("is total minus the explicit cap (V3 #203373 measurement: 1006823 - 1000000)", () => {
    expect(staticProofOverhead("1006823", "1000000")).toBe(6823n);
    expect(staticProofOverhead(1006823, 1_000_000n)).toBe(6823n);
  });
  it("refuses a 0 cap: 0 is unknown, not a bound", () => {
    expect(() => staticProofOverhead(6823, 0)).toThrow(/non-zero/);
  });
  it("refuses a total below the cap", () => {
    expect(() => staticProofOverhead(999_999, 1_000_000)).toThrow(/below the cap/);
  });
});
