/**
 * @seam/chain/browser factsFromChainInputs: the same facts, fingerprint digest and layout hash as the node discovery path,
 * for identical inputs (REAL committed metadata: Portaldot mainnet spec 1002 and the V3 testnet spec 3002).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readPinnedTypes, type Hex } from "@seam/compiler";
import * as node from "../src/index.js";
import * as browser from "../src/browser.js";
import { chainInputsFromSnapshot, type ChainInputs } from "../src/index.js";
import { snapshotInputs } from "./helpers.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const v3Snapshot = JSON.parse(
  readFileSync(repo("evidence/v3-discovery/portaldot-v3-spec3002-snapshot.json"), "utf8"),
);
const v3Metadata = readFileSync(
  repo("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const v3Inputs = (): ChainInputs => chainInputsFromSnapshot(v3Snapshot, v3Metadata);
const require = createRequire(import.meta.url);

describe("browser factsFromChainInputs == node discovery path (REAL metadata)", () => {
  it("V3 spec 3002: identical facts, fingerprint digest and layout hash; no types file needed", () => {
    const inputs = v3Inputs();
    const n = node.factsFromChainInputs(inputs);
    const b = browser.factsFromChainInputs(inputs);
    expect(b).toEqual(n);
    expect(b.fingerprint.specName).toBe("portaldot-v3");
    expect(b.fingerprint.specVersion).toBe(3002);
    const nf = node.fingerprintFromChainInputs(inputs);
    const bf = browser.fingerprintFromChainInputs(inputs);
    expect(bf).toEqual(nf);
    // layout v2: only Revive.EthBlockBuilderIR's storage default is blanked (v1, every default blanked, was 0x8baafefc…c1a6)
    expect(bf.metadataLayoutHash).toBe(
      "0x221ba8f7dd81e0341fca9f0074a3e433659c97300cbbb2f874dbd5f0d998b304",
    );
    // The digest recorded when the snapshot was taken.
    expect(bf.fingerprintDigest).toBe(v3Snapshot.fingerprintDigest);
  });

  it("mainnet spec 1002 (metadata V13): identical, given the same pinned types text", () => {
    const inputs = snapshotInputs();
    const typesBundle = readPinnedTypes();
    expect(browser.factsFromChainInputs(inputs, { typesBundle })).toEqual(
      node.factsFromChainInputs(inputs),
    );
    expect(browser.fingerprintFromChainInputs(inputs, { typesBundle })).toEqual(
      node.fingerprintFromChainInputs(inputs),
    );
  });

  it("options pass through the same way (declaredToken, pinnedMetadataHex)", () => {
    const inputs = { ...v3Inputs(), properties: { ss58Format: 42 } };
    const declaredToken = { tokenSymbol: "tPOT", tokenDecimals: 14 };
    expect(browser.factsFromChainInputs(inputs, { declaredToken })).toEqual(
      node.factsFromChainInputs(inputs, { declaredToken }),
    );
    const pinned = { pinnedMetadataHex: v3Metadata as Hex };
    expect(browser.fingerprintFromChainInputs(v3Inputs(), pinned)).toEqual(
      node.fingerprintFromChainInputs(v3Inputs(), pinned),
    );
  });
});

describe("fails closed on bad or missing inputs", () => {
  const err = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e as { code?: string; message: string };
    }
    throw new Error("expected a throw");
  };
  it("metadata V13 without the pinned types file: NODE_MISSING_VALUE, never a guess", () => {
    const e = err(() => browser.factsFromChainInputs(snapshotInputs()));
    expect(e.code).toBe("NODE_MISSING_VALUE");
    expect(e.message).toMatch(/pinned types file/);
  });
  it("no token in properties and none declared: NODE_MISSING_VALUE", () => {
    const e = err(() => browser.factsFromChainInputs({ ...v3Inputs(), properties: {} }));
    expect(e.code).toBe("NODE_MISSING_VALUE");
  });
  it("a runtime version that disagrees with the metadata: FACTS_MISMATCH", () => {
    const i = v3Inputs();
    const e = err(() =>
      browser.factsFromChainInputs({
        ...i,
        runtimeVersion: { ...i.runtimeVersion, specVersion: 3001 },
      }),
    );
    expect(e.code).toBe("FACTS_MISMATCH");
  });
  it("metadata that is not metadata: FACTS_MISMATCH with a clear message", () => {
    const e = err(() => browser.factsFromChainInputs({ ...v3Inputs(), metadataHex: "0x1234" }));
    expect(e.code).toBe("FACTS_MISMATCH");
    expect(e.message).toMatch(/meta/);
  });
  it("a bad genesis hash fails", () => {
    expect(() =>
      browser.factsFromChainInputs({ ...v3Inputs(), genesisHash: "0xnothex" as Hex }),
    ).toThrow();
  });
});

describe("browser entry stays browser-safe with the facts path", () => {
  it("bundles with no node: import and no node-only compiler module", () => {
    const esbuild = require("esbuild") as typeof import("esbuild");
    const r = esbuild.buildSync({
      entryPoints: [fileURLToPath(new URL("../src/browser.ts", import.meta.url))],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.some((i) => /^node:/.test(i))).toBe(false);
    expect(inputs.some((i) => /compiler\/(src|dist)\/(pinned-file|compile|index)\./.test(i))).toBe(
      false,
    );
    expect(r.outputFiles[0]!.text).toMatch(/function factsFromChainInputs\b/);
    expect(r.outputFiles[0]!.text).not.toMatch(/node:(fs|url|path)/);
  });
});
