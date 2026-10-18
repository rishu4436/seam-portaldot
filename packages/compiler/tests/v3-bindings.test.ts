import { describe, expect, it } from "vitest";
import { compile, type Manifest, type PlanStep } from "../src/index.js";
import { ALICE, BOB, H160, realFacts } from "./helpers.js";
import { devHex, devSnap, syntheticFacts } from "./synthetic-v3.js";
import { factsFromMetadata } from "../src/index.js";

// Everything below that is positive uses SYNTHETIC metadata (see synthetic-v3.ts): not real Portaldot V3.

const manifest = (kind: "revive.call" | "nfts.mint", args: Record<string, unknown>): Manifest => ({
  version: 1,
  signer: { type: "ss58", value: ALICE },
  actions: [{ id: "a", kind, args }],
});
const revive = (extra: Record<string, unknown> = {}) =>
  manifest("revive.call", {
    contract: H160,
    value: "0",
    data: "0x1234",
    gasLimit: "5000000000",
    proofSize: "1000000",
    storageDepositLimit: "100",
    ...extra,
  });
const nft = manifest("nfts.mint", { collection: "1", item: "7", recipient: BOB });
const step = (m: Manifest, f: Parameters<typeof compile>[1]): PlanStep => compile(m, f).steps[0]!;

describe("without a V3 metadata snapshot (unchanged behaviour)", () => {
  const facts = realFacts();
  it.each([revive(), nft])(
    "stays unavailable with NO_OBSERVED_V3_METADATA on the Portaldot mainnet capture",
    (m) => {
      const s = step(m, facts);
      expect(s).toMatchObject({
        status: "unavailable",
        reasonCode: "NO_OBSERVED_V3_METADATA",
        encodedCall: null,
        palletIndex: null,
      });
    },
  );
  it("Nfts.mint is not_observed on the dev node, so it also stays NO_OBSERVED_V3_METADATA", () => {
    const f = factsFromMetadata({
      metadataHex: devHex,
      genesisHash: devSnap.genesis,
      tokenSymbol: "UNIT",
      tokenDecimals: 12,
    });
    expect(step(nft, f).reasonCode).toBe("NO_OBSERVED_V3_METADATA");
  });
});

describe("real dev-node Revive.call (older upstream layout, not V3): refused", () => {
  it("dest is MultiAddress, not H160 -> V3_ARG_SHAPE_MISMATCH, no call produced", () => {
    const f = factsFromMetadata({
      metadataHex: devHex,
      genesisHash: devSnap.genesis,
      tokenSymbol: "UNIT",
      tokenDecimals: 12,
    });
    const s = step(revive(), f);
    expect(s).toMatchObject({
      status: "unavailable",
      reasonCode: "V3_ARG_SHAPE_MISMATCH",
      encodedCall: null,
    });
    expect(s.reason).toMatch(/dest/);
  });
});

describe("SYNTHETIC metadata: revive.call", () => {
  const facts = syntheticFacts({ reviveDest: "h160" });
  it("compiles when the argument shape matches, with indices taken from metadata", () => {
    const s = step(revive(), facts);
    expect(s.status).toBe("ok");
    expect(s.reasonCode).toBeUndefined();
    expect(s).toMatchObject({ palletIndex: 9, callIndex: 0 });
    expect(s.encodedCall).toMatch(/^0x0900/);
    expect(s.encodedCall!.toLowerCase()).toContain("1".repeat(40));
  });
  it("is deterministic", () => {
    expect(compile(revive(), facts).planDigest).toBe(compile(revive(), facts).planDigest);
  });
  it("needs proofSize for a Weight v2 gas_limit (unavailable, not guessed)", () => {
    const m = manifest("revive.call", {
      contract: H160,
      value: "0",
      data: "0x",
      gasLimit: "1",
      storageDepositLimit: "1",
    });
    const s = step(m, facts);
    expect(s.status).toBe("unavailable");
    expect(s.reason).toMatch(/proofSize/);
  });
  it("a missing manifest gasLimit is unavailable, not defaulted", () => {
    const m = manifest("revive.call", { contract: H160, value: "0", data: "0x" });
    expect(step(m, facts).status).toBe("unavailable");
  });
  it("rejects a value that does not fit the metadata type", () => {
    expect(() => compile(revive({ value: (1n << 128n).toString() }), facts)).toThrow(
      /exceeds u128|does not fit/,
    );
  });
  it.each([
    ["dest stays MultiAddress", { reviveDest: "multiaddress" as const }],
    ["argument dropped", { reviveDest: "h160" as const, reviveDrop: "storage_deposit_limit" }],
    ["arguments reordered", { reviveDest: "h160" as const, reviveSwap: true }],
    ["extra argument added", { reviveDest: "h160" as const, reviveExtra: true }],
  ])("%s -> V3_ARG_SHAPE_MISMATCH", (_n, o) => {
    const s = step(revive(), syntheticFacts(o));
    expect(s).toMatchObject({
      status: "unavailable",
      reasonCode: "V3_ARG_SHAPE_MISMATCH",
      encodedCall: null,
    });
  });
  it("an unavailable step makes the plan unavailable-or-sequential without any encoded call for it", () => {
    const plan = compile(revive(), syntheticFacts({ reviveDest: "multiaddress" }));
    expect(plan.steps.every((s) => s.encodedCall === null)).toBe(true);
  });
});

describe("SYNTHETIC metadata: nfts.mint", () => {
  it("compiles when collection/item/mint_to/witness_data match (witness always None)", () => {
    const s = step(nft, syntheticFacts({ nfts: true }));
    expect(s.status).toBe("ok");
    expect(s).toMatchObject({ palletIndex: 40, callIndex: 15 });
    expect(s.encodedCall!.startsWith("0x280f")).toBe(true);
    expect(s.encodedCall!.endsWith("00")).toBe(true); // Option::None
  });
  it("refuses a witness_data that is not an Option", () => {
    expect(step(nft, syntheticFacts({ nfts: true, nftsWitness: "u32" })).reasonCode).toBe(
      "V3_ARG_SHAPE_MISMATCH",
    );
  });
  it("refuses a mint_to that is not an account", () => {
    expect(step(nft, syntheticFacts({ nfts: true, nftsMintTo: "u128" })).reasonCode).toBe(
      "V3_ARG_SHAPE_MISMATCH",
    );
  });
});

describe("compatibility", () => {
  it("facts without Nfts/Revive shape changes leave plans for existing kinds untouched", () => {
    const f = realFacts();
    const m: Manifest = {
      version: 1,
      signer: { type: "ss58", value: ALICE },
      actions: [
        { id: "t", kind: "assets.transfer", args: { assetId: "1", amount: "5", recipient: BOB } },
      ],
    };
    expect(compile(m, f).steps[0]!.status).toBe("ok");
  });
});
