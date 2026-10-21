/**
 * P0-04: the browser entry runs system_dryRun on the assembled signed bytes and maps the node's answer to ok / failed /
 * unknown, fail closed. Offline: FakeNode answers are fixtures, except the V3 cases, which replay raw system_dryRun
 * answers recorded read-only from https://test-node-v3.portaldot.dev for the included tx 0xadced4b5… (#121390)
 * (evidence/testnet-v3/dryrun-capability-*.json).
 */
import { describe, expect, it } from "vitest";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import * as browser from "../src/browser.js";
import { assembleSignedExtrinsic, buildSigningRequests } from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { ALICE, CHECKPOINT, demoPlan, devKeys, snapshotFacts, snapshotInputs } from "./helpers.js";

const facts = snapshotFacts();
const node = (o: Partial<ConstructorParameters<typeof FakeNode>[0]> = {}) =>
  new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: ["1", "2"], ...o });

async function signed() {
  const keys = await devKeys();
  const plan = demoPlan();
  const reqs = buildSigningRequests(plan, facts, {
    signer: ALICE,
    nonce: 0,
    mortalityBlocks: 64,
    checkpoint: CHECKPOINT,
    expiresAt: "x",
  });
  return {
    plan,
    xs: reqs.map((q) =>
      assembleSignedExtrinsic(
        q.payload,
        u8aToHex(keys.alice.sign(hexToU8a(q.signBytesHex), { withType: true })),
        facts,
      ),
    ),
  };
}

describe("browser signedDryRun (system_dryRun on the assembled signed bytes)", () => {
  it("is exported from @seam/chain/browser and runs over a plain send", async () => {
    const { xs } = await signed();
    const n = node();
    const r = await browser.signedDryRun(n, facts, xs);
    // later steps: Future nonce while step 1 is not on chain, so unknown (dry-run again right before each is sent)
    expect(r.results).toEqual(["ok", ...xs.slice(1).map(() => "unknown")]);
    expect(r.details[1]!.detail).toMatch(/future/);
    expect(n.log.filter((l) => l.method === "system_dryRun")).toHaveLength(xs.length);
  });

  it("a real signature that the node rejects is failed, never ok", async () => {
    const { xs } = await signed();
    const bad = (xs[0]!.slice(0, 120) + (xs[0]![120] === "0" ? "1" : "0") + xs[0]!.slice(121)) as `0x${string}`;
    const r = await browser.signedDryRun(node(), facts, [bad]);
    expect(r.results[0]).not.toBe("ok");
  });

  it("RPC missing: unknown with an explicit reason", async () => {
    const { xs } = await signed();
    const n = node({ failRpc: ["system_dryRun"] });
    const r = await browser.signedDryRun(n, facts, [xs[0]!]);
    expect(r.results).toEqual(["unknown"]);
    expect(r.details[0]!.detail).toMatch(/system_dryRun unavailable/);
  });

  // Defect: polkadot.js decodes null and "0x" to the default ApplyExtrinsicResult, Ok(Ok(())), so a node that
  // answered nothing was reported as a passing dry run. Each of these must stay unknown.
  for (const [label, answer] of [
    ["null", null],
    ["empty 0x", "0x"],
    ["not hex", "ok"],
    ["a number", 0],
    ["trailing bytes", "0x000000"],
    ["truncated Err", "0x01"],
  ] as const)
    it(`a malformed answer (${label}) is unknown, never ok`, async () => {
      const { xs } = await signed();
      const r = await browser.signedDryRun(node({ dryRunAnswer: () => answer }), facts, [xs[0]!]);
      expect(r.results).toEqual(["unknown"]);
      expect(r.details[0]!.detail).toMatch(/malformed|could not decode/);
    });

  it("dispatch error from the node is failed with the pallet error", async () => {
    const { xs } = await signed();
    const n = node({ failCall: () => ({ index: 50, error: 0 }) });
    const r = await browser.signedDryRun(n, facts, [xs[0]!]);
    expect(r.results).toEqual(["failed"]);
    expect(r.details[0]!.detail).toMatch(/dispatch failed/);
  });

  it("the preflight report carries the same mapping into dryRun of the step (fail closed)", async () => {
    const { plan, xs } = await signed();
    const r = await browser.preflightReport(node({ dryRunAnswer: () => null }), plan, facts, {
      signedExtrinsics: xs,
      nonce: 0,
    });
    expect(r.transactions.map((t) => t.dryRun?.outcome)).toEqual(xs.map(() => "unknown"));
    // contracts.call steps keep their own contracts_call result; every other step must not be ok
    const kinds = new Map(plan.steps.map((s) => [s.actionId, s.kind]));
    expect(
      r.result.steps.filter((s) => kinds.get(s.actionId) !== "contracts.call").map((s) => s.dryRun),
    ).not.toContain("ok");
  });

  it("passes `at` through to system_dryRun", async () => {
    const { xs } = await signed();
    const n = node();
    await browser.signedDryRun(n, facts, [xs[0]!], { at: CHECKPOINT.hash as `0x${string}` });
    expect(n.log.find((l) => l.method === "system_dryRun")!.params[1]).toBe(CHECKPOINT.hash);
  });

  it("the preflight report records each signed dry run: outcome, detail, raw result and block", async () => {
    const { plan, xs } = await signed();
    const n = node({ failCall: () => ({ index: 50, error: 0 }) });
    const r = await browser.preflightReport(n, plan, facts, { signedExtrinsics: xs, nonce: 0 });
    const d = r.transactions[0]!.dryRun!;
    expect(d).toMatchObject({ outcome: "failed", raw: "0x0001033200" });
    expect(d.detail).toMatch(/^system_dryRun: dispatch failed/);
    expect(d.at).toEqual({ number: r.atBlock.number, hash: r.atBlock.hash });
  });
});
