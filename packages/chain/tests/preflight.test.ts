import { describe, expect, it, beforeAll } from "vitest";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { assembleSignedExtrinsic, buildSigningRequests, preflight } from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import {
  ALICE,
  CHECKPOINT,
  atomicPlan,
  demoPlan,
  devKeys,
  snapshotFacts,
  snapshotInputs,
} from "./helpers.js";

const facts = snapshotFacts();
const node = (o: Partial<ConstructorParameters<typeof FakeNode>[0]> = {}) =>
  new FakeNode({ inputs: snapshotInputs(), facts, ...o });

describe("preflight (fake node replaying the snapshot)", () => {
  it("returns the agreed PreflightResult with node-reported fee and weight, nonce from the node", async () => {
    const n = node({ existingAssets: ["1", "2"] });
    const r = await preflight(n, demoPlan(), facts);
    expect(r.nonce).toBe(0);
    expect(r.nonceSource).toBe("node");
    expect(r.atBlock.number).toBe(2721455);
    expect(r.result.steps.map((s) => s.actionId)).toEqual(["pay", "call", "receipt"]);
    for (const s of r.result.steps) {
      expect(s.weight).toEqual({ value: "200000000" });
      expect(s.fee).toEqual({ value: "1500000000" });
      expect(s.storageDeposit).toEqual({ unknown: true });
    }
    expect(r.result.totalFee).toEqual({ value: "4500000000" });
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["unknown", "ok", "unknown"]);
    expect(r.transactions.map((t) => t.nonce)).toEqual([0, 1, 2]);
    // fee estimation used fake-signed extrinsics with consecutive nonces, never submitted
    expect(n.log.filter((c) => c.method === "payment_queryInfo")).toHaveLength(3);
    expect(n.submitted).toHaveLength(0);
    const req = n.log.find((c) => c.method === "contracts_call")!.params[0] as Record<
      string,
      string
    >;
    expect(req).toMatchObject({
      origin: ALICE,
      value: "0x0",
      gasLimit: "0x12a05f200",
      inputData: "0x633aa551",
    });
  });

  it("marks failures from the node: missing assets and a contract dry-run error, decoded", async () => {
    const n = node({
      contractsCall: {
        debugMessage: "",
        gasConsumed: 0,
        result: { Err: { Module: { index: 13, error: 12, message: null } } },
      },
    });
    const r = await preflight(n, demoPlan(), facts);
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["failed", "failed", "failed"]);
    expect(r.result.steps[0]!.note).toMatch(/asset 1 does not exist/);
    expect(r.result.steps[1]!.note).toMatch(/contracts\.ContractNotFound/);
  });

  it("a reverted contract (flags & 1) fails the dry run", async () => {
    const r = await preflight(
      node({
        existingAssets: ["1", "2"],
        contractsCall: { gasConsumed: 5, result: { Ok: { flags: 1, data: "0x" } } },
      }),
      demoPlan(),
      facts,
    );
    expect(r.result.steps[1]!.dryRun).toBe("failed");
  });

  it("atomic plans: the batch fee is the total; each step gets its standalone weight", async () => {
    const { plan, facts: f } = atomicPlan();
    const n = new FakeNode({ inputs: snapshotInputs(), facts: f, existingAssets: ["1", "2"] });
    const r = await preflight(n, plan, f);
    expect(r.transactions).toHaveLength(1);
    expect(r.result.totalFee).toEqual({ value: "1500000000" });
    expect(
      r.result.steps.every((s) => s.weight.value === "200000000" && /atomic/.test(s.note!)),
    ).toBe(true);
  });

  it("uses system_dryRun only with real signed extrinsics", async () => {
    const keys = await devKeys();
    const plan = demoPlan();
    const reqs = buildSigningRequests(plan, facts, {
      signer: ALICE,
      nonce: 0,
      mortalityBlocks: 64,
      checkpoint: CHECKPOINT,
      expiresAt: "x",
    });
    const signed = reqs.map((q) =>
      assembleSignedExtrinsic(
        q.payload,
        u8aToHex(keys.alice.sign(hexToU8a(q.signBytesHex), { withType: true })),
        facts,
      ),
    );
    const n = node({ existingAssets: ["1", "2"] });
    const r = await preflight(n, plan, facts, { signedExtrinsics: signed, nonce: 0 });
    expect(r.nonceSource).toBe("caller");
    // tx 1 dry-runs ok; txs 2 and 3 have future nonces until tx 1 is on chain, so they stay unknown
    // ('call' is still ok from its contracts_call dry run)
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["ok", "ok", "unknown"]);
    expect(r.result.steps[2]!.note).toMatch(/nonce is in the future/);
    expect(n.log.filter((c) => c.method === "system_dryRun")).toHaveLength(3);
  });

  it("refuses when the node runs a different runtime than the facts", async () => {
    const inputs = snapshotInputs();
    const n = new FakeNode({
      inputs: { ...inputs, runtimeVersion: { ...inputs.runtimeVersion, specVersion: 1003 } },
      facts,
    });
    await expect(preflight(n, demoPlan(), facts)).rejects.toThrow(/RUNTIME_CHANGED/);
  });
});

