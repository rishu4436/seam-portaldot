// P0-01: Manifest JSON import/export round-trip, live-only kind availability, fail-closed compile.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Metadata, TypeRegistry } from "@polkadot/types";
import { describe, expect, it } from "vitest";
import * as browser from "../src/browser.js";
import * as node from "../src/index.js";
import type { ActionKind, Manifest, RuntimeFacts } from "../src/types.js";
import { ALICE, BOB, demoManifest, realFacts, withRollback } from "./helpers.js";
import { syntheticFacts } from "./synthetic-v3.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only mutable JSON
type J = any;

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const v3Hex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const demo = JSON.parse(
  readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
);
const factsFor = (metadataHex: string): RuntimeFacts =>
  browser.factsFromMetadata({
    metadataHex,
    genesisHash: demo.manifest.chain.genesisHash,
    tokenSymbol: "tPOT",
    tokenDecimals: 14,
  });
const v3 = () => factsFor(v3Hex);
const KINDS = Object.keys(browser.KIND_TO_CAPABILITY) as ActionKind[];

/** The real V3 metadata with whole pallets removed (as a runtime without them would look). */
function v3Without(...pallets: string[]): RuntimeFacts {
  const j: J = new Metadata(new TypeRegistry(), v3Hex).toJSON();
  const ver = Object.keys(j.metadata)[0]!;
  j.metadata[ver].pallets = j.metadata[ver].pallets.filter(
    (p: { name: string }) => !pallets.includes(p.name),
  );
  return factsFor(new Metadata(new TypeRegistry(), j).toHex());
}

describe("exports", () => {
  it("browser and node entries share serializeManifest/parseManifest", () => {
    expect(browser.serializeManifest).toBe(node.serializeManifest);
    expect(browser.parseManifest).toBe(node.parseManifest);
  });
});

describe("supportedKinds: only what the live runtime metadata supports", () => {
  it("real V3 spec 3002: all 7 kinds supported, each with metadata call indices", () => {
    const ks = browser.supportedKinds(v3());
    expect(ks.map((k) => k.kind)).toEqual(KINDS);
    for (const k of ks) {
      expect(k.supported, `${k.kind}: ${(k as J).reason}`).toBe(true);
      if (k.supported) {
        expect(Number.isInteger(k.palletIndex)).toBe(true);
        expect(Number.isInteger(k.callIndex)).toBe(true);
      }
    }
  });

  it("V3 with Nfts, Revive and Contracts removed: those kinds unsupported, each with a code and message", () => {
    const ks = Object.fromEntries(
      browser.supportedKinds(v3Without("Nfts", "Revive", "Contracts")).map((k) => [k.kind, k]),
    );
    expect(ks["assets.transfer"]!.supported).toBe(true);
    expect(ks["assets.mint"]!.supported).toBe(true);
    for (const kind of [
      "nfts.mint",
      "revive.call",
      "revive.instantiate_with_code",
      "revive.map_account",
    ] as const) {
      expect(ks[kind]).toMatchObject({ supported: false, reasonCode: "NO_OBSERVED_V3_METADATA" });
      expect((ks[kind] as J).reason).toMatch(/has no .* call/);
    }
    expect(ks["contracts.call"]).toMatchObject({
      supported: false,
      cause: "CAPABILITY_NOT_OBSERVED",
    });
  });

  it("V3 with Assets removed: assets kinds unsupported (CAPABILITY_NOT_OBSERVED)", () => {
    const ks = browser.supportedKinds(v3Without("Assets"));
    for (const k of ks.filter((x) => x.kind.startsWith("assets.")))
      expect(k).toMatchObject({ supported: false, cause: "CAPABILITY_NOT_OBSERVED" });
  });

  it("every unsupported kind on J fixture carries a reasonCode and a non-empty reason", () => {
    for (const f of [
      realFacts(),
      syntheticFacts(),
      v3Without("Nfts", "Revive", "Contracts", "Assets"),
    ])
      for (const k of browser.supportedKinds(f))
        if (!k.supported) {
          expect(k.cause).toBeTruthy();
          expect(k.reason.length).toBeGreaterThan(0);
        }
  });

  it("a capability discovery left 'unknown' is CAPABILITY_UNKNOWN, not assumed", () => {
    const f = v3();
    const k = browser
      .supportedKinds({
        ...f,
        capabilities: { ...f.capabilities, "Assets.mint": { status: "unknown" } },
      })
      .find((x) => x.kind === "assets.mint")!;
    expect(k).toMatchObject({ supported: false, cause: "CAPABILITY_UNKNOWN" });
  });

  it("synthetic devnode: an unverifiable shape is V3_ARG_SHAPE_MISMATCH", () => {
    const codes = browser
      .supportedKinds(syntheticFacts({ reviveSwap: true }))
      .filter((k) => !k.supported)
      .map((k) => (k as J).reasonCode);
    expect(codes).toContain("V3_ARG_SHAPE_MISMATCH");
  });
});

