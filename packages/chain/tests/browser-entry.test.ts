/* eslint-disable @typescript-eslint/no-explicit-any -- test pokes raw polkadot objects */
/**
 * @seam/chain/browser: the offline signature checks and assembler without node builtins, and the same verdicts as the node entry.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { describe, expect, it } from "vitest";
import { callsToSign } from "@seam/policy";
import { loadRuntime, readPinnedTypes, type Hex } from "@seam/compiler";
import * as node from "../src/index.js";
import * as browser from "../src/browser.js";
import { createPortaldotAdapter, encodeRuntime, signBytesOf } from "../src/index.js";
import { loadRuntimeCore } from "../src/runtime-core.js";
import { FakeNode } from "./fakeNode.js";
import { demoPlan, devKeys, metadataHex, snapshotFacts, snapshotInputs } from "./helpers.js";

const NOW = new Date("2026-10-11T12:00:00Z");
const entry = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));
const require = createRequire(import.meta.url);

async function setup() {
  const keys = await devKeys();
  const facts = snapshotFacts();
  const nodeRpc = new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: ["1", "2"] });
  const adapter = createPortaldotAdapter(nodeRpc, {
    allowMainnet: true,
    submitTimeoutMs: 2000,
    now: () => NOW,
    facts,
  });
  await adapter.discover();
  const plan = demoPlan(facts);
  const { envelope } = await adapter.preflight(plan);
  const requests = adapter.signingRequests(
    callsToSign(plan).filter((c): c is Hex => !!c),
    envelope,
  );
  const { registry } = encodeRuntime(facts);
  const sign = (pair: any, payload: any) =>
    u8aToHex(pair.sign(hexToU8a(signBytesOf(payload, facts)), { withType: true }));
  const forge = (pair: any, payload: any, signature: string = sign(pair, payload)): Hex => {
    const ext = registry.createType("Extrinsic", { method: payload.method }, { version: 4 });
    ext.addSignature(payload.address, hexToU8a(signature), payload);
    return ext.toHex() as Hex;
  };
  return {
    keys,
    facts,
    requests,
    sign,
    forge,
    honest: requests.map((r) => forge(keys.alice, r.payload)),
  };
}

describe("browser entry has no node-only code", () => {
  const esbuild = require("esbuild") as typeof import("esbuild");
  const bundle = (file: string) =>
    esbuild.buildSync({
      entryPoints: [entry(file)],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });

  it("bundles for the browser with no node builtin, no ws client and no @seam/compiler runtime", () => {
    const r = bundle("browser.ts");
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.some((i) => /^(node:|fs$|net$|child_process$)/.test(i))).toBe(false);
    expect(
      inputs.some((i) =>
        /node_modules\/(ws|@polkadot\/rpc-provider|@polkadot\/rpc-provider\/node_modules\/ws)\//.test(
          i,
        ),
      ),
    ).toBe(false);
    expect(inputs.some((i) => /packages\/compiler\/|node_modules\/@seam\/compiler\//.test(i))).toBe(
      false,
    );
    const text = r.outputFiles[0]!.text;
    expect(text).not.toMatch(/node:(fs|net|path|url|child_process|os|crypto)/);
    expect(text).not.toMatch(/require\(["'](fs|net|child_process|ws|node:[a-z_]+)["']\)/);
    expect(text).toMatch(/verifySignedAgainstRequest/);
  });

  it("control: the node entry cannot be bundled for the browser (the check can fail)", () => {
    expect(() => bundle("index.ts")).toThrow(/node:|Could not resolve/);
  });

  it("declares the ./browser export and keeps the node export", () => {
    const pkg = require("../package.json");
    expect(pkg.exports["./browser"]).toEqual({
      types: "./dist/browser.d.ts",
      import: "./dist/browser.js",
    });
    expect(pkg.exports["."].import).toBe("./dist/index.js");
  });

  it("exports the same function objects behaviour: verifySignedAgainstRequest, verifySignedBatch, assembleSignedExtrinsic", () => {
    for (const n of [
      "verifySignedAgainstRequest",
      "verifySignedBatch",
      "assembleSignedExtrinsic",
      "extractSignedCall",
      "signBytesOf",
      "toMultiSignature",
      "signedExtrinsicDecoder",
      "checkSignedExtrinsic",
      "SeamChainError",
    ]) {
      expect(typeof (browser as any)[n], n).toBe("function");
      expect((browser as any)[n]).toBe((node as any)[n]); // one implementation, not a copy
    }
  });

  it("runtime-core builds the same registry hashes as the compiler loadRuntime", () => {
    const f = snapshotFacts();
    const a = loadRuntime(metadataHex, readPinnedTypes());
    const b = loadRuntimeCore(metadataHex, readPinnedTypes());
    expect(b.metadataHash).toBe(a.metadataHash);
    expect(b.typesBundleHash).toBe(a.typesBundleHash);
    expect(b.metadataVersion).toBe(a.metadataVersion);
    expect(b.registry.signedExtensions).toEqual(a.registry.signedExtensions);
    expect(() => loadRuntimeCore(metadataHex, null)).toThrow(/pinned types file is required/);
    expect(() => loadRuntimeCore("0x1234")).toThrow(/meta/);
    expect(f.fingerprint.metadataHash).toBe(b.metadataHash);
  });
});

describe("browser entry verifies like the node entry", () => {
  it("accepts the matching signed transaction, same verdict as node", async () => {
    const s = await setup();
    const b = browser.verifySignedAgainstRequest(s.honest[0]!, s.requests[0]!, { facts: s.facts });
    expect(b).toMatchObject({ ok: true, reasons: [] });
    expect(b).toEqual(
      node.verifySignedAgainstRequest(s.honest[0]!, s.requests[0]!, { facts: s.facts }),
    );
  });

  it("rejects tampered call / nonce / genesis / signer / tip / era / signature, fails closed without facts", async () => {
    const s = await setup();
    const p = s.requests[0]!.payload;
    const cases: [string, Hex, string][] = [
      ["call", s.forge(s.keys.alice, { ...p, method: s.requests[1]!.callHex }), "call_mismatch"],
      [
        "nonce",
        s.forge(s.keys.alice, { ...p, nonce: p.nonce.replace(/.$/, "9") }),
        "nonce_mismatch",
      ],
      [
        "genesis",
        s.forge(s.keys.alice, { ...p, genesisHash: "0x" + "11".repeat(32) }),
        "signature_invalid",
      ],
      ["signer", s.forge(s.keys.bob, { ...p, address: s.keys.bob.address }), "signer_mismatch"],
      ["tip", s.forge(s.keys.alice, { ...p, tip: "0x01" }), "tip_mismatch"],
      ["era", s.forge(s.keys.alice, { ...p, era: "0x00" }), "era_mismatch"],
      ["truncated", (s.honest[0] as string).slice(0, -20) as Hex, "not_decodable"],
      ["garbage", "0x1234" as Hex, "not_decodable"],
    ];
    for (const [name, tx, code] of cases) {
      const b = browser.verifySignedAgainstRequest(tx, s.requests[0]!, { facts: s.facts });
      expect(b.ok, name).toBe(false);
      expect(b.reasons, name).toContain(code);
      expect(b, name).toEqual(
        node.verifySignedAgainstRequest(tx, s.requests[0]!, { facts: s.facts }),
      );
    }
    expect(browser.verifySignedAgainstRequest(s.honest[0]!, s.requests[0]!)).toMatchObject({
      ok: false,
      reasons: ["facts_missing"],
    });
  });

  it("batch: same verdicts, count and order mismatches refused", async () => {
    const s = await setup();
    const ctx = { facts: s.facts };
    expect(browser.verifySignedBatch(s.honest, s.requests, ctx)).toEqual(
      node.verifySignedBatch(s.honest, s.requests, ctx),
    );
    expect(browser.verifySignedBatch(s.honest, s.requests, ctx).ok).toBe(true);
    const fewer = browser.verifySignedBatch(s.honest.slice(0, 2), s.requests, ctx);
    expect(fewer.ok).toBe(false);
    expect(fewer.reasons).toContain("count_mismatch");
    expect(
      browser.verifySignedBatch([s.honest[1]!, s.honest[0]!, s.honest[2]!], s.requests, ctx).ok,
    ).toBe(false);
  });
});

describe("browser assembler", () => {
  it("assembles the same bytes as node from a wallet signature, and the verifier accepts them", async () => {
    const s = await setup();
    const req = s.requests[0]!;
    const signature = s.sign(s.keys.alice, req.payload);
    const b = browser.assembleSignedExtrinsic(req.payload, signature, s.facts);
    expect(b).toBe(node.assembleSignedExtrinsic(req.payload, signature, s.facts));
    expect(browser.verifySignedAgainstRequest(b, req, { facts: s.facts }).ok).toBe(true);
  });

  it("refuses a bad signature, an untyped signature, and a payload for another chain", async () => {
    const s = await setup();
    const req = s.requests[0]!;
    const good = s.sign(s.keys.alice, req.payload);
    expect(() =>
      browser.assembleSignedExtrinsic(req.payload, s.sign(s.keys.bob, req.payload), s.facts),
    ).toThrow(/BAD_SIGNATURE/);
    expect(() =>
      browser.assembleSignedExtrinsic(req.payload, "0x" + good.slice(4), s.facts),
    ).toThrow(/BAD_SIGNATURE/);
    expect(() =>
      browser.assembleSignedExtrinsic(
        { ...req.payload, genesisHash: "0x" + "11".repeat(32) },
        good,
        s.facts,
      ),
    ).toThrow(/PAYLOAD_MISMATCH/);
    expect(() => browser.assembleSignedExtrinsic(req.payload, "nothex", s.facts)).toThrow(
      /BAD_SIGNATURE/,
    );
  });
});
