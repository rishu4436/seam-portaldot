// @seam/compiler/browser: the Manifest Builder entry. Offline, on the committed real V3 spec 3002 metadata.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "../src/browser.js";
import * as node from "../src/index.js";
import { ARG_SCHEMA } from "../src/compile.js";
import type { ActionKind, Manifest } from "../src/types.js";
import { syntheticFacts } from "./synthetic-v3.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const metadataHex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const demo = JSON.parse(
  readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
);
const v3 = () =>
  browser.factsFromMetadata({
    metadataHex,
    genesisHash: demo.manifest.chain.genesisHash,
    tokenSymbol: "tPOT",
    tokenDecimals: 14,
  });
const KINDS = Object.keys(browser.KIND_TO_CAPABILITY) as ActionKind[];

/** Walks the relative import graph of a source file and returns every bare/builtin specifier it reaches. */
function externalImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const ext = new Set<string>();
  const visit = (url: URL) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const src = readFileSync(url, "utf8");
    for (const m of src.matchAll(
      /(?:import|export)[^"';]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']/g,
    )) {
      const spec = (m[1] ?? m[2])!;
      if (spec.startsWith(".")) visit(new URL(spec.replace(/\.js$/, ".ts"), url));
      else ext.add(spec);
    }
  };
  visit(new URL(entry, import.meta.url));
  return ext;
}

describe("@seam/compiler/browser", () => {
  it("reaches no node builtins through any import", () => {
    const ext = [...externalImports("../src/browser.ts")];
    expect(
      ext.filter((s) => s.startsWith("node:") || ["fs", "path", "url", "crypto", "os"].includes(s)),
    ).toEqual([]);
    expect(ext.every((s) => s.startsWith("@polkadot/"))).toBe(true);
  });
  it("exposes the same function objects as the node entry", () => {
    expect(browser.compile).toBe(node.compile);
    expect(browser.computePlanDigest).toBe(node.computePlanDigest);
    expect(browser.factsFromMetadata).toBe(node.factsFromMetadata);
    expect(browser.supportedKinds).toBe(node.supportedKinds);
  });
  it("compiles the V3 demo manifest to the committed demo plan digest", () => {
    const plan = browser.compile(demo.manifest as Manifest, v3());
    expect(plan.manifestDigest).toBe(demo.plan.manifestDigest);
    expect(plan.steps[0]!.encodedCall).toBe(demo.plan.steps[0].encodedCall);
    expect(browser.computePlanDigest(plan)).toBe(
      node.computePlanDigest(node.compile(demo.manifest, v3())),
    );
  });
  it("binds the plan to whatever signer the builder passes in", () => {
    const other = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
    const plan = browser.compile(
      { ...demo.manifest, signer: { type: "ss58", value: other } },
      v3(),
    );
    expect(plan.signer.value).toBe(other);
    expect(browser.computePlanDigest(plan)).not.toBe(demo.plan.planDigest);
  });
});

