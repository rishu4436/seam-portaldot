// proof_size 0 = unknown, for revive.call limits and for preflight estimates (fail closed).
// Real V3 spec 3002 metadata, fresh compile in-test; the preflight numbers are synthetic test data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { compile, factsFromMetadata } from "@seam/compiler/browser";
import { definePolicy, type Manifest, type Plan, type RuntimeFacts } from "../src/index.js";
import { gatePolicy } from "../src/browser.js";
import * as H from "./helpers.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const facts = factsFromMetadata({
  metadataHex: readFileSync(
    root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
    "utf8",
  ).trim(),
  genesisHash: "0x" + "11".repeat(32),
  tokenSymbol: "tPOT",
  tokenDecimals: 14,
} as never) as unknown as RuntimeFacts;
const C = "0x" + "22".repeat(20);
const call = (proofSize: string): Manifest =>
  ({
    version: 1,
    signer: { type: "ss58", value: H.ALICE },
    actions: [
      {
        id: "call",
        kind: "revive.call",
        args: {
          contract: C,
          value: "0",
          data: "0x00",
          gasLimit: "5000000000",
          proofSize,
          storageDepositLimit: "100",
        },
      },
    ],
  }) as Manifest;
const plan = (m: Manifest) => compile(m as never, facts as never) as unknown as Plan;
const policy = (over = {}) =>
  definePolicy({
    allowedContracts: [C],
    maxNativeValue: "0",
    maxGasLimit: "5000000000",
    maxProofSize: "1000000",
    maxStorageDeposit: "100",
    maxFee: "10000000000",
    ...over,
  });
const pf = (p: Plan, proofSize?: string) => ({
  ...H.preflight(p),
  steps: H.preflight(p).steps.map((s) => ({
    ...s,
    ...(proofSize === undefined ? {} : { proofSize: { value: proofSize } }),
  })),
});
const gate = (p: Plan, pol = policy(), pre = pf(p)) =>
  gatePolicy({ policy: pol, plan: p, facts, preflight: pre });