describe("compile fails closed without observed live metadata", () => {
  const revive: Manifest = {
    version: 1,
    signer: { type: "ss58", value: ALICE },
    actions: [
      {
        id: "r",
        kind: "revive.call",
        args: { contract: "0x" + "11".repeat(20), value: "0", data: "0x00" },
      },
    ],
  };
  const nft: Manifest = {
    version: 1,
    signer: { type: "ss58", value: ALICE },
    actions: [{ id: "n", kind: "nfts.mint", args: { collection: "0", item: "1", recipient: BOB } }],
  };
  it.each([
    ["mainnet spec 1002 (no Revive/Nfts)", () => withRollback(realFacts(), "verified")],
    ["V3 with Revive/Nfts pallets removed", () => v3Without("Revive", "Nfts")],
  ])("%s: no encoded call, NO_OBSERVED_V3_METADATA, mode unavailable", (_n, facts) => {
    for (const m of [revive, nft]) {
      const p = browser.compile(m, facts());
      expect(p.mode).toBe("unavailable");
      expect(p.steps[0]).toMatchObject({
        status: "unavailable",
        encodedCall: null,
        palletIndex: null,
        reasonCode: "NO_OBSERVED_V3_METADATA",
      });
      expect(p.outerCall).toBeUndefined();
    }
  });
  it("forged facts (capability claims a call the metadata lacks) are rejected, not encoded", () => {
    const f = v3Without("Nfts");
    const forged = {
      ...f,
      capabilities: {
        ...f.capabilities,
        "Nfts.mint": { status: "observed" as const, palletIndex: 47, callIndex: 3 },
      },
    };
    let p: node.Plan | undefined;
    try {
      p = browser.compile(nft, forged);
    } catch (e) {
      expect(e).toBeInstanceOf(node.SeamCompileError);
      return;
    }
    expect(p.steps[0]!.encodedCall).toBeNull();
  });
  it("synthetic shape mismatch compiles to V3_ARG_SHAPE_MISMATCH, never a guessed layout", () => {
    const f = syntheticFacts({ reviveSwap: true });
    const p = browser.compile(revive, f);
    expect(p.steps[0]).toMatchObject({ encodedCall: null });
    expect(p.steps[0]!.reasonCode).toMatch(/V3_ARG_SHAPE_MISMATCH|NO_OBSERVED_V3_METADATA/);
  });
});

