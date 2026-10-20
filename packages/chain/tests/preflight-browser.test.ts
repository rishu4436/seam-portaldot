/* eslint-disable @typescript-eslint/no-explicit-any -- test passes raw JSON fixtures */
/**
 * @seam/chain/browser preflight: one implementation with the node entry (preflightWithClient over an injected send),
 * the PreflightResult Sentinel's gate (@seam/policy/browser assertPolicyAllows) takes, and no node builtins.
 * Offline: FakeNode answers are fixtures, not chain data.
 */
import { readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { factsFromMetadata, type Plan } from "@seam/compiler";
import { PolicyBlockedError, assertPolicyAllows, gatePolicy } from "@seam/policy/browser";
import * as browser from "../src/browser.js";
import * as node from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { demoPlan, snapshotFacts, snapshotInputs } from "./helpers.js";

const require = createRequire(import.meta.url);
const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(root(p), "utf8"));

// The V3 demo (same inputs as packages/policy/test/browser-entry.test.ts).
const demo = json("packages/console/src/demo/v3-demo-transfer.json");
const seqPolicy = json("packages/console/src/demo/v3-demo-transfer-policy-sequential.json").policy;
const atomicRun = json("evidence/testnet-v3/runs/plan-atomic-1792411355057.json");
const v3Snap = json("evidence/v3-discovery/portaldot-v3-spec3002-snapshot.json");
const v3Hex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const fp = atomicRun.facts.fingerprint;
const v3Facts = factsFromMetadata({
  metadataHex: v3Hex,
  genesisHash: fp.genesisHash,
  tokenSymbol: fp.tokenSymbol,
  tokenDecimals: fp.tokenDecimals,
  ss58Prefix: fp.ss58Prefix,
  batchAllRollback: atomicRun.facts.behaviour?.batchAllRollback,
  batchAllRollbackProof: atomicRun.facts.behaviour?.batchAllRollbackProof,
} as never) as any;
const v3Inputs = node.chainInputsFromSnapshot(v3Snap, v3Hex);
const plan = demo.plan as Plan;
const v3Node = (o: Partial<ConstructorParameters<typeof FakeNode>[0]> = {}) =>
  new FakeNode({
    inputs: v3Inputs,
    facts: v3Facts,
    existingAssets: ["806707"],
    queryInfoWeight: { ref_time: 180000000, proof_size: 3593 },
    ...o,
  });
const sendOf = (n: FakeNode) => (m: string, p: unknown[]) => n.send(m, p);
const gateInput = (preflight: unknown) => ({
  policy: seqPolicy,
  plan,
  facts: v3Facts,
  preflight,
  manifest: demo.manifest,
});
const OPTS = { acknowledgedDowngrade: true };

describe("browser preflight", () => {
  it("the V3 demo plan's facts are the plan's", () => {
    expect(v3Facts.fingerprintDigest).toBe(plan.fingerprintDigest);
  });

  it("node and browser give the same report (V3 demo plan and the mainnet demo plan)", async () => {
    const at = v3Inputs.head.hash;
    const n = await node.preflight(v3Node(), plan, v3Facts, { at });
    const b = await browser.preflightReport(sendOf(v3Node()), plan, v3Facts, { at });
    expect(b).toEqual(n);
    expect(await browser.preflight(sendOf(v3Node()), plan, v3Facts, { at })).toEqual(n.result);
    const mf = snapshotFacts();
    const mp = demoPlan(mf);
    const mk = () =>
      new FakeNode({ inputs: snapshotInputs(), facts: mf, existingAssets: ["1", "2"] });
    expect(await browser.preflightReport(sendOf(mk()), mp, mf)).toEqual(
      await node.preflight(mk(), mp, mf),
    );
  });

  it("same implementation: the node entry's preflightWithClient is the browser's", () => {
    expect(browser.preflightWithClient).toBe(node.preflightWithClient);
    expect(browser.fakeSignedExtrinsic).toBe(node.fakeSignedExtrinsic);
  });

  it("a full result (one step per plan step) passes Sentinel's gate with the sequential demo policy", async () => {
    const r = await browser.preflight(sendOf(v3Node()), plan, v3Facts);
    expect(r.steps.map((s) => s.actionId)).toEqual(plan.steps.map((s) => s.actionId));
    expect(r.steps[0]).toMatchObject({
      weight: { value: "180000000" },
      fee: { value: "1500000000" },
      proofSize: { value: "3593" },
      storageDeposit: { unknown: true },
      dryRun: "unknown", // no signed extrinsic: never "ok"
    });
    expect(r.totalFee).toEqual({ value: "1500000000" });
    expect(assertPolicyAllows(gateInput(r) as any, OPTS).allowed).toBe(true);
  });

  it("an RPC error leaves fee and weight unknown, and the gate blocks", async () => {
    const r = await browser.preflight(
      sendOf(v3Node({ failRpc: ["payment_queryInfo"] })),
      plan,
      v3Facts,
    );
    expect(r.steps[0]).toMatchObject({ weight: { unknown: true }, fee: { unknown: true } });
    expect(r.steps[0]!.dryRun).toBe("unknown");
    expect(r.totalFee).toEqual({ unknown: true });
    expect(() => assertPolicyAllows(gateInput(r) as any, OPTS)).toThrow(PolicyBlockedError);
    const g = gatePolicy(gateInput(r) as any, OPTS);
    expect(g.allowed).toBe(false);
    expect(g.blockedBy.every((x) => x.status === "unknown")).toBe(true);
  });

  it("a node that is down: the browser preflight throws (nothing is reported as known)", async () => {
    const down = async () => {
      throw new Error("fetch failed");
    };
    await expect(browser.preflight(down, plan, v3Facts)).rejects.toThrow(/fetch failed/);
  });

  it("dryRun is ok only from the node's system_dryRun of a caller's signed extrinsic", async () => {
    const n = v3Node();
    const r = await browser.preflight(sendOf(n), plan, v3Facts);
    expect(r.steps.every((s) => s.dryRun === "unknown")).toBe(true);
    expect(n.log.map((l: any) => l.method)).not.toContain("system_dryRun");
  });

  it("sends only read methods", async () => {
    const n = v3Node();
    await browser.preflight(sendOf(n), plan, v3Facts);
    const methods = [...new Set(n.log.map((l: any) => l.method))];
    expect(
      methods.filter(
        (m) => !/^(chain_get|state_get|system_accountNextIndex|payment_query)/.test(m),
      ),
    ).toEqual([]);
  });
});

describe("browser preflight bundle", () => {
  it("preflight-browser.ts bundles with no node builtin and no ws package", () => {
    const esbuild = require("esbuild") as typeof import("esbuild");
    const r = esbuild.buildSync({
      entryPoints: [fileURLToPath(new URL("../src/preflight-browser.ts", import.meta.url))],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(r.metafile.inputs);
    const builtins = new Set(builtinModules.flatMap((b) => [b, `node:${b}`]));
    expect(inputs.filter((i) => builtins.has(i) || i.startsWith("node:"))).toEqual([]);
    expect(
      inputs.filter((i) => /node_modules\/ws\/|@polkadot\/(rpc-provider|api)\//.test(i)),
    ).toEqual([]);
    expect(
      inputs.filter((i) => /src\/(rpc|discover|capabilities|dryrun|preflight)\.ts$/.test(i)),
    ).toEqual([]);
  });
});
