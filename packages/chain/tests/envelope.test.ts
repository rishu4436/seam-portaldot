/* eslint-disable @typescript-eslint/no-explicit-any -- tests edit decoded metadata JSON */
/**
 * blockTimeFromFacts and buildSigningEnvelope: one Node-free implementation for @seam/chain and @seam/chain/browser,
 * shaped as @seam/policy's SigningEnvelope, failing closed when the block time is unknown.
 */
import { readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { factsFromMetadata, type Plan } from "@seam/compiler";
import { gatePolicy } from "@seam/policy/browser";
import * as browser from "../src/browser.js";
import * as node from "../src/index.js";
import { mutateV14 } from "./metadataMutate.js";

const require = createRequire(import.meta.url);
const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(root(p), "utf8"));
const v3Snap = json("evidence/v3-discovery/portaldot-v3-spec3002-snapshot.json");
const v3Hex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim() as `0x${string}`;
const v3Inputs = node.chainInputsFromSnapshot(v3Snap, v3Hex);
const factsOf = (hex: `0x${string}`) =>
  node.factsFromChainInputs({ ...v3Inputs, metadataHex: hex });
const v3Facts = factsOf(v3Hex);
const NOW = new Date("2026-10-20T12:00:00.000Z");
const CHECKPOINT = { number: 118900, hash: ("0x" + "ab".repeat(32)) as `0x${string}` };
const SIGNER = "5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE";
const base = { signer: SIGNER, nonce: 1, checkpoint: CHECKPOINT, now: NOW };

/** Spec 3002 with the named constant removed from a pallet (the runtime then says nothing about it). */
const withoutConst = (pallet: string, name: string) =>
  mutateV14(v3Hex, (j) => {
    const p = j.pallets.find((x: any) => x.name === pallet);
    p.constants = p.constants.filter((c: any) => c.name !== name);
  });

describe("one implementation, Node-free", () => {
  it("the browser exports are the node ones", () => {
    expect(browser.blockTimeFromFacts).toBe(node.blockTimeFromFacts);
    expect(browser.buildSigningEnvelope).toBe(node.buildSigningEnvelope);
  });
  it("envelope.ts bundles for the browser with no node builtin", () => {
    const esbuild = require("esbuild") as typeof import("esbuild");
    const r = esbuild.buildSync({
      entryPoints: [fileURLToPath(new URL("../src/envelope.ts", import.meta.url))],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const builtins = new Set(builtinModules.flatMap((b) => [b, `node:${b}`]));
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.filter((i) => builtins.has(i) || i.startsWith("node:"))).toEqual([]);
    expect(
      inputs.filter((i) => /node_modules\/ws\/|@polkadot\/(rpc-provider|api)\//.test(i)),
    ).toEqual([]);
    expect(r.outputFiles[0]!.text).not.toMatch(/node:(fs|net|path|url|child_process|os)/);
  });
});

describe("blockTimeFromFacts on V3 spec 3002", () => {
  it("is 6000 ms (Babe.ExpectedBlockTime)", () => {
    expect(browser.blockTimeFromFacts(v3Facts)).toBe(6000);
  });
  it("without Babe.ExpectedBlockTime: 2 x Timestamp.MinimumPeriod (3000) = 6000", () => {
    expect(browser.blockTimeFromFacts(factsOf(withoutConst("Babe", "ExpectedBlockTime")))).toBe(
      6000,
    );
  });
  it("with neither constant: unknown (undefined), not a default", () => {
    const hex = mutateV14(v3Hex, (j) => {
      j.pallets.find((x: any) => x.name === "Babe").constants = [];
      j.pallets.find((x: any) => x.name === "Timestamp").constants = [];
    });
    expect(browser.blockTimeFromFacts(factsOf(hex))).toBeUndefined();
  });
});

describe("buildSigningEnvelope", () => {
  it("V3: expiresAt = now + 63 x 6000 ms, shaped as @seam/policy's envelope", () => {
    const e = browser.buildSigningEnvelope({ ...base, facts: v3Facts });
    expect(e).toEqual({
      signer: SIGNER,
      nonce: 1,
      mortalityBlocks: 64,
      checkpoint: CHECKPOINT,
      expiresAt: new Date(NOW.getTime() + 63 * 6000).toISOString(),
    });
    expect(Object.keys(e).sort()).toEqual(
      ["checkpoint", "expiresAt", "mortalityBlocks", "nonce", "signer"].sort(),
    );
  });

  it("unknown block time throws NODE_MISSING_VALUE (fails closed)", () => {
    const hex = mutateV14(v3Hex, (j) => {
      j.pallets.find((x: any) => x.name === "Babe").constants = [];
      j.pallets.find((x: any) => x.name === "Timestamp").constants = [];
    });
    expect(() => browser.buildSigningEnvelope({ ...base, facts: factsOf(hex) })).toThrow(
      expect.objectContaining({ code: "NODE_MISSING_VALUE" }),
    );
    // an explicit, valid block time is the only way past it
    expect(
      browser.buildSigningEnvelope({ ...base, facts: factsOf(hex), blockTimeMs: 6000 }).expiresAt,
    ).toBe(new Date(NOW.getTime() + 63 * 6000).toISOString());
  });

  it.each([
    ["nonce", { nonce: -1 }],
    ["nonce", { nonce: 1.5 }],
    ["checkpoint", { checkpoint: { number: 1, hash: "0x12" } }],
    ["clock", { now: new Date("nope") }],
    ["signer", { signer: "" }],
    ["block time", { blockTimeMs: 0 }],
    ["mortality", { mortalityBlocks: 1 }],
  ])("malformed %s throws", (_l, over) => {
    expect(() =>
      browser.buildSigningEnvelope({ ...base, facts: v3Facts, ...(over as any) }),
    ).toThrow(node.SeamChainError);
  });

  it("Sentinel's gate: the built envelope passes the demo plan; an expired one blocks", () => {
    const demo = json("packages/console/src/demo/v3-demo-transfer.json");
    const seq = json("packages/console/src/demo/v3-demo-transfer-policy-sequential.json").policy;
    const run = json("evidence/testnet-v3/runs/plan-atomic-1792411355057.json");
    const fp = run.facts.fingerprint;
    const facts = factsFromMetadata({
      metadataHex: v3Hex,
      genesisHash: fp.genesisHash,
      tokenSymbol: fp.tokenSymbol,
      tokenDecimals: fp.tokenDecimals,
      ss58Prefix: fp.ss58Prefix,
      batchAllRollback: run.facts.behaviour?.batchAllRollback,
      batchAllRollbackProof: run.facts.behaviour?.batchAllRollbackProof,
    } as never) as any;
    const plan = demo.plan as Plan;
    const preflight = {
      steps: plan.steps.map((s) => ({
        actionId: s.actionId,
        weight: { value: "1037211000" },
        fee: { value: "1470878675697" },
        storageDeposit: { unknown: true as const },
        dryRun: "unknown" as const,
      })),
      totalFee: { value: "1470878675697" },
    };
    const envelope = browser.buildSigningEnvelope({ ...base, signer: plan.signer.value, facts });
    const input = { policy: seq, plan, facts, preflight, manifest: demo.manifest } as any;
    expect(gatePolicy(input, { acknowledgedDowngrade: true, envelope, now: NOW }).allowed).toBe(
      true,
    );
    const later = new Date(Date.parse(envelope.expiresAt) + 1);
    const g = gatePolicy(input, { acknowledgedDowngrade: true, envelope, now: later });
    expect(g.allowed).toBe(false);
  });
});
