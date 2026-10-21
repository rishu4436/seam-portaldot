// P0: verifyPlan closes "edited plan + recomputed digest" on REAL committed V3 spec 3002 metadata (offline).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "../src/browser.js";
import * as node from "../src/index.js";
import type { ActionKind, Manifest, Plan, RuntimeFacts } from "../src/types.js";
import { ALICE, BOB, realFacts, withRollback } from "./helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only mutable JSON
type J = any;
const { compile, computePlanDigest, verifyPlan, assertPlanVerified, SeamCompileError } = browser;
const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const v3Hex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const v3 = (): RuntimeFacts =>
  browser.factsFromMetadata({
    metadataHex: v3Hex,
    genesisHash: "0x" + "11".repeat(32),
    tokenSymbol: "tPOT",
    tokenDecimals: 14,
  });
const CHARLIE = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";
const H = "0x" + "22".repeat(20);
const ARGS: Record<ActionKind, Record<string, unknown>> = {
  "assets.transfer": { assetId: "1", amount: "1000", recipient: BOB },
  "assets.mint": { assetId: "2", amount: "5", recipient: BOB },
  "contracts.call": {
    contract: BOB,
    value: "0",
    gasLimit: "5000000000",
    proofSize: "200000",
    storageDepositLimit: null,
    data: "0x633aa551",
  },
  "revive.call": {
    contract: H,
    value: "0",
    data: "0x00",
    gasLimit: "5000000000",
    proofSize: "200000",
    storageDepositLimit: "1000",
  },
  "nfts.mint": { collection: "0", item: "1", recipient: BOB },
  "revive.instantiate_with_code": {
    value: "0",
    gasLimit: "5000000000",
    proofSize: "200000",
    storageDepositLimit: "10000000000000",
    code: "0x50564d00deadbeef",
    data: "0x",
  },
  "revive.map_account": {},
};
const KINDS = Object.keys(ARGS) as ActionKind[];
const man = (kinds: ActionKind[], atomic = false): Manifest =>
  ({
    version: 1,
    signer: { type: "ss58", value: ALICE },
    actions: kinds.map((kind, i) => ({
      id: `a${i}`,
      kind,
      args: ARGS[kind],
      ...(atomic ? { preferredMode: "atomic" } : {}),
    })),
  }) as Manifest;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const redigest = (p: J): Plan => ({ ...p, planDigest: computePlanDigest(p) });
const codes = (r: ReturnType<typeof verifyPlan>) => (r.ok ? [] : r.issues.map((i) => i.code));
const facts = v3();
const transfer = man(["assets.transfer"]);
const transferPlan = compile(transfer, facts);
const payTo = (recipient: string, amount = "1000"): Manifest =>
  ({
    ...transfer,
    actions: [{ ...transfer.actions[0]!, args: { ...ARGS["assets.transfer"], recipient, amount } }],
  }) as Manifest;
const ATOMIC_OPTS = { allowAtomicUnverified: true };
const atomicM = man(["assets.transfer", "assets.mint"], true);
const atomicPlan = compile(atomicM, facts, ATOMIC_OPTS);

describe("exports", () => {
  it("browser and node share verifyPlan", () => {
    expect(browser.verifyPlan).toBe(node.verifyPlan);
    expect(browser.assertPlanVerified).toBe(node.assertPlanVerified);
  });
});

describe("honest plans pass on V3 spec 3002", () => {
  it.each(KINDS)("%s (sequential, with matching signed call)", (k) => {
    const m = man([k]);
    const p = compile(m, facts);
    expect(p.steps[0]!.status, p.steps[0]!.reason).toBe("ok");
    const r = verifyPlan(m, p, facts, { signedCalls: [p.steps[0]!.encodedCall!] });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, fingerprintDiffers: false });
  });
  it("multi-step sequential: all 7 kinds, signed calls as Uint8Array", () => {
    const m = man(KINDS);
    const p = compile(m, facts);
    expect(p.mode).toBe("sequential");
    const sc = p.steps.map((s) => Uint8Array.from(Buffer.from(s.encodedCall!.slice(2), "hex")));
    expect(verifyPlan(m, p, facts, { signedCalls: sc }).ok).toBe(true);
  });
  it("atomic batch_all", () => {
    expect(atomicPlan.mode).toBe("atomic_unverified");
    const r = verifyPlan(atomicM, atomicPlan, facts, {
      ...ATOMIC_OPTS,
      signedCalls: [atomicPlan.outerCall!.encodedCall],
    });
    expect(r.ok).toBe(true);
    expect(() => assertPlanVerified(atomicM, atomicPlan, facts, ATOMIC_OPTS)).not.toThrow();
  });
});

