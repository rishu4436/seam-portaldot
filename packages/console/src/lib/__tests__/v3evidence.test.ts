import { describe, expect, it } from "vitest";
import { V3_EVIDENCE, rowViews, stepView } from "../v3evidence";

const rows = V3_EVIDENCE.rows;
const byId = (id: string) => rows.find((r) => r.id === id)!;

describe("V3 evidence view data", () => {
  it("lists the 18 finalized V3 txs plus the one not-sent dry run", () => {
    expect(rows).toHaveLength(19);
    const sent = rows.filter((r) => r.txHash && r.finalized);
    expect(sent).toHaveLength(18);
    for (const r of sent) {
      expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.block).toBeGreaterThan(102000);
      expect(r.explorer).toMatch(
        /^https:\/\/node-console\.portaldot\.dev\/#\/explorer\/query\/0x[0-9a-f]{64}$/,
      );
    }
    expect(byId("R4").receipt.kind).toBe("not_sent");
  });
  it("sequential and atomic receipts match what the recordings say", () => {
    expect(rowViews(byId("12"))[0]).toMatchObject({ actionId: "pay", tone: "ok" });
    // The later receipt (with the nfts verdict) is the one shown, and it is labelled.
    for (const id of ["12", "13", "15"]) {
      const r = byId(id).receipt;
      expect(r.kind === "receipt" && r.shown).toMatch(/nftVerdictReceipt/);
    }
    expect(rowViews(byId("13"))[0]).toMatchObject({ actionId: "nft", tone: "ok" });
    const atomic = rowViews(byId("15"));
    expect(atomic.map((v) => v.actionId)).toEqual(["mint", "nft"]);
    expect(atomic.every((v) => v.tone === "ok")).toBe(true);
    // Receipts keep their run's recorded fingerprint.
    const seq = byId("12").receipt;
    expect(seq.kind === "receipt" && seq.fingerprintDigest).toMatch(/^0xcc8d60/);
    const rc = byId("R2").receipt;
    expect(rc.kind === "receipt" && rc.fingerprintDigest).toMatch(/^0xba7b76/);
  });
  it("revive.call without an expected event is unknown, never proven", () => {
    for (const id of ["R2", "R3"]) {
      const v = rowViews(byId(id))[0];
      expect(v.tone).toBe("warn");
      expect(v.text).toMatch(/unknown/);
      expect(v.text).not.toMatch(/effect_proven/);
      expect(v.note).toMatch(/no expected event/);
    }
  });
  it("never shows effect_proven unless a recorded receipt step says so", () => {
    for (const r of rows) {
      const views = rowViews(r);
      if (r.receipt.kind !== "receipt") {
        expect(views.every((v) => v.tone !== "ok")).toBe(true);
        continue;
      }
      r.receipt.steps.forEach((s, i) => {
        if (views[i].text.includes("effect_proven")) expect(s.coverage).toBe("effect_proven");
        if (views[i].tone === "ok") expect(s.verification).toBe("verified");
      });
    }
  });
  it("rollback row shows the gate block, not success", () => {
    expect(rowViews(byId("14"))[0]).toMatchObject({ tone: "bad" });
  });
  it("a not_verified step is shown as a problem", () => {
    const v = stepView({
      actionId: "x",
      status: "finalized",
      verification: "not_verified",
      coverage: "extrinsic_finalized",
      code: null,
      withNftsVerdict: null,
    });
    expect(v.tone).toBe("bad");
  });
});
