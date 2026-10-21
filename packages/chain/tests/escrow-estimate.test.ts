import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  codeDepositUpperBound,
  deployBudgetFit,
  isPolkaVmBlob,
  reviveCodeHash,
} from "../src/escrow-estimate.js";

const art = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../../../contracts/escrow/artifacts/${f}`, import.meta.url)));
const info = JSON.parse(art("build-info.json").toString("utf8"));

describe("escrow estimate helpers", () => {
  it("code hash is keccak256 of the uploaded bytes, matching build-info", () => {
    expect(reviveCodeHash(art("SeamEscrow.pvm"))).toBe(info.pvm.codeHash);
    expect(reviveCodeHash(art("SeamEscrow.evm"))).toBe(info.evm.initCodeHash);
    expect(() => reviveCodeHash("0x")).toThrow();
  });
  it("recognises the PolkaVM magic only on the resolc blob", () => {
    expect(isPolkaVmBlob(art("SeamEscrow.pvm"))).toBe(true);
    expect(isPolkaVmBlob(art("SeamEscrow.evm"))).toBe(false);
    expect(isPolkaVmBlob("0x5056")).toBe(false);
    expect(art("SeamEscrow.pvm").length).toBe(info.pvm.bytes);
  });
  it("code deposit upper bound uses the V3 constants", () => {
    // V3 spec 3002: depositPerByte 6e12, depositPerItem 15e12 planck
    expect(codeDepositUpperBound(11544, 6_000_000_000_000n, 15_000_000_000_000n)).toBe(
      69_279_000_000_000_000n,
    );
    expect(() => codeDepositUpperBound(-1, 1n, 1n)).toThrow();
  });
  it("budget fit: totals fee + deposits, flags over-budget and origin shortfall", () => {
    const f = deployBudgetFit({ fee: 2n, storageDeposit: 10n }, 11n, 16n, 5n);
    expect(f).toMatchObject({ total: 12n, fits: false, margin: -1n, originCovers: false });
    const g = deployBudgetFit(
      { fee: 2n, storageDeposit: 3n, mappingFee: 1n, mappingDeposit: 1n },
      10n,
      20n,
      5n,
    );
    expect(g).toMatchObject({ total: 7n, fits: true, margin: 3n, originCovers: true });
    expect(() => deployBudgetFit({ fee: -1n, storageDeposit: 0n }, 1n)).toThrow();
  });
});
