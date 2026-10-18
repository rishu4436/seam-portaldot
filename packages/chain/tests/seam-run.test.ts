import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helpers
import { isWeightV2, makeGuard, assertNotMainnetUrl } from "../scripts/seam-run.mjs";

describe("seam-run helpers", () => {
  it("tells the V13 single Weight from the V14 Weight V2 shape", () => {
    expect(isWeightV2("Compact<Weight>")).toBe(false);
    expect(isWeightV2("SpWeightsWeightV2Weight")).toBe(true);
    expect(isWeightV2(undefined)).toBe(false);
  });
  it("the evidence guard refuses signatures, keys, dev paths and the signer secret itself", () => {
    const g = makeGuard(["correct horse battery staple"]);
    expect(g({ ok: true, txHash: "0x01" })).toContain("txHash");
    expect(() => g({ signature: "0x00" })).toThrow(/signature/);
    expect(() => g({ a: { seed: "x" } })).toThrow(/seed/);
    expect(() => g({ note: "derived from //Alice" })).toThrow(/dev derivation/);
    expect(() => g({ note: "phrase correct horse battery staple here" })).toThrow(/secret/);
  });
  it("refuses the mainnet endpoint", () => {
    expect(() => assertNotMainnetUrl("wss://mainnet.portaldot.io")).toThrow(/mainnet/);
    expect(() => assertNotMainnetUrl("ws://127.0.0.1:9966")).not.toThrow();
  });
});