describe("attacks are blocked", () => {
  it("edited plan with recomputed digest pays someone else (decodedArgs say BOB, bytes pay CHARLIE)", () => {
    const evil = compile(payTo(CHARLIE), facts);
    const p: J = clone(transferPlan);
    p.steps[0].encodedCall = evil.steps[0]!.encodedCall; // same call-index prefix
    expect(p.steps[0].encodedCall.slice(0, 6)).toBe(
      transferPlan.steps[0]!.encodedCall!.slice(0, 6),
    );
    const forged = redigest(p);
    const r = verifyPlan(transfer, forged, facts);
    expect(codes(r)).toContain("STEP_BYTES_MISMATCH");
    expect(codes(r)).not.toContain("PLAN_DIGEST_INVALID");
    expect(() => assertPlanVerified(transfer, forged, facts)).toThrow(SeamCompileError);
  });
  it("decodedArgs recipient edited to an allow-listed one, bytes untouched, digest recomputed", () => {
    const pay = payTo(CHARLIE);
    const p: J = clone(compile(pay, facts));
    p.steps[0].decodedArgs.recipient = BOB;
    expect(codes(verifyPlan(pay, redigest(p), facts))).toContain("STEP_BODY_MISMATCH");
  });
  it("amount changed by 1 in the bytes", () => {
    const more = compile(payTo(BOB, "1001"), facts);
    const p: J = clone(transferPlan);
    p.steps[0].encodedCall = more.steps[0]!.encodedCall;
    expect(codes(verifyPlan(transfer, redigest(p), facts))).toContain("STEP_BYTES_MISMATCH");
  });
  it("edited signed bytes are blocked even when the plan is consistent", () => {
    const other = compile(payTo(CHARLIE), facts);
    const r = verifyPlan(transfer, transferPlan, facts, {
      signedCalls: [other.steps[0]!.encodedCall!],
    });
    expect(codes(r)).toEqual(["SIGNED_CALL_MISMATCH"]);
  });
  it("missing signed call / wrong count", () => {
    const m = man(["assets.transfer", "assets.mint"]);
    const p = compile(m, facts);
    expect(codes(verifyPlan(m, p, facts, { signedCalls: [p.steps[0]!.encodedCall!] }))).toEqual(
      expect.arrayContaining(["SIGNED_CALL_COUNT", "SIGNED_CALL_MISSING"]),
    );
    expect(codes(verifyPlan(m, p, facts, { signedCalls: [] }))).toContain("SIGNED_CALL_COUNT");
  });
  it("atomic outer call tampered (digest recomputed)", () => {
    const p: J = clone(atomicPlan);
    p.outerCall.encodedCall = p.outerCall.encodedCall.slice(0, -2) + "00";
    expect(codes(verifyPlan(atomicM, redigest(p), facts, ATOMIC_OPTS))).toContain(
      "OUTER_CALL_MISMATCH",
    );
  });
  it("atomic: signed call must be the fresh batch_all, not a step", () => {
    const r = verifyPlan(atomicM, atomicPlan, facts, {
      ...ATOMIC_OPTS,
      signedCalls: [atomicPlan.steps[0]!.encodedCall!],
    });
    expect(codes(r)).toEqual(["SIGNED_CALL_MISMATCH"]);
  });
  it("atomic plan downgraded to sequential by editing mode", () => {
    const p: J = clone(atomicPlan);
    p.mode = "sequential";
    delete p.outerCall;
    expect(verifyPlan(atomicM, redigest(p), facts, ATOMIC_OPTS).ok).toBe(false);
  });
  it("unrecomputed digest is reported", () => {
    const p: J = clone(transferPlan);
    p.steps[0].decodedArgs.amount = "1";
    expect(codes(verifyPlan(transfer, p, facts))).toContain("PLAN_DIGEST_INVALID");
  });
  it("a facts object swapped into the plan is ignored; only liveFacts count", () => {
    const pay = payTo(CHARLIE);
    const p: J = clone(transferPlan);
    p.facts = withRollback(realFacts(), "verified"); // attacker-supplied facts on the plan
    p.fingerprintDigest = p.facts.fingerprintDigest;
    const r = verifyPlan(transfer, redigest(p), facts);
    expect(r.ok).toBe(false); // extra field + foreign fingerprint: body differs from the fresh compile
    expect(codes(r)).toContain("PLAN_BODY_MISMATCH");
    // and swapping facts never makes a different payment verify
    expect(verifyPlan(pay, redigest(p), facts).ok).toBe(false);
  });
});

describe("fails closed", () => {
  it("facts without observed V3 metadata (mainnet spec 1002) for revive.call / nfts.mint", () => {
    for (const k of ["revive.call", "nfts.mint"] as ActionKind[]) {
      const m = man([k]);
      const p = compile(m, facts);
      const r = verifyPlan(m, p, withRollback(realFacts(), "verified"));
      expect(r.ok).toBe(false);
    }
  });
  it("tampered liveFacts / garbage plan never throws and never passes", () => {
    const bad: J = { ...facts, fingerprintDigest: "0x00" };
    expect(codes(verifyPlan(transfer, transferPlan, bad))).toEqual(["COMPILE_FAILED"]);
    expect(verifyPlan(transfer, {} as Plan, facts).ok).toBe(false);
    expect(verifyPlan(transfer, null as unknown as Plan, facts).ok).toBe(false);
    const p: J = clone(transferPlan);
    p.steps.push(clone(p.steps[0]));
    expect(codes(verifyPlan(transfer, redigest(p), facts))).toContain("STEP_COUNT_MISMATCH");
  });
  it("assert variant throws PLAN_MISMATCH", () => {
    const p: J = clone(transferPlan);
    p.steps[0].encodedCall = "0x00";
    try {
      assertPlanVerified(transfer, redigest(p), facts);
      throw new Error("no throw");
    } catch (e) {
      expect((e as InstanceType<typeof SeamCompileError>).codes).toContain("PLAN_MISMATCH");
    }
  });
});
