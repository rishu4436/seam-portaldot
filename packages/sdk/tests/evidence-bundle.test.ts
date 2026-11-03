import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { prepareEvidenceBundle, inspectEvidenceBundle } from "../src/index.js";
const recording = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../../evidence/testnet-v3/runs/plan-sequential-1792411270138.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
it("imports a real public testnet SDK recording and verifies its portable integrity", () => {
  const source = recording();
  const bundle = prepareEvidenceBundle(source);
  expect(bundle.bundleVersion).toBe(1);
  expect(bundle.plan.steps.length).toBeGreaterThan(0);
  expect(inspectEvidenceBundle(bundle).status).toBe("integrity_checked");
  expect(JSON.stringify(bundle)).not.toMatch(/metadataHex|signedExtrinsic|privateKey/);
});
it("rejects tampered intent even if a receipt still claims a verified result", () => {
  const bundle = prepareEvidenceBundle(recording());
  bundle.plan.steps[0].encodedCall = "0x010203";
  expect(inspectEvidenceBundle(bundle).status).toBe("failed");
});
it("rejects access keys, raw signed bytes and deeply nested hostile records", () => {
  const source = prepareEvidenceBundle(recording());
  Object.assign(source.receipt, { secret: "secret" });
  expect(() => prepareEvidenceBundle(source)).toThrow(/secret-bearing/);
  const key = prepareEvidenceBundle(recording());
  Object.assign(key.receipt, { note: "seam_key_example" });
  expect(() => prepareEvidenceBundle(key)).toThrow(/Access keys/);
  expect(() => prepareEvidenceBundle({ receiptVersion: 1, plan: { steps: [1] } })).toThrow();
});
