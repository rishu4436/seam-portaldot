// Preflight for revive.call / nfts.mint. Offline (FakeNode). Positive fixtures are SYNTHETIC (see syntheticV3.ts):
// nothing here is observed on, or proves anything about, a real Portaldot V3 chain.
import { describe, expect, it } from "vitest";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { keccakAsU8a } from "@polkadot/util-crypto";
import { compile, type Manifest, type Plan } from "@seam/compiler";
import {
  decodeRuntime,
  preflight,
  runtimeApiId,
  storageKey,
  type ChainInputs,
} from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { ALICE, ALICE_HEX } from "./helpers.js";
import { REVIVE_API_ID, devFacts, devHex, devInputs, syntheticV3Hex } from "./syntheticV3.js";

const H160 = "0x1111111111111111111111111111111111111111";
const manifest = (actions: Manifest["actions"]): Manifest => ({
  version: 1,
  signer: { type: "ss58", value: ALICE },
  actions,
});
const reviveAction = {
  id: "rv",
  kind: "revive.call" as const,
  args: {
    contract: H160,
    value: "0",
    data: "0x1234",
    gasLimit: "5000000000",
    proofSize: "1000000",
    storageDepositLimit: "100",
  },
};
const nftAction = {
  id: "nft",
  kind: "nfts.mint" as const,
  args: { collection: "1", item: "7", recipient: ALICE },
};

class Node extends FakeNode {
  constructor(
    inputs: ChainInputs,
    facts: ReturnType<typeof devFacts>,
    private storage: Record<string, string> = {},
    private failQuery = false,
  ) {
    super({ inputs, facts });
  }
  async send<T>(method: string, params: unknown[]): Promise<T> {
    if (this.failQuery && method === "payment_queryInfo") throw new Error("Method not found");
    if (method === "state_getStorage" && this.storage[String(params[0])] !== undefined)
      return this.storage[String(params[0])] as T;
    return super.send<T>(method, params);
  }
}

const synth = (o: Parameters<typeof syntheticV3Hex>[0], api = false) => {
  const inputs = devInputs(syntheticV3Hex(o), api);
  return { inputs, facts: devFacts(inputs) };
};

describe("fixtures", () => {
  it("REVIVE_API_ID matches runtimeApiId", () =>
    expect(runtimeApiId("ReviveApi")).toBe(REVIVE_API_ID));
});

describe("real dev-node metadata (spec 100, older Revive layout; NOT V3)", () => {
  const inputs = devInputs(devHex);
  const facts = devFacts(inputs);
  const plan = compile(manifest([reviveAction]), facts);
  it("compiler says V3_ARG_SHAPE_MISMATCH; preflight passes it through, simulates nothing, never throws", async () => {
    expect(plan.steps[0]!.reasonCode).toBe("V3_ARG_SHAPE_MISMATCH");
    const node = new Node(inputs, facts);
    const r = await preflight(node, plan, facts);
    expect(r.coverage.steps).toEqual([
      {
        actionId: "rv",
        basis: "unobserved",
        proves: "nothing",
        reasonCode: "V3_ARG_SHAPE_MISMATCH",
      },
    ]);
    expect(r.coverage.wholePlan).toBe("none");
    expect(r.v3!.steps[0]).toMatchObject({
      compiler: "unavailable",
      reasonCode: "V3_ARG_SHAPE_MISMATCH",
      reason: plan.steps[0]!.reason,
      simulation: { attempted: false, via: [] },
    });
    expect(r.result.steps[0]).toMatchObject({ dryRun: "unknown", fee: { unknown: true } });
    expect(r.result.steps[0]!.note).toContain("V3_ARG_SHAPE_MISMATCH");
    const sim = ["payment_queryInfo", "system_dryRun", "contracts_call", "state_call"];
    expect(node.log.filter((c) => sim.includes(c.method))).toEqual([]);
    expect(r.v3!.accountMapping).toMatchObject({ status: "unknown", mapAccountInMetadata: false });
  });
  it("NO_OBSERVED_V3_METADATA (mainnet-like facts without Revive/Nfts) passes through for both kinds", async () => {
    const p = compile(manifest([nftAction]), facts);
    expect(p.steps[0]!.reasonCode).toBe("NO_OBSERVED_V3_METADATA");
    const r = await preflight(new Node(inputs, facts), p, facts);
    expect(r.coverage.steps[0]).toMatchObject({
      basis: "unobserved",
      proves: "nothing",
      reasonCode: "NO_OBSERVED_V3_METADATA",
    });
    expect(r.v3!.accountMapping).toBeUndefined(); // no revive step
  });
  it("an unreachable node becomes a reason, not a throw", async () => {
    const node = new Node(inputs, facts);
    node.breakRpc("chain_getBlockHash", "chain_getHeader", "system_accountNextIndex");
    const r = await preflight(node, plan, facts);
    expect(r.v3!.chainReadError).toMatch(/placeholders/);
    expect(r.v3!.accountMapping!.status).toBe("unknown");
    expect(r.coverage.steps[0]!.reasonCode).toBe("V3_ARG_SHAPE_MISMATCH");
  });
});

