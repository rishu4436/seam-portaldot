import { describe, expect, it } from "vitest";
import { atomicitySource, policyLimitGroups, pallets } from "../limits";

const proof = { genesisHash: "0xg", metadataHash: "0xm", specVersion: 5, txHash: "0xt" };
describe("atomicity proof source", () => {
  it("is not proven without a proof object, even when a verdict says verified", () => {
    const r = atomicitySource({ batchAllRollback: "verified" });
    expect(r.status).toBe("not_proven");
    expect(r.detail).toMatch(/not shown as proven/);
    expect(atomicitySource(undefined).status).toBe("not_proven");
  });
  it("is verified only with genesis, metadataHash, specVersion and a tx or block hash", () => {
    expect(atomicitySource({ batchAllRollbackProof: proof }).status).toBe("atomic_verified");
    expect(
      atomicitySource({ batchAllRollbackProof: { ...proof, txHash: undefined, blockHash: "0xb" } })
        .status,
    ).toBe("atomic_verified");
    for (const k of ["genesisHash", "metadataHash", "specVersion", "txHash"] as const) {
      const p = { ...proof, [k]: undefined };
      const r = atomicitySource({ batchAllRollbackProof: p });
      expect(r.status).toBe("not_proven");
      expect(r.missing.length).toBe(1);
    }
  });
});
describe("policy limits", () => {
  it("shows nothing when no policy is provided", () =>
    expect(policyLimitGroups(undefined)).toBeUndefined());
  it("shows given values and marks unset ones, never inventing", () => {
    const g = policyLimitGroups({
      allowedCapabilities: ["Assets.transfer_keep_alive", "Contracts.call"],
      allowedAssets: ["1"],
      maxFee: "100",
      maxAmountPerAsset: { "*": "5" },
      allowUnknown: { dryRun: true },
    })!;
    const all = Object.fromEntries(g.flatMap((x) => x.rows).map((r) => [r.key, r]));
    expect(all.pallets.value).toBe("Assets, Contracts");
    expect(all.maxFee.value).toBe("100");
    expect(all.maxWeight.set).toBe(false);
    expect(all.maxWeight.value).toBe("not set");
    expect(all.allowedAssets.value).toBe("1");
    expect(all.allowUnknown.value).toBe("dryRun");
    expect(all.maxAmountPerAsset.value).toContain("any other asset: 5");
  });
  it("handles the 'any' allow-list", () => {
    const g = policyLimitGroups({ allowedCapabilities: "any" })!.flatMap((x) => x.rows);
    expect(g.find((r) => r.key === "pallets")!.value).toBe("any");
  });
  it("derives pallets", () => expect(pallets(["A.x", "A.y", "B.z"])).toEqual(["A", "B"]));
});
