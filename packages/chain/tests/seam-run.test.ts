import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helpers
import {
  isWeightV2,
  makeGuard,
  assertNotMainnetUrl,
  explainRefusedDryRun,
  flowEffects,
} from "../scripts/seam-run.mjs";
// @ts-expect-error plain .mjs helpers
import { ABIS, rollbackActions, settleEffect } from "../scripts/devnode/flow.mjs";

describe("seam-run helpers", () => {
  it("tells the V13 single Weight from the V14 Weight V2 shape", () => {
    expect(isWeightV2("Compact<Weight>")).toBe(false);
    expect(isWeightV2("SpWeightsWeightV2Weight")).toBe(true);
    expect(isWeightV2(undefined)).toBe(false);
  });
  it("the evidence guard refuses signatures, keys, dev paths and the signer secret itself", () => {
    const g = makeGuard(["correct horse battery staple"]);
    expect(g({ ok: true, txHash: "0x01" })).toContain("txHash");
    expect(() => g({ signature: "0x00" })).toThrow(/signature/);
    expect(() => g({ a: { seed: "x" } })).toThrow(/seed/);
    expect(() => g({ note: "derived from //Alice" })).toThrow(/dev derivation/);
    expect(() => g({ note: "phrase correct horse battery staple here" })).toThrow(/secret/);
  });
  it("refuses the mainnet endpoint", () => {
    expect(() => assertNotMainnetUrl("wss://mainnet.portaldot.io")).toThrow(/mainnet/);
    expect(() => assertNotMainnetUrl("ws://127.0.0.1:9966")).not.toThrow();
  });
});

describe("seam-run setup and flow inputs (offline)", () => {
  it("a refused dry run carries the node's detail, and on a genesis-only chain says why BadProof", () => {
    const bad = { detail: "invalid transaction: BadProof" };
    expect(explainRefusedDryRun("failed", bad, { number: 0, hash: "0x00" })).toMatch(
      /^signed dry run said failed \(invalid transaction: BadProof\); nothing was sent; the chain is still at its genesis block/,
    );
    expect(explainRefusedDryRun("failed", bad, { number: 5, hash: "0x00" })).toBe(
      "signed dry run said failed (invalid transaction: BadProof); nothing was sent",
    );
    expect(explainRefusedDryRun("failed", undefined, undefined)).toBe(
      "signed dry run said failed; nothing was sent",
    );
  });
  it("the sequential and atomic flows commit the settle effect for the signer; a raw call gets none", () => {
    const alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    expect(flowEffects({ address: alice })).toEqual({ call: settleEffect(alice) });
    expect(flowEffects({ address: alice }).call.emittedData).toMatch(
      /^0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d0700000000000000c4090000/,
    );
    expect(flowEffects({ address: alice, rawCall: { data: "0x01020304" } })).toBeUndefined();
  });
  it("settleEffect fails loudly when the seam_demo Settled event layout changes", () => {
    const ev = ABIS.seam_demo.spec.events.find((e: { label: string }) => e.label === "Settled");
    const saved = ev.args;
    try {
      ev.args = [saved[0], saved[2], saved[1]]; // fields reordered
      expect(() => settleEffect("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY")).toThrow(
        /Settled event layout changed/,
      );
      ev.args = [saved[0], saved[1], { ...saved[2], type: { ...saved[2].type, type: 3 } }]; // amount u128 -> u64
      expect(() => settleEffect("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY")).toThrow(
        /amount:u64/,
      );
    } finally {
      ev.args = saved;
    }
  });
  it("the rollback batch keeps the raw-call shape on a raw-call runtime, so its proof still covers contracts.call", () => {
    const a = rollbackActions({
      bob: "b",
      charlie: "c",
      contract: "0x01",
      callData: "0x01020304",
      gas: { gasLimit: "1", v13: true },
    });
    expect(a.map((x: { kind: string }) => x.kind)).toEqual([
      "assets.transfer",
      "contracts.call",
      "assets.mint",
      "assets.mint",
    ]);
    expect(a[1].args).toEqual({ contract: "0x01", value: "0", gasLimit: "1", data: "0x01020304" });
  });
});