describe("SYNTHETIC V3-shaped metadata: encoded revive.call and nfts.mint", () => {
  it("revive.call: node estimate is reported but coverage stays unobserved/nothing; dryRun never 'ok'", async () => {
    const { inputs, facts } = synth({ h160: true, mapAccount: true }, true);
    const plan = compile(manifest([reviveAction]), facts);
    expect(plan.steps[0]!.encodedCall).toMatch(/^0x0900/);
    const node = new Node(inputs, facts);
    const r = await preflight(node, plan, facts, { nonce: 0 });
    expect(r.coverage.steps[0]).toEqual({ actionId: "rv", basis: "unobserved", proves: "nothing" });
    expect(r.coverage.wholePlan).toBe("none");
    expect(r.result.steps[0]!.fee).toEqual({ value: "1500000000" });
    expect(r.result.steps[0]!.dryRun).toBe("unknown");
    expect(r.v3!.steps[0]).toMatchObject({
      compiler: "encoded",
      reviveApi: "listed",
      simulation: { attempted: true, via: ["payment_queryInfo"] },
    });
    expect(node.log.some((c) => c.method === "state_call")).toBe(false); // ReviveApi_call never used
    expect(r.v3!.accountMapping).toMatchObject({ status: "unknown", mapAccountInMetadata: true });
  });
  it("runtime without payment_queryInfo: no estimate, attempted false, no throw", async () => {
    const { inputs, facts } = synth({ h160: true });
    const plan = compile(manifest([reviveAction]), facts);
    const r = await preflight(new Node(inputs, facts, {}, true), plan, facts, { nonce: 0 });
    expect(r.v3!.steps[0]!.simulation.attempted).toBe(false);
    expect(r.v3!.steps[0]!.reviveApi).toBe("not_listed");
    expect(r.result.steps[0]!.fee).toEqual({ unknown: true });
  });
  it("nfts.mint: unobserved/nothing, no accountMapping", async () => {
    const { inputs, facts } = synth({ nfts: true });
    const plan = compile(manifest([nftAction]), facts);
    expect(plan.steps[0]!.status).toBe("ok");
    const r = await preflight(new Node(inputs, facts), plan, facts, { nonce: 0 });
    expect(r.coverage.steps[0]).toMatchObject({ basis: "unobserved", proves: "nothing" });
    expect(r.v3!.accountMapping).toBeUndefined();
    expect(r.v3!.steps[0]!.reviveApi).toBeUndefined();
  });
  it("account mapping: mapped only when metadata has map_account AND chain state maps the signer back", async () => {
    const { inputs, facts } = synth({ h160: true, mapAccount: true, originalAccount: true });
    const plan: Plan = compile(manifest([reviveAction]), facts);
    const q = (
      decodeRuntime(facts).decorated().query as unknown as Record<
        string,
        Record<string, Parameters<typeof storageKey>[0]>
      >
    ).revive!.originalAccount!;
    const h160 = u8aToHex(keccakAsU8a(hexToU8a(ALICE_HEX)).slice(12));
    const key = storageKey(q, h160);
    const mapped = await preflight(new Node(inputs, facts, { [key]: ALICE_HEX }), plan, facts, {
      nonce: 0,
    });
    expect(mapped.v3!.accountMapping!.status).toBe("mapped");
    const other = `0x${"22".repeat(32)}`;
    const wrong = await preflight(new Node(inputs, facts, { [key]: other }), plan, facts, {
      nonce: 0,
    });
    expect(wrong.v3!.accountMapping!.status).toBe("unknown");
    const absent = await preflight(new Node(inputs, facts), plan, facts, { nonce: 0 });
    expect(absent.v3!.accountMapping!.status).toBe("unknown");
  });
  it("a synthetic atomic plan whose signed batch would dry-run ok still reports wholePlan none", async () => {
    const { inputs, facts } = synth({ h160: true });
    const m = manifest([reviveAction, { ...reviveAction, id: "rv2" }]);
    m.actions[0]!.preferredMode = "atomic";
    const plan = compile(m, facts, { allowAtomicUnverified: true });
    const r = await preflight(new Node(inputs, facts), plan, facts, { nonce: 0 });
    expect(r.coverage.wholePlan).toBe("none");
    expect(r.coverage.steps.every((s) => s.basis === "unobserved")).toBe(true);
  });
});