describe("serializeManifest / parseManifest", () => {
  it("round-trips the V3 demo manifest: same bytes, manifestDigest and planDigest", () => {
    const m = demo.manifest as Manifest;
    const text = browser.serializeManifest(m);
    const r = browser.parseManifest(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest).toEqual(JSON.parse(JSON.stringify(m)));
    expect(browser.serializeManifest(r.manifest)).toBe(text);
    const a = browser.compile(m, v3());
    const b = browser.compile(r.manifest, v3());
    expect(b.manifestDigest).toBe(a.manifestDigest);
    expect(b.planDigest).toBe(a.planDigest);
  });

  it("is deterministic regardless of key order and whitespace", () => {
    const m = demoManifest();
    const shuffled = JSON.parse(JSON.stringify(m), (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).reverse())
        : v,
    );
    const pretty = JSON.stringify(shuffled, null, 2);
    const r = browser.parseManifest(pretty);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(browser.serializeManifest(r.manifest)).toBe(browser.serializeManifest(m));
    const f = withRollback(realFacts(), "verified");
    expect(browser.compile(r.manifest, f).planDigest).toBe(browser.compile(m, f).planDigest);
  });

  it("bigint amounts export exactly as decimal strings (u128 max)", () => {
    const max = (1n << 128n) - 1n;
    const m = demoManifest();
    (m.actions[0]!.args as J).amount = max;
    const r = browser.parseManifest(browser.serializeManifest(m));
    expect(r.ok && (r.manifest.actions[0]!.args as J).amount).toBe(max.toString());
  });

  const bad = (mut: (m: J) => void) => {
    const m: J = JSON.parse(JSON.stringify(demoManifest()));
    mut(m);
    return JSON.stringify(m);
  };
  it.each([
    ["unknown top-level field", (m: J) => (m.extra = 1), "extra"],
    ["unknown signer field", (m: J) => (m.signer.foo = "x"), "signer.foo"],
    [
      "unknown chain field",
      (m: J) => (m.chain = { genesisHash: "0x", specVersion: 1, x: 1 }),
      "chain.x",
    ],
    ["unknown action field", (m: J) => (m.actions[0].note = "x"), "actions[0].note"],
    ["unknown kind", (m: J) => (m.actions[0].kind = "balances.transfer"), "actions[0].kind"],
    ["unknown arg", (m: J) => (m.actions[0].args.memo = "x"), "actions[0].args.memo"],
    ["float", (m: J) => (m.actions[0].args.assetId = 1.5), "actions[0].args.assetId"],
    ["missing required arg", (m: J) => delete m.actions[0].args.amount, "actions[0].args.amount"],
    ["wrong version", (m: J) => (m.version = 2), "version"],
    ["duplicate ids", (m: J) => (m.actions[1].id = m.actions[0].id), "actions[1].id"],
  ])("rejects %s with a path", (_n, mut, path) => {
    const r = browser.parseManifest(bad(mut));
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.path)).toContain(path);
  });

  it("rejects an unsafe bare integer instead of rounding it", () => {
    const text = bad(() => {}).replace(
      /"assetId":"?(\d+)"?/,
      '"assetId":340282366920938463463374607431768211455',
    );
    const r = browser.parseManifest(text);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.code).toBe("NOT_CANONICAL");
  });

  it("rejects non-JSON and non-objects without throwing", () => {
    expect(browser.parseManifest("{").ok).toBe(false);
    expect(browser.parseManifest("[]").ok).toBe(false);
    expect(browser.parseManifest("null").ok).toBe(false);
  });

  it("serializeManifest refuses what parseManifest would reject", () => {
    const m: J = demoManifest();
    m.extra = true;
    expect(() => browser.serializeManifest(m)).toThrow(node.SeamCompileError);
  });

  it("with live facts: value errors come back as issues with paths (bad recipient)", () => {
    const f = withRollback(realFacts(), "verified");
    const r = browser.parseManifest(
      bad((m: J) => (m.actions[0].args.recipient = "notanaddress")),
      f,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path?.startsWith("actions[0].args.recipient"))).toBe(true);
  });

  it("with live facts: a valid manifest returns the compile check and its plan", () => {
    const f = withRollback(realFacts(), "verified");
    const r = browser.parseManifest(browser.serializeManifest(demoManifest()), f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.check?.plan?.planDigest).toBe(browser.compile(demoManifest(), f).planDigest);
  });
});
