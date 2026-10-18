import { describe, expect, it } from "vitest";
import { finalityView } from "../finality";
import { radioNext, isEscape } from "../a11y";

type In = Parameters<typeof finalityView>[0];
const o = (txState: In["txState"], extra: Partial<In> = {}): In => ({ txState, txHash: undefined, provenance: "unknown", submitted: false, ...extra });
describe("finality view", () => {
  it("wallet rejection: nothing sent, retry allowed", () => {
    const v = finalityView(o("rejected")); expect(v.key).toBe("rejected"); expect(v.canRetry).toBe(true); expect(v.message).toMatch(/Nothing was sent/); expect(v.message).toMatch(/not consumed/);
  });
  it("uncertain says outcome unknown, reconcile, and blocks retry", () => {
    const v = finalityView(o("uncertain", { submitted: true })); expect(v.message).toBe("Outcome unknown, reconcile before retrying."); expect(v.canRetry).toBe(false); expect(v.reconcileFirst).toBe(true);
  });
  it("finalized without a tx hash is not trusted", () => expect(finalityView(o("finalized")).key).toBe("uncertain"));
  it("finalized with hash but no chain provenance is not 'verified'", () => {
    const v = finalityView(o("finalized", { txHash: "0xabc" })); expect(v.key).toBe("finalized"); expect(v.label).toBe("Finalized, not verified"); expect(v.tone).not.toBe("ok");
  });
  it("verified needs chain_verified", () => expect(finalityView(o("finalized", { txHash: "0xabc", provenance: "chain_verified" }), { blockNumber: 7 }).label).toBe("Finalized and verified"));
  it("submitted and included are not final and keep hash/block only when known", () => {
    const s = finalityView(o("submitted", { txHash: "0x1" })); expect(s.key).toBe("submitted"); expect(s.blockNumber).toBeUndefined();
    const i = finalityView(o("included", { txHash: "0x1" }), { blockNumber: 3, blockHash: "0xb" }); expect(i.blockNumber).toBe(3); expect(i.label).toMatch(/not final/);
  });
  it("failed after submit needs reconcile", () => expect(finalityView(o("failed", { txHash: "0x1", submitted: true })).canRetry).toBe(false));
  it("not_run is none", () => expect(finalityView(o("not_run")).key).toBe("none"));
});
describe("keyboard helpers", () => {
  it("roving radio keys wrap", () => {
    expect(radioNext("ArrowDown", 2, 3)).toBe(0); expect(radioNext("ArrowUp", 0, 3)).toBe(2); expect(radioNext("Home", 2, 3)).toBe(0); expect(radioNext("End", 0, 3)).toBe(2); expect(radioNext("a", 0, 3)).toBeUndefined();
  });
  it("escape", () => { expect(isEscape("Escape")).toBe(true); expect(isEscape("Enter")).toBe(false); });
});
