import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  compile,
  computeManifestDigest,
  computePlanDigest,
  type Manifest,
} from "../src/index.js";
import { demoManifest, realFacts, withRollback } from "./helpers.js";

function reverseKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(reverseKeys) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .reverse()
        .map((k) => [k, reverseKeys((v as any)[k])]),
    ) as T;
  }
  return v;
}

describe("canonical JSON", () => {
  it("sorts keys and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: [true, null] } })).toBe(
      '{"a":{"c":[true,null],"d":"x"},"b":1}',
    );
  });
  it("refuses floats and non-safe integers", () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow(/not a safe integer/);
    expect(() => canonicalJson({ a: 2 ** 60 })).toThrow(/not a safe integer/);
  });
});

describe("determinism", () => {
  const facts = realFacts();

  it("same manifest + facts -> byte-identical plan, across runs and fresh facts objects", () => {
    const a = compile(demoManifest(), facts);
    const b = compile(demoManifest(), realFacts());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(computePlanDigest(a)).toBe(a.planDigest);
  });

  it("key order in the manifest does not change any digest", () => {
    const m = demoManifest();
    const r = reverseKeys(m);
    expect(JSON.stringify(r)).not.toBe(JSON.stringify(m));
    expect(computeManifestDigest(r)).toBe(computeManifestDigest(m));
    expect(compile(r, facts).planDigest).toBe(compile(m, facts).planDigest);
  });

  it("key order in the facts does not change the plan", () => {
    const shuffled = reverseKeys(facts);
    expect(compile(demoManifest(), shuffled).planDigest).toBe(
      compile(demoManifest(), facts).planDigest,
    );
  });

  it("any change to the manifest changes manifestDigest and planDigest", () => {
    const m = demoManifest();
    const m2: Manifest = JSON.parse(JSON.stringify(m));
    (m2.actions[0]!.args as any).amount = "2500000000000001";
    expect(computeManifestDigest(m2)).not.toBe(computeManifestDigest(m));
    expect(compile(m2, facts).planDigest).not.toBe(compile(m, facts).planDigest);
  });

  it("action order matters (it is the execution order)", () => {
    const m = demoManifest();
    const swapped = { ...m, actions: [m.actions[1]!, m.actions[0]!, m.actions[2]!] };
    expect(compile(swapped, facts).planDigest).not.toBe(compile(m, facts).planDigest);
  });

  it("a tampered plan no longer matches its digest", () => {
    const p = compile(demoManifest(), facts);
    const t = JSON.parse(JSON.stringify(p));
    t.steps[0].decodedArgs.amount = "1";
    expect(computePlanDigest(t)).not.toBe(p.planDigest);
  });

  it("plan carries no signing-envelope or preflight data", () => {
    const p = compile(demoManifest(), withRollback(facts, "verified"));
    const forbidden = [
      "nonce",
      "era",
      "mortality",
      "expiry",
      "tip",
      "fee",
      "partialFee",
      "weight",
      "blockHash",
      "blockNumber",
      "endpoint",
    ];
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
    };
    walk(p);
    for (const f of forbidden) expect(keys, f).not.toContain(f);
  });

  it("informational facts (endpoint, blockNumber) do not affect the plan", () => {
    const other = realFacts({ endpoint: "wss://elsewhere.example", blockNumber: 1 });
    expect(compile(demoManifest(), other).planDigest).toBe(
      compile(demoManifest(), facts).planDigest,
    );
  });

  it("golden digests for the demo manifest on spec 1002 (update only on intentional format changes)", () => {
    const p = compile(demoManifest(), facts);
    expect({
      manifestDigest: p.manifestDigest,
      fingerprintDigest: p.fingerprintDigest,
      planDigest: p.planDigest,
    }).toMatchInlineSnapshot(`
      {
        "fingerprintDigest": "0xfa84b636f16022d59470133e37c4130e936421a85d272363fb394b1116eba896",
        "manifestDigest": "0xb7ceb459813eca8496cc9ea090b879a13a175dbbc09eea0b147ad76e445edd25",
        "planDigest": "0xe5ba74c5848c8997c65ef336e3463a4bb27d187e51ca6e952139d90d26778aab",
      }
    `);
  });
});
