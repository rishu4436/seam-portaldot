/* eslint-disable @typescript-eslint/no-explicit-any -- walks raw fixture JSON */
// REAL V3 spec 3002 LAYOUT FIXTURE (tests/fixtures/v3-testnet-spec3002-layouts.json, copied from Chainsmith's
// packages/chain fixture, decoded from the real V3 node's metadata). These tests compare the compiler's expected
// argument shape with those real layouts. They prove NOTHING about execution, account mapping, atomicity or
// rollback on V3: no call was ever run against the chain by this suite.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, type Manifest, type PlanStep } from "../src/index.js";
import { checkV3Shape } from "../src/v3-bindings.js";
import { ALICE, BOB, H160 } from "./helpers.js";
import { syntheticFacts } from "./synthetic-v3.js";

const layouts = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/v3-testnet-spec3002-layouts.json", import.meta.url)),
    "utf8",
  ),
).calls;

/** Approximates toRawType() for the layout nodes the fixture uses. */
function raw(t: any): string {
  switch (t.kind) {
    case "primitive":
      return String(t.primitive).toLowerCase();
    case "compact":
      return `Compact<${raw(t.of)}>`;
    case "sequence":
      return t.of.primitive === "U8" ? "Bytes" : `Vec<${raw(t.of)}>`;
    case "array":
      return `[${raw(t.of)};${t.len}]`;
    case "composite":
      if (/H160$/.test(t.path ?? "")) return "H160";
      if (/AccountId32$/.test(t.path ?? "")) return "AccountId32";
      return JSON.stringify(
        Object.fromEntries(t.fields.map((f: any) => [camel(f.name), raw(f.type)])),
      );
    case "variant":
      if (t.path === "Option") return `Option<${raw(t.variants[1].fields[0].type)}>`;
      if (/MultiAddress$/.test(t.path ?? "")) return '{"Id":"AccountId"}';
      return "Enum";
  }
  throw new Error(`unhandled ${t.kind}`);
}
const camel = (s: string) => s.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
const argsOf = (call: string, mutate?: (a: any[]) => void) => {
  const a = layouts[call].fields.map((f: any) => {
    const rawType = raw(f.type);
    return { name: camel(f.name), rawType, isWeightV2: /"refTime"/.test(rawType) };
  });
  mutate?.(a);
  return a;
};
const cap = { argTypesConfidence: "full" } as any;

describe("REAL V3 spec 3002 layout fixture vs the compiler's expected shape (no execution verified)", () => {
  it("fixture carries the indices Chainsmith recorded", () => {
    expect(layouts["Revive.call"]).toMatchObject({ palletIndex: 80, callIndex: 1 });
    expect(layouts["Nfts.mint"]).toMatchObject({ palletIndex: 47, callIndex: 3 });
  });
  it("Revive.call (80/1) matches the shape contract, with weight_limit accepted as gasLimit", () => {
    const a = argsOf("Revive.call");
    expect(a.map((x: any) => x.name)).toEqual([
      "dest",
      "value",
      "weightLimit",
      "storageDepositLimit",
      "data",
    ]);
    expect(a[3].rawType).toBe("Compact<u128>"); // not an Option
    expect(checkV3Shape("revive.call", cap, 14, a)).toBeUndefined();
  });
  it("Nfts.mint (47/3) matches the shape contract", () => {
    expect(checkV3Shape("nfts.mint", cap, 14, argsOf("Nfts.mint"))).toBeUndefined();
  });
  it("wrong types on the real layout are still refused", () => {
    const bad = (i: number, rawType: string) =>
      checkV3Shape(
        "revive.call",
        cap,
        14,
        argsOf("Revive.call", (a) => (a[i].rawType = rawType)),
      );
    expect(bad(0, "AccountId32")).toMatch(/dest/);
    expect(bad(1, "Bytes")).toMatch(/value/);
    expect(bad(3, "Bytes")).toMatch(/storageDepositLimit/);
    expect(bad(4, "u32")).toMatch(/data/);
    const w = argsOf("Revive.call", (a) => {
      a[2].rawType = "Bytes";
      a[2].isWeightV2 = false;
    });
    expect(checkV3Shape("revive.call", cap, 14, w)).toMatch(/weightLimit/);
  });
});

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
const step = (m: Manifest, o: Parameters<typeof syntheticFacts>[0]): PlanStep =>
  compile(m, syntheticFacts(o)).steps[0]!;
