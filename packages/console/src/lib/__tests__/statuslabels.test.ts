// Status labels and the five proof rows: nothing shown stronger than it is.
import { describe, expect, it } from "vitest";
import { EVIDENCE_LABEL, PROOF_ROW_TITLE, proofRows } from "../statuslabels";

const ids = [
  "fee_estimate",
  "unsigned_sim",
  "signed_dry_run",
  "dispatch_result",
  "verified_effect",
];

describe("status labels", () => {
  it("has a label and meaning for all eight states", () => {
    for (const k of [
      "simulated",
      "recorded",
      "live",
      "finalized",
      "verified",
      "unknown",
      "failed",
      "uncertain",
    ]) {
      expect(EVIDENCE_LABEL[k as keyof typeof EVIDENCE_LABEL]).toBeTruthy();
      expect(EVIDENCE_LABEL[k as keyof typeof EVIDENCE_LABEL].meaning.length).toBeGreaterThan(5);
    }
  });
  it("five rows in order, all unknown with no outcome", () => {
    const r = proofRows(undefined, "live");
    expect(r.map((x) => x.id)).toEqual(ids);
    expect(r.map((x) => x.title)).toEqual(
      ids.map((i) => PROOF_ROW_TITLE[i as keyof typeof PROOF_ROW_TITLE]),
    );
    expect(r.every((x) => x.label === "unknown")).toBe(true);
  });
  it("a verified live run", () => {
    const r = proofRows(
      {
        fee: "100",
        simulation: "signed_dry_run",
        txState: "finalized",
        block: { number: 9, hash: "0x" },
        status: "verified",
        provenance: "chain_verified",
      },
      "live",
      { signedDryRun: "ok" },
    );
    expect(r.map((x) => x.label)).toEqual(["live", "live", "live", "finalized", "verified"]);
  });
  it("finalized is not verified: effect stays unknown", () => {
    const r = proofRows(
      { txState: "finalized", status: "unverified", provenance: "unknown" },
      "live",
    );
    expect(r[3]!.label).toBe("finalized");
    expect(r[4]!.label).toBe("unknown");
  });
  it("simulated and recorded are never called live, finalized or verified", () => {
    const o = {
      fee: "1",
      simulation: "signed_dry_run" as const,
      txState: "finalized" as const,
      status: "verified" as const,
      provenance: "chain_verified" as const,
    };
    for (const src of ["simulated", "recorded"] as const) {
      const labels = proofRows(o, src, { signedDryRun: "ok" }).map((x) => x.label);
      expect(labels.every((l) => l === src)).toBe(true);
    }
  });
  it("failed, uncertain and a blocked signed dry run", () => {
    expect(
      proofRows({ txState: "uncertain", status: "uncertain" }, "live")
        .slice(3)
        .map((x) => x.label),
    ).toEqual(["uncertain", "uncertain"]);
    expect(
      proofRows({ txState: "failed", status: "failed" }, "live")
        .slice(3)
        .map((x) => x.label),
    ).toEqual(["failed", "failed"]);
    expect(proofRows({ signingCode: "signed_dry_run_failed" }, "live")[2]!.label).toBe("failed");
    expect(proofRows({ txState: "rejected" }, "recorded")[3]!.label).toBe("failed");
  });
  it("proof sizes in the unsigned-sim row; unknown is never shown as 0", () => {
    const r = proofRows({ simulation: "contract_dry_run" }, "live", {
      proofSize: { dryRunProofSize: { value: "12998" }, callInfoProofSize: { unknown: true } },
    });
    expect(r[1]!.detail).toContain("Proof size: dry run 12998, call info unknown.");
    expect(r[1]!.detail).not.toMatch(/call info 0/);
    expect(proofRows(undefined, "live")[1]!.detail).not.toMatch(/Proof size/);
  });
});
