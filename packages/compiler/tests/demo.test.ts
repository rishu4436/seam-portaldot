import { describe, expect, it } from "vitest";
import { compile, loadRuntime } from "../src/index.js";
import {
  ALICE,
  BOB,
  BOB_HEX,
  demoManifest,
  metadataHex,
  realFacts,
  typesBundle,
  withRollback,
} from "./helpers.js";

describe("demo flow on the real spec 1002 snapshot: assets.transfer -> contracts.call -> assets.mint", () => {
  const facts = realFacts();
  const { registry } = loadRuntime(metadataHex, typesBundle);

  it("compiles every step with indexes from metadata", () => {
    const p = compile(demoManifest(), facts);
    expect(p.mode).toBe("sequential"); // rollback not verified yet on this runtime
    expect(p.signer).toEqual({
      type: "ss58",
      value: ALICE,
      publicKey: "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
    });
    expect(p.steps.map((s) => [s.capability, s.palletIndex, s.callIndex, s.status])).toEqual([
      ["Assets.transfer_keep_alive", 26, 6, "ok"],
      ["Contracts.call", 13, 0, "ok"],
      ["Assets.mint", 26, 3, "ok"],
    ]);
  });

  it("encoded calls decode back to exactly the requested arguments", () => {
    const p = compile(demoManifest(), facts);
    const [pay, call, receipt] = p.steps.map((s) => registry.createType("Call", s.encodedCall!));

    expect(`${pay!.section}.${pay!.method}`).toBe("assets.transferKeepAlive");
    expect(pay!.toJSON()).toMatchObject({
      args: { id: 1, target: { id: BOB }, amount: 2500000000000000 },
    });
    expect((pay!.args[1] as any).value.toHex()).toBe(BOB_HEX);

    expect(`${call!.section}.${call!.method}`).toBe("contracts.call");
    const [dest, value, gas, data] = call!.args as any[];
    expect(dest.type).toBe("Id");
    expect(dest.value.toHex()).toBe(BOB_HEX);
    expect(value.toString()).toBe("0");
    expect(gas.toString()).toBe("5000000000");
    expect(data.toHex()).toBe("0x633aa551");

    expect(`${receipt!.section}.${receipt!.method}`).toBe("assets.mint");
    expect((receipt!.args[0] as any).toString()).toBe("2");
    expect((receipt!.args[2] as any).toString()).toBe("1");
  });

  it("exact bytes for the first step (hand-checked SCALE)", () => {
    const p = compile(demoManifest(), facts);
    // 1a 06 = Assets.transfer_keep_alive; 04 = Compact(1); 00 = MultiAddress::Id; <32 bytes>; Compact(2.5e15)
    expect(p.steps[0]!.encodedCall!.startsWith(`0x1a060400${BOB_HEX.slice(2)}`)).toBe(true);
  });

  it("with verified rollback, outerCall is one batch_all of the three calls in order", () => {
    const p = compile(demoManifest(), withRollback(facts, "verified"));
    expect(p.mode).toBe("atomic_verified");
    const outer = registry.createType("Call", p.outerCall!.encodedCall);
    expect(`${outer.section}.${outer.method}`).toBe("utility.batchAll");
    const inner = (outer.args[0] as any).map((c: any) => c.toHex());
    expect(inner).toEqual(p.steps.map((s) => s.encodedCall));
  });
});