const real = {
  reviveDest: "h160",
  reviveWeightName: "weight_limit",
  reviveStorage: "compact",
} as const;

// SYNTHETIC metadata shaped like the real layout (not real V3 metadata).
describe("SYNTHETIC metadata shaped like V3: weight_limit alias and non-Option storage_deposit_limit", () => {
  it("compiles with weight_limit + Compact<u128> storage_deposit_limit and encodes the compact value", () => {
    const s = step(revive(), real);
    expect(s.status).toBe("ok");
    const enc = s.encodedCall!.toLowerCase();
    // ...storage_deposit_limit Compact(100)=0x9101, then data Bytes 0x08 1234 at the tail
    expect(enc.endsWith("91010812" + "34")).toBe(true);
  });
  it("alias and gasLimit-named metadata produce the same weight bytes (Weight v2 still needs proofSize)", () => {
    const a = step(revive(), { reviveDest: "h160", reviveWeightName: "weight_limit" });
    const b = step(revive(), { reviveDest: "h160" });
    expect(a.status).toBe("ok");
    expect(a.encodedCall).toBe(b.encodedCall);
    const noProof = manifest("revive.call", {
      contract: H160,
      value: "0",
      data: "0x",
      gasLimit: "1",
      storageDepositLimit: "1",
    });
    expect(step(noProof, real).status).toBe("unavailable");
  });
  it("Option storage_deposit_limit still accepts a value and null (None)", () => {
    const o = { reviveDest: "h160", reviveStorage: "option" } as const;
    expect(step(revive(), o).status).toBe("ok");
    expect(step(revive({ storageDepositLimit: null }), o).status).toBe("ok");
  });
  it("non-Option storage_deposit_limit: null is refused (fail closed, never coerced to 0 / no limit)", () => {
    expect(() => compile(revive({ storageDepositLimit: null }), syntheticFacts(real))).toThrow(
      /not optional|null/,
    );
  });
  it("non-Option storage_deposit_limit: omitted is unavailable (never defaulted)", () => {
    const m = manifest("revive.call", {
      contract: H160,
      value: "0",
      data: "0x",
      gasLimit: "1",
      proofSize: "1",
    });
    const s = step(m, real);
    expect(s.status).toBe("unavailable");
    expect(s.reason).toMatch(/storageDepositLimit/);
  });
  it("non-Option storage_deposit_limit: out-of-range u128 is rejected", () => {
    expect(() =>
      compile(revive({ storageDepositLimit: (1n << 128n).toString() }), syntheticFacts(real)),
    ).toThrow();
  });
  it("wrong storage_deposit_limit type is V3_ARG_SHAPE_MISMATCH even with the alias", () => {
    const s = step(revive(), { ...real, reviveStorage: "wrongType" });
    expect(s).toMatchObject({ status: "unavailable", reasonCode: "V3_ARG_SHAPE_MISMATCH" });
  });
  it("an unknown weight name is still refused", () => {
    const s = step(revive(), { reviveDest: "h160", reviveWeightName: "ref_limit" });
    expect(s.reasonCode).toBe("V3_ARG_SHAPE_MISMATCH");
  });
  it("nfts.mint recipient still compiles", () => {
    const s = step(manifest("nfts.mint", { collection: "1", item: "7", recipient: BOB }), {
      nfts: true,
    });
    expect(s.status).toBe("ok");
  });
});