describe("revive.call proof size limit 0", () => {
  it("a real limit passes", () => {
    const g = gate(plan(call("200000")));
    expect(g.allowed, JSON.stringify(g.blockedBy)).toBe(true);
  });
  it.each(["0"])("proofSize %s blocks CALL_PROOF_SIZE_UNKNOWN with a plain line", (v) => {
    const g = gate(plan(call(v)));
    expect(g.allowed).toBe(false);
    expect(g.blockedBy.map((b) => b.code)).toContain("CALL_PROOF_SIZE_UNKNOWN");
    expect(g.blockedBy.find((b) => b.code === "CALL_PROOF_SIZE_UNKNOWN")?.message).toBe(
      "Proof size within limit (step call): Fail. Blocked: the contract call's proof size limit is 0, which means the proof size (PoV) part of its weight is unknown, so the call can't be bounded.",
    );
  });
  it("a hand-edited all-zero value (compiler refuses it) also blocks", () => {
    const p = structuredClone(plan(call("200000")));
    p.steps[0].decodedArgs.proofSize = "000";
    const g = gate({ ...p, planDigest: H.planDigest(p) });
    expect(g.blockedBy.map((b) => b.code)).toContain("CALL_PROOF_SIZE_UNKNOWN");
  });
  it("blocks even when the policy sets no proof size cap", () => {
    const g = gate(plan(call("0")), policy({ maxProofSize: undefined }));
    expect(g.blockedBy.map((b) => b.code)).toContain("CALL_PROOF_SIZE_UNKNOWN");
  });
  it("a call limit of 0 never counts as 'bounded by the call's own limit' for the estimate", () => {
    const g = gate(plan(call("0")), policy(), pf(plan(call("0")), "0"));
    expect(g.explanations.some((e) => /bounded by the call's own limit/.test(e.message))).toBe(
      false,
    );
  });
});

describe("preflight proof size estimate 0", () => {
  const transfer = plan({
    version: 1,
    signer: { type: "ss58", value: H.ALICE },
    actions: [
      { id: "pay", kind: "assets.transfer", args: { assetId: "1", amount: "1", recipient: H.BOB } },
    ],
  } as Manifest);
  const tp = (over = {}) =>
    policy({
      allowedAssets: ["1"],
      allowedRecipients: [H.BOB],
      maxAmountPerAsset: { "*": "10" },
      ...over,
    });
  it("a real estimate within the cap passes", () => {
    expect(gate(transfer, tp(), pf(transfer, "18392")).allowed).toBe(true);
  });
  it("an estimate of 0 is unknown: PROOF_SIZE_LIMIT_UNKNOWN, blocked by default", () => {
    const g = gate(transfer, tp(), pf(transfer, "0"));
    expect(g.allowed).toBe(false);
    expect(g.blockedBy.map((b) => b.code)).toEqual(["PROOF_SIZE_LIMIT_UNKNOWN"]);
    expect(g.blockedBy[0].message).toBe(
      "Proof size within limit (step pay): Unknown, so blocked. Proof size is unknown.",
    );
  });
  it("allowUnknown.proofSize lets it through only as weaker proof, never as a passing bound", () => {
    const g = gate(transfer, tp({ allowUnknown: { proofSize: true } }), pf(transfer, "0"));
    expect(g.allowed).toBe(true);
    expect(g.result!.weakProof).toContain("proof_size_limit:pay");
    expect(g.explanations.find((e) => e.rule === "proof_size_limit")?.weak).toBe(true);
  });
});

type Extra = { callInfoProofSize?: { value: string }; dryRunProofSize?: { value: string } };
const pfx = (p: Plan, legacy: string | undefined, extra: Extra = {}) => {
  const pre = pf(p, legacy);
  pre.steps = pre.steps.map((s) => ({ ...s, ...extra }));
  return pre;
};
const line = (g: ReturnType<typeof gatePolicy>) =>
  g.explanations.find((e) => e.rule === "proof_size_limit")?.message ?? "";
const codesOf = (g: ReturnType<typeof gatePolicy>) => g.blockedBy.map((b) => b.code);

describe("revive.call proof size sources (cap 200000)", () => {
  const p = plan(call("200000"));
  const run = (legacy: string | undefined, extra: Extra = {}, strict = false) =>
    gatePolicy(
      { policy: policy(), plan: p, facts, preflight: pfx(p, legacy, extra) },
      strict ? { requireMeasuredProofSize: true } : {},
    );
  it("nothing measured: allowed, dry run noted unknown, call info a limitation", () => {
    const g = run(undefined);
    expect(g.allowed).toBe(true);
    expect(line(g)).toMatch(
      /cap of 200000; no query_call_info proof size.*\(limitation\); the dry-run proof size is unknown \(0 or missing\) and was not used as a bound/,
    );
  });
  it("legacy proofSize 0 is unknown, allowed", () => {
    expect(run("0").allowed).toBe(true);
  });
  it("legacy proofSize 219909 (recorded runs #102853 / #102862) passes as legacy payment_queryInfo call info", () => {
    const g = run("219909");
    expect(g.allowed, JSON.stringify(g.blockedBy)).toBe(true);
    expect(line(g)).toMatch(
      /preflight proof size 219909 was read as legacy payment_queryInfo call info \(recorded run\): cap plus an overhead of 19909/,
    );
  });
  it.each(["200000", "1000"])(
    "legacy proofSize %s (not above the cap): PROOF_SIZE_CALL_INFO_MISMATCH",
    (v) => {
      expect(codesOf(run(v))).toEqual(["PROOF_SIZE_CALL_INFO_MISMATCH"]);
    },
  );
  it("legacy proofSize never satisfies requireMeasuredProofSize", () => {
    expect(codesOf(run("219909", {}, true))).toEqual(["PROOF_SIZE_CALL_INFO_MISSING"]);
  });
  it("callInfoProofSize > cap passes and satisfies strict mode; <= cap mismatches", () => {
    expect(run(undefined, { callInfoProofSize: { value: "207725" } }, true).allowed).toBe(true);
    expect(codesOf(run(undefined, { callInfoProofSize: { value: "200000" } }))).toEqual([
      "PROOF_SIZE_CALL_INFO_MISMATCH",
    ]);
    expect(codesOf(run(undefined, { callInfoProofSize: { value: "x" } }))).toEqual([
      "PROOF_SIZE_CALL_INFO_MISMATCH",
    ]);
    expect(codesOf(run(undefined, {}, true))).toEqual(["PROOF_SIZE_CALL_INFO_MISSING"]);
  });
  it("when a new field is present the legacy value is ignored", () => {
    // legacy 1000 would mismatch on its own; with explicit fields it is not read
    expect(run("1000", { callInfoProofSize: { value: "207725" } }).allowed).toBe(true);
    expect(run("1000", { dryRunProofSize: { value: "0" } }).allowed).toBe(true);
  });
  it("dryRunProofSize: <= cap passes, > cap PROOF_SIZE_ESTIMATE_OVER_LIMIT, 0 is unknown", () => {
    expect(run(undefined, { dryRunProofSize: { value: "200000" } }).allowed).toBe(true);
    const g = run(undefined, { dryRunProofSize: { value: "200001" } });
    expect(codesOf(g)).toEqual(["PROOF_SIZE_ESTIMATE_OVER_LIMIT"]);
    expect(g.blockedBy[0].message).toBe(
      "Proof size within limit (step call): Fail. Blocked: the dry run needs proof size 200001, more than the step's own limit of 200000, so it would run out.",
    );
    expect(line(run(undefined, { dryRunProofSize: { value: "0" } }))).toMatch(
      /dry-run proof size is unknown/,
    );
  });
  it("dry run alone never satisfies requireMeasuredProofSize", () => {
    expect(codesOf(run(undefined, { dryRunProofSize: { value: "190000" } }, true))).toEqual([
      "PROOF_SIZE_CALL_INFO_MISSING",
    ]);
  });
  it("missing step cap: CALL_GAS_LIMIT_MISSING", () => {
    const q = structuredClone(p);
    delete (q.steps[0].decodedArgs as Record<string, unknown>).proofSize;
    expect(codesOf(gate({ ...q, planDigest: H.planDigest(q) }))).toContain(
      "CALL_GAS_LIMIT_MISSING",
    );
  });
});

describe("chain UNKNOWN ({ unknown: true }, @seam/chain f5ae4ce) on the new fields", () => {
  const p = plan(call("200000"));
  const U = { unknown: true } as const;
  const run = (extra: Record<string, unknown>, strict = false) =>
    gatePolicy(
      { policy: policy(), plan: p, facts, preflight: pfx(p, "1000", extra as never) },
      strict ? { requireMeasuredProofSize: true } : {},
    );
  it("both UNKNOWN: unknown, never 0 or a number; allowed with a valid cap; legacy 1000 not read", () => {
    const g = run({ dryRunProofSize: U, callInfoProofSize: U });
    expect(g.allowed, JSON.stringify(g.blockedBy)).toBe(true);
    expect(line(g)).toMatch(/no query_call_info proof size.*dry-run proof size is unknown/);
  });
  it("callInfoProofSize UNKNOWN does not satisfy requireMeasuredProofSize", () => {
    expect(codesOf(run({ callInfoProofSize: U, dryRunProofSize: { value: "13" } }, true))).toEqual([
      "PROOF_SIZE_CALL_INFO_MISSING",
    ]);
  });
  it("deploy-like: dryRunProofSize UNKNOWN with a measured call info passes strict mode", () => {
    expect(run({ dryRunProofSize: U, callInfoProofSize: { value: "207725" } }, true).allowed).toBe(
      true,
    );
  });
});
