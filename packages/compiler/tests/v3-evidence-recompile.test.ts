// Recompiles the manifests from the real funded V3 runs (evidence/testnet-v3/runs) against the committed real
// spec 3002 metadata blob (evidence/v3-discovery). Offline: nothing is sent. The run records omit their own
// metadata bytes, so this uses a blob read a day earlier, which differs only in a storage default value.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, factsFromMetadata, type Manifest, type RuntimeFacts } from "../src/index.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const metadataHex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const runsDir = root("evidence/testnet-v3/runs");
const runs = readdirSync(runsDir)
  .filter((f) => f.startsWith("plan-") && f.endsWith(".json"))
  .map((f) => ({ f, d: JSON.parse(readFileSync(`${runsDir}/${f}`, "utf8")) }))
  .filter(({ d }) => d.manifest && d.facts && d.plan);

function factsFor(rec: { facts: RuntimeFacts }, extra: object = {}): RuntimeFacts {
  const fp = rec.facts.fingerprint;
  return factsFromMetadata({
    metadataHex,
    genesisHash: fp.genesisHash,
    tokenSymbol: fp.tokenSymbol,
    tokenDecimals: fp.tokenDecimals,
    ...extra,
  });
}

describe("real V3 run manifests recompile byte for byte on spec 3002 metadata", () => {
  it("finds the recorded runs", () => expect(runs.length).toBeGreaterThanOrEqual(5));

  for (const { f, d } of runs) {
    it(f, () => {
      const plan = compile(d.manifest as Manifest, factsFor(d));
      expect(plan.mode).not.toBe("unavailable");
      expect(plan.steps.every((s) => s.status === "ok" && !s.reasonCode)).toBe(true);
      expect(plan.steps.map((s) => s.encodedCall)).toEqual(
        d.plan.steps.map((s: { encodedCall: string }) => s.encodedCall),
      );
    });
  }

  it("revive.call: weight_limit and storage_deposit_limit come from the manifest", () => {
    const { d } = runs.find(({ f }) => f.startsWith("plan-revive-call"))!;
    const step = compile(d.manifest as Manifest, factsFor(d)).steps[0]!;
    expect(step.decodedArgs).toMatchObject({
      gasLimit: "5000000000",
      proofSize: "200000",
      storageDepositLimit: "10000000000000",
    });
  });

  // Without a layout hash the proof keeps the strict raw-hash binding, so it is rejected against any other blob.
  it("atomic: a proof without metadataLayoutHash from another raw metadata blob is rejected (strict)", () => {
    const { d } = runs.find(({ f }) => f.startsWith("plan-atomic"))!;
    const proof = d.facts.behaviour.batchAllRollbackProof;
    expect(proof.metadataLayoutHash).toBeUndefined();
    const plan = compile(
      d.manifest as Manifest,
      factsFor(d, { batchAllRollback: "verified", batchAllRollbackProof: proof }),
    );
    expect(d.compiledMode).toBe("atomic_verified");
    expect(plan.mode).toBe("sequential");
    expect(plan.modeReason).toMatch(/rollback proof is rejected: metadataHash/);
  });
});