describe("supportedKinds", () => {
  it("on real V3 spec 3002: lists every V3 kind with its metadata indices", () => {
    const byKind = Object.fromEntries(browser.supportedKinds(v3()).map((k) => [k.kind, k]));
    expect(byKind["assets.transfer"]).toMatchObject({ supported: true });
    expect(byKind["revive.call"]).toMatchObject({ supported: true, palletIndex: 80, callIndex: 1 });
    expect(byKind["revive.instantiate_with_code"]).toMatchObject({
      supported: true,
      palletIndex: 80,
      callIndex: 3,
    });
    expect(byKind["revive.map_account"]).toMatchObject({
      supported: true,
      palletIndex: 80,
      callIndex: 7,
    });
    expect(byKind["contracts.call"]).toMatchObject({
      supported: true,
      palletIndex: 21,
      callIndex: 6,
    });
    expect(byKind["nfts.mint"]).toMatchObject({ supported: true, palletIndex: 47, callIndex: 3 });
    for (const k of Object.values(byKind))
      if (!k.supported) expect(k.reason.length).toBeGreaterThan(0);
  });
  it("agrees with compile(): a kind it calls supported compiles ok", () => {
    const facts = v3();
    const transfer = browser.supportedKinds(facts).find((k) => k.kind === "assets.transfer")!;
    expect(transfer.supported).toBe(true);
    const plan = browser.compile(demo.manifest, facts);
    expect(plan.steps[0]).toMatchObject({
      status: "ok",
      palletIndex: (transfer as { palletIndex: number }).palletIndex,
    });
  });
  it("on synthetic devnode facts: a shape it cannot verify is unsupported with V3_ARG_SHAPE_MISMATCH, never guessed", () => {
    const k = browser
      .supportedKinds(syntheticFacts())
      .find((x) => x.kind === "revive.instantiate_with_code")!;
    expect(k.supported).toBe(false);
    expect((k as { reasonCode?: string }).reasonCode).toMatch(
      /V3_ARG_SHAPE_MISMATCH|NO_OBSERVED_V3_METADATA/,
    );
  });
  it("rejects tampered facts instead of answering", () => {
    const f = v3();
    expect(() =>
      browser.supportedKinds({ ...f, fingerprintDigest: "0x" + "00".repeat(32) }),
    ).toThrow(node.SeamCompileError);
  });
});

describe("argFields", () => {
  it.each(KINDS)("%s matches the compiler's own argument schema", (kind) => {
    const f = browser.argFields(kind);
    expect(f.filter((x) => x.required).map((x) => x.name)).toEqual(ARG_SCHEMA[kind].required);
    expect(f.filter((x) => !x.required).map((x) => x.name)).toEqual(ARG_SCHEMA[kind].optional);
    for (const x of f) expect(x.description.length).toBeGreaterThan(0);
  });
  it("revive.map_account takes no fields and deploys never take codeHash", () => {
    expect(browser.argFields("revive.map_account")).toEqual([]);
    expect(browser.argFields("revive.instantiate_with_code").map((x) => x.name)).not.toContain(
      "codeHash",
    );
  });
});

describe("checkManifest", () => {
  const withArgs = (args: Record<string, unknown>, kind = "assets.transfer") =>
    ({ ...demo.manifest, actions: [{ id: "pay", kind, args }] }) as Manifest;
  const base = demo.manifest.actions[0].args;
  it("a valid manifest is ok and carries the plan", () => {
    const r = browser.checkManifest(demo.manifest, v3());
    expect(r.ok).toBe(true);
    expect(r.plan!.manifestDigest).toBe(demo.plan.manifestDigest);
  });
  it.each([
    ["bad amount", { ...base, amount: "-1" }, "actions[0].args.amount"],
    ["bad recipient", { ...base, recipient: "not-an-address" }, "actions[0].args.recipient"],
    ["unknown arg", { ...base, memo: "x" }, "actions[0].args"],
  ])("%s is reported against its field", (_n, args, path) => {
    const r = browser.checkManifest(withArgs(args), v3());
    expect(r.ok).toBe(false);
    expect(r.plan).toBeUndefined();
    expect(r.issues.some((i) => (i.path ?? "").startsWith(path))).toBe(true);
  });
  it("empty deploy code is reported against its field", () => {
    const r = browser.checkManifest(
      withArgs(
        {
          value: "0",
          gasLimit: "1",
          proofSize: "1",
          storageDepositLimit: "1",
          code: "0x",
          data: "0x",
        },
        "revive.instantiate_with_code",
      ),
      v3(),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => (i.path ?? "").includes("code"))).toBe(true);
  });
  it("a step the runtime cannot fill is reported per step with its reason, never guessed", () => {
    const r = browser.checkManifest(
      withArgs(
        {
          contract: "5EkVZovjHsUQ2YLa2CnaVND8259u5c9h8eBtmRVweBpBVHXB",
          value: "0",
          gasLimit: "1",
          data: "0x00",
        },
        "contracts.call",
      ),
      v3(),
    );
    expect(r.ok).toBe(false);
    expect(r.unavailable).toHaveLength(1);
    expect(r.unavailable[0]!.reason).toMatch(/storageDepositLimit/);
  });
});
