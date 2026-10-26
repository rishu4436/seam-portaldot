// dryRunProofSize / callInfoProofSize on Revive steps. Offline: FakeNode / a mocked RPC client. The synthetic
// V3-shaped metadata proves nothing about a real Portaldot V3 chain; the numbers below are only fixtures
// (13 / 1007725 are the V3 #203484 revive.call readings in evidence/testnet-v3/revive-call-proof-size-*).
import { describe, expect, it } from "vitest";
import { compile, type Hex, type Manifest } from "@seam/compiler";
import { preflight, reviveProofSizes, type ChainInputs, type RpcClient } from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { ALICE, ALICE_HEX } from "./helpers.js";
import { devFacts, devInputs, syntheticV3Hex } from "./syntheticV3.js";

const compact = (n: bigint): string => {
  const le = (v: bigint, b: number) =>
    Array.from({ length: b }, (_, i) =>
      ((v >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0"),
    ).join("");
  if (n < 64n) return le(n << 2n, 1);
  if (n < 16384n) return le((n << 2n) | 1n, 2);
  if (n < 2n ** 30n) return le((n << 2n) | 2n, 4);
  const bytes = le(n, 8).replace(/(00)+$/, "") || "00";
  return (((bytes.length / 2 - 4) << 2) | 3).toString(16).padStart(2, "0") + bytes;
};
const weight = (rt: bigint, ps: bigint) => compact(rt) + compact(ps);
/** ContractResult prefix: weight_consumed, weight_required, then the rest (ignored by the decoder). */
const dryRunAnswer = (rt: bigint, ps: bigint) => `0x${weight(rt, ps)}${weight(rt, ps)}00`;
/** RuntimeDispatchInfo: weight, class (Normal), partial_fee u128. */
const callInfoAnswer = (rt: bigint, ps: bigint) => `0x${weight(rt, ps)}00${"00".repeat(16)}`;

const manifest = (actions: Manifest["actions"]): Manifest => ({
  version: 1,
  signer: { type: "ss58", value: ALICE },
  actions,
});
const reviveAction = {
  id: "rv",
  kind: "revive.call" as const,
  args: {
    contract: "0x86b9cc2d456eed16a6872e1d5646f606a59cd95b",
    value: "0",
    data: "0x12345678",
    gasLimit: "6620437",
    proofSize: "1000000",
    storageDepositLimit: "0",
  },
};

class Node extends FakeNode {
  constructor(
    inputs: ChainInputs,
    facts: ReturnType<typeof devFacts>,
    private answers: Record<string, string | Error>,
  ) {
    super({ inputs, facts });
  }
  async send<T>(method: string, params: unknown[]): Promise<T> {
    if (method === "state_call") {
      this.log.push({ method, params });
      const a = this.answers[String(params[0])];
      if (a === undefined || a instanceof Error) throw a ?? new Error("Method not found");
      return a as T;
    }
    return super.send<T>(method, params);
  }
}
const setup = () => {
  const inputs = devInputs(syntheticV3Hex({ h160: true, mapAccount: true }), true);
  const facts = devFacts(inputs);
  return { inputs, facts, plan: compile(manifest([reviveAction]), facts) };
};

describe("preflight: Revive proof sizes", () => {
  it("revive.call with non-zero weight_required gives a known dryRunProofSize, from ReviveApi_call", async () => {
    const { inputs, facts, plan } = setup();
    const node = new Node(inputs, facts, {
      ReviveApi_call: dryRunAnswer(1361082779n, 12998n),
      TransactionPaymentCallApi_query_call_info: callInfoAnswer(2139922334n, 1007725n),
    });
    const r = await preflight(node, plan, facts, { nonce: 0 });
    const st = r.result.steps[0]!;
    expect(st.dryRunProofSize).toEqual({ value: "12998" });
    expect(st.callInfoProofSize).toEqual({ value: "1007725" });
    const call = node.log.find((c) => (c.params as string[])[0] === "ReviveApi_call")!;
    const params = (call.params as string[])[1]!;
    // origin = plan signer, dest = the step's contract, value 0, gas None, deposit None, input = the step's data.
    expect(params).toBe(
      `${ALICE_HEX}86b9cc2d456eed16a6872e1d5646f606a59cd95b${"00".repeat(16)}00001012345678`,
    );
    expect((call.params as string[])[2]).toBe(r.atBlock.hash);
  });
  it("callInfoProofSize is read from query_call_info (encoded call + u32 length), not from payment_queryInfo", async () => {
    const { inputs, facts, plan } = setup();
    const node = new Node(inputs, facts, {
      TransactionPaymentCallApi_query_call_info: callInfoAnswer(5n, 1006823n),
    });
    const r = await preflight(node, plan, facts, { nonce: 0 });
    expect(r.result.steps[0]!.callInfoProofSize).toEqual({ value: "1006823" });
    const q = node.log.find(
      (c) => (c.params as string[])[0] === "TransactionPaymentCallApi_query_call_info",
    )!;
    expect((q.params as string[])[1]!.startsWith(plan.steps[0]!.encodedCall!)).toBe(true);
    expect((q.params as string[])[1]!.length).toBe(plan.steps[0]!.encodedCall!.length + 8);
  });
  it("a missing node answer gives UNKNOWN with a note, never a fake number", async () => {
    const { inputs, facts, plan } = setup();
    const r = await preflight(new Node(inputs, facts, {}), plan, facts, { nonce: 0 });
    const st = r.result.steps[0]!;
    expect(st.dryRunProofSize).toEqual({ unknown: true });
    expect(st.callInfoProofSize).toEqual({ unknown: true });
    expect(st.note).toMatch(/dry-run proof size: unknown, ReviveApi_call gave no answer/);
    expect(st.note).toMatch(/call-info proof size: unknown, query_call_info gave no answer/);
  });
  it("the old proofSize (payment_queryInfo) is unchanged by the new fields", async () => {
    const { inputs, facts, plan } = setup();
    const a = await preflight(new Node(inputs, facts, {}), plan, facts, { nonce: 0 });
    const b = await preflight(
      new Node(inputs, facts, {
        ReviveApi_call: dryRunAnswer(1n, 77n),
        TransactionPaymentCallApi_query_call_info: callInfoAnswer(1n, 99n),
      }),
      plan,
      facts,
      { nonce: 0 },
    );
    expect(b.result.steps[0]!.proofSize).toEqual(a.result.steps[0]!.proofSize);
    expect(b.result.steps[0]!.proofSize).not.toEqual({ value: "99" });
    expect(b.result.steps[0]!.dryRunProofSize).toEqual({ value: "77" });
  });
  it("non-Revive steps omit both fields (they are not UNKNOWN placeholders)", async () => {
    const { inputs, facts } = setup();
    const plan = compile(
      manifest([
        {
          id: "t",
          kind: "assets.transfer",
          args: { assetId: "1", recipient: ALICE, amount: "1" },
        } as Manifest["actions"][number],
      ]),
      facts,
    );
    const r = await preflight(new Node(inputs, facts, {}), plan, facts, { nonce: 0 });
    expect(r.result.steps[0]).not.toHaveProperty("dryRunProofSize");
    expect(r.result.steps[0]).not.toHaveProperty("callInfoProofSize");
  });
});

describe("reviveProofSizes (instantiate)", () => {
  const client = (answers: Record<string, string>): RpcClient & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls,
      async send<T>(method: string, params: unknown[]): Promise<T> {
        calls.push([method, ...params]);
        const a = answers[String(params[0])];
        if (method !== "state_call" || a === undefined) throw new Error("Method not found");
        return a as T;
      },
    } as unknown as RpcClient & { calls: unknown[][] };
  };
  const step = {
    kind: "revive.instantiate_with_code" as const,
    decodedArgs: { value: "0", code: "0x00", data: "0x" },
    encodedCall: "0x5003" as const,
  };
  it("instantiate weight_required.proof_size 0 is UNKNOWN with a note, never known(0)", async () => {
    const c = client({
      ReviveApi_instantiate: dryRunAnswer(663430n, 0n),
      TransactionPaymentCallApi_query_call_info: callInfoAnswer(1n, 1006823n),
    });
    const r = await reviveProofSizes(c, step, ALICE_HEX as Hex, "0xab" as Hex, 120);
    expect(r.dryRunProofSize).toEqual({ unknown: true });
    expect(r.notes.join(";")).toMatch(
      /ReviveApi_instantiate weight_required.proof_size is 0 \(not metered/,
    );
    expect(r.callInfoProofSize).toEqual({ value: "1006823" });
    expect(c.calls[0]![1]).toBe("ReviveApi_instantiate");
    // origin, value, gas None, deposit None, Upload(code), data, salt None
    expect(c.calls[0]![2]).toBe(`${ALICE_HEX}${"00".repeat(16)}00000004000000`);
  });
  it("instantiate with no node answer is UNKNOWN", async () => {
    const r = await reviveProofSizes(client({}), step, ALICE_HEX as Hex, "0xab" as Hex, 120);
    expect(r.dryRunProofSize).toEqual({ unknown: true });
    expect(r.callInfoProofSize).toEqual({ unknown: true });
  });
});