describe("preflight proof size (steps[].proofSize)", () => {
  it("Weight V1 (the spec 1002 snapshot): unknown with a note, never 0", async () => {
    const r = await preflight(node({ existingAssets: ["1", "2"] }), demoPlan(), facts);
    for (const s of r.result.steps) {
      expect(s.proofSize).toEqual({ unknown: true });
      expect(s.note).toMatch(/proof size: unknown, this runtime has no proof size \(Weight V1/);
    }
    expect(
      r.transactions.every(
        (t) => t.queryInfo?.weightVersion === 1 && t.queryInfo.proofSize === undefined,
      ),
    ).toBe(true);
  });

  it("Weight V2 answer {ref_time, proof_size} (RPC JSON): weight is ref_time, proofSize is proof_size", async () => {
    const r = await preflight(
      node({
        existingAssets: ["1", "2"],
        queryInfoWeight: { ref_time: 540059000, proof_size: 6208 },
      }),
      demoPlan(),
      facts,
    );
    for (const s of r.result.steps) {
      expect(s.weight).toEqual({ value: "540059000" });
      expect(s.proofSize).toEqual({ value: "6208" });
      expect(s.note).not.toMatch(/proof size: unknown/);
    }
    expect(r.transactions[0]!.queryInfo).toMatchObject({ weightVersion: 2, proofSize: "6208" });
  });

  it("camelCase {refTime, proofSize} and hex numbers are read too; atomic steps get their standalone proof size", async () => {
    const { plan, facts: f } = atomicPlan();
    const r = await preflight(
      new FakeNode({
        inputs: snapshotInputs(),
        facts: f,
        existingAssets: ["1", "2"],
        queryInfoWeight: { refTime: "0x2540be400", proofSize: "0x1000" },
      }),
      plan,
      f,
    );
    expect(r.result.steps.map((s) => s.proofSize)).toEqual([
      { value: "4096" },
      { value: "4096" },
      { value: "4096" },
    ]);
    expect(r.result.steps[0]!.weight).toEqual({ value: "10000000000" });
  });

  it("a two-part weight without proof_size stays unknown", async () => {
    const r = await preflight(
      node({ existingAssets: ["1", "2"], queryInfoWeight: { ref_time: 1000 } }),
      demoPlan(),
      facts,
    );
    expect(r.result.steps[0]!.proofSize).toEqual({ unknown: true });
    expect(r.result.steps[0]!.note).toMatch(/two-part weight without proof_size/);
  });
});

describe("storage keys", () => {
  it("storageKey strips the compact length prefix polkadot.js puts on decorated keys", async () => {
    const { storageKey, decodeRuntime } = await import("../src/index.js");
    const { snapshotFacts } = await import("./helpers.js");
    const q = (decodeRuntime(snapshotFacts()).decorated().query as any).assets.asset;
    const key = storageKey(q, 1);
    // twox128("Assets") ++ twox128("Asset") ++ blake2_128_concat(u32 1)
    expect(
      key.startsWith("0x682a59d51ab9e48a8c8cc418ff9708d2d34371a193a751eea5883e9553457b2e"),
    ).toBe(true);
    expect(key.endsWith("01000000")).toBe(true);
    expect((key.length - 2) / 2).toBe(16 + 16 + 16 + 4);
  });
});
