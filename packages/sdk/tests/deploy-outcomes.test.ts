import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex, PlanStep } from "@seam/compiler";
import {
  decodeV3InstantiateWithCode,
  instantiateCodeHash,
  reviveAddressOf,
  verifyMapAccountOutcome,
  verifyReviveInstantiateOutcome,
  verifyStep,
  V3_SPEC3002_REVIVE_INSTANTIATED_SHAPE,
  type ChainEvent,
  type StepOutcome,
} from "../src/index.js";

const runs = (f: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../evidence/testnet-v3/runs/${f}`, import.meta.url)),
      "utf8",
    ),
  );
// REAL records from the hosted V3 testnet (spec 3002).
const DEPLOY = runs("revive-deploy-1792412368928.json");
const MAP = runs("map-account-1792408724499.json");
const RUNTIME = runs("plan-revive-call-1792412445848.json").fingerprint; // portaldot-v3 spec 3002
const SIGNER = "0x80270a11d7b2e2b8b2dfb1ca3a45ab3b3f2339613709108c72f04074a8048467" as Hex;
const H160 = "0x81ed1dfbec067703fdca3daa7efcbeff4ba101ec";
const OTHER_RUNTIME = { ...RUNTIME, specName: "portaldot", specVersion: 1002 };

const ev = (r: { events: { pallet: string; name: string; args: string[] }[] }): ChainEvent[] =>
  r.events.map((e) => ({ pallet: e.pallet, name: e.name, args: e.args }));

const PLANNED = {
  palletIndex: 80,
  callIndex: 3,
  codeHash: instantiateCodeHash(DEPLOY.evmInitCode),
  value: "0",
  gasLimit: "50000000000",
  proofSize: "1000000",
  storageDepositLimit: "1500000000000000",
};
const deployIn = (over: Partial<Parameters<typeof verifyReviveInstantiateOutcome>[0]> = {}) => ({
  status: "finalized" as const,
  events: ev(DEPLOY),
  callHex: DEPLOY.callHex as Hex,
  runtime: RUNTIME,
  signerAccountId: SIGNER,
  ...over,
});

describe("REAL V3 evidence: observed shapes", () => {
  it("the signer's mapped H160 is the derivedH160 and the Instantiated deployer", () => {
    expect(reviveAddressOf(SIGNER)).toBe(H160);
    expect(MAP.derivedH160).toBe(H160);
    const inst = DEPLOY.events.find(
      (e: { pallet: string; name: string }) => e.pallet === "Revive" && e.name === "Instantiated",
    );
    expect(inst.argTypes).toEqual(["H160", "H160"]);
    expect(inst.args[V3_SPEC3002_REVIVE_INSTANTIATED_SHAPE.args.deployer]).toBe(H160);
    expect(inst.args[1]).toBe(DEPLOY.contract);
    expect(reviveAddressOf("0x" + "11".repeat(20) + "ee".repeat(12))).toBe("0x" + "11".repeat(20));
  });
  it("map_account emitted no Revive event, and the account was already mapped before", () => {
    expect(MAP.events.some((e: { pallet: string }) => e.pallet === "Revive")).toBe(false);
    expect(MAP.originalAccountBefore).toBe(MAP.signer);
  });
  it("decodes the real instantiate_with_code call bytes", () => {
    const d = decodeV3InstantiateWithCode(DEPLOY.callHex)!;
    const { codeHash: _h, ...args } = PLANNED;
    expect(d).toMatchObject({
      palletIndex: 80,
      callIndex: 3,
      ...args,
      code: DEPLOY.evmInitCode,
      data: "0x",
      salt: null,
    });
    // CodeInfoOf's hash for EVM is keccak256 of the RUNTIME code, not of the init code that was submitted.
    expect(instantiateCodeHash(DEPLOY.evmRuntimeCode)).toBe(
      DEPLOY.stateAfter.contract.info.accountType.contract.codeHash,
    );
    expect(instantiateCodeHash(DEPLOY.evmInitCode)).not.toBe(
      DEPLOY.stateAfter.contract.info.accountType.contract.codeHash,
    );
    expect(decodeV3InstantiateWithCode((DEPLOY.callHex + "00") as Hex)).toBeUndefined();
    expect(decodeV3InstantiateWithCode("0x50" as Hex)).toBeUndefined();
  });
});

describe("verifyReviveInstantiateOutcome (REAL deploy tx 0xad39bce1…acb2)", () => {
  it("verified / effect_proven with the real record", () => {
    const v = verifyReviveInstantiateOutcome(deployIn(), PLANNED);
    expect(v.verification).toBe("verified");
    expect(v.coverage).toBe("effect_proven");
    expect(v.basis).toBe("call_args_success_and_instantiated");
    expect(v.matchedEvent).toBe(`Revive.Instantiated(${H160}, ${DEPLOY.contract})`);
  });
  it("missing Instantiated event (edited copy): effect_mismatch", () => {
    const events = ev(DEPLOY).filter((e) => e.name !== "Instantiated");
    const v = verifyReviveInstantiateOutcome(deployIn({ events }), PLANNED);
    expect(v).toMatchObject({ verification: "not_verified", code: "effect_mismatch" });
  });
  it("another deployer (edited copy): effect_mismatch", () => {
    const events = ev(DEPLOY).map((e) =>
      e.name === "Instantiated" ? { ...e, args: ["0x" + "22".repeat(20), e.args[1]!] } : e,
    );
    expect(verifyReviveInstantiateOutcome(deployIn({ events }), PLANNED).code).toBe(
      "effect_mismatch",
    );
  });
  it("another code hash or deposit limit in the plan: effect_mismatch naming the field", () => {
    const v = verifyReviveInstantiateOutcome(deployIn(), {
      ...PLANNED,
      codeHash: "0x" + "00".repeat(32),
    });
    expect(v.code).toBe("effect_mismatch");
    expect(v.reason).toMatch(/code hash/);
    const w = verifyReviveInstantiateOutcome(deployIn(), { ...PLANNED, storageDepositLimit: "1" });
    expect(w.reason).toMatch(/storage_deposit_limit/);
  });
  it("failed dispatch: tx_failed", () => {
    const events = ev(DEPLOY).map((e) =>
      e.name === "ExtrinsicSuccess" ? { ...e, name: "ExtrinsicFailed" } : e,
    );
    expect(verifyReviveInstantiateOutcome(deployIn({ events }), PLANNED).code).toBe("tx_failed");
  });
  it("undecodable or missing call bytes, missing plan args: unknown", () => {
    for (const v of [
      verifyReviveInstantiateOutcome(deployIn({ callHex: "0xzz" as Hex }), PLANNED),
      verifyReviveInstantiateOutcome(deployIn({ callHex: undefined }), PLANNED),
      verifyReviveInstantiateOutcome(deployIn(), { ...PLANNED, codeHash: undefined }),
    ])
      expect(v.verification).toBe("unknown");
  });
  it("another runtime: capped, v3_shape_unobserved", () => {
    const v = verifyReviveInstantiateOutcome(deployIn({ runtime: OTHER_RUNTIME }), PLANNED);
    expect(v).toMatchObject({ verification: "unknown", code: "v3_shape_unobserved" });
  });
});

describe("verifyMapAccountOutcome (REAL map_account tx 0x7577717d…1812)", () => {
  const base = {
    status: "finalized" as const,
    events: ev(MAP),
    runtime: RUNTIME,
    signerAccountId: SIGNER,
  };
  it("events alone: unknown / extrinsic_finalized, basis call_success", () => {
    expect(verifyMapAccountOutcome(base)).toMatchObject({
      verification: "unknown",
      coverage: "extrinsic_finalized",
      basis: "call_success",
    });
  });
  it("with the recorded OriginalAccount read: verified, and says it was already mapped", () => {
    const v = verifyMapAccountOutcome({
      ...base,
      originalAccount: { h160: MAP.derivedH160, accountId: SIGNER, before: SIGNER },
    });
    expect(v).toMatchObject({
      verification: "verified",
      coverage: "effect_proven",
      basis: "original_account_readback",
    });
    expect(v.reason).toMatch(/already did before this call/);
  });
  it("a read showing no mapping or another account: effect_mismatch; a read for another H160: unknown", () => {
    expect(
      verifyMapAccountOutcome({ ...base, originalAccount: { h160: H160, accountId: null } }).code,
    ).toBe("effect_mismatch");
    expect(
      verifyMapAccountOutcome({
        ...base,
        originalAccount: { h160: H160, accountId: "0x" + "33".repeat(32) },
      }).code,
    ).toBe("effect_mismatch");
    expect(
      verifyMapAccountOutcome({
        ...base,
        originalAccount: { h160: "0x" + "44".repeat(20), accountId: SIGNER },
      }).verification,
    ).toBe("unknown");
  });
  it("failed: tx_failed; other runtime: capped", () => {
    const failed = ev(MAP).map((e) =>
      e.name === "ExtrinsicSuccess" ? { ...e, name: "ExtrinsicFailed" } : e,
    );
    expect(verifyMapAccountOutcome({ ...base, events: failed }).code).toBe("tx_failed");
    expect(verifyMapAccountOutcome({ ...base, runtime: OTHER_RUNTIME }).code).toBe(
      "v3_shape_unobserved",
    );
  });
});

describe("buildReceipt / verifyStep defaults (spec 3002 only)", () => {
  const deployStep = {
    actionId: "deploy",
    kind: "revive.instantiate_with_code",
    capability: "Revive.instantiate_with_code",
    palletIndex: 80,
    callIndex: 3,
    decodedArgs: {
      codeHash: PLANNED.codeHash,
      value: "0",
      gasLimit: "50000000000",
      proofSize: "1000000",
      storageDepositLimit: "1500000000000000",
    },
    status: "ok",
  } as unknown as PlanStep;
  const mapStep = {
    actionId: "map",
    kind: "revive.map_account",
    capability: "Revive.map_account",
    palletIndex: 80,
    callIndex: 7,
    decodedArgs: { account: SIGNER },
    status: "ok",
  } as unknown as PlanStep;
  const out = (r: typeof DEPLOY, id: string): StepOutcome => ({
    actionId: id,
    status: "finalized",
    txHash: r.txHash,
    block: r.block,
    events: ev(r),
    callHex: r.callHex,
  });
  it("instantiate_with_code: verified on spec 3002, unsupported_runtime elsewhere", () => {
    const s = verifyStep(deployStep, SIGNER, out(DEPLOY, "deploy"), undefined, undefined, RUNTIME);
    expect(s).toMatchObject({
      verification: "verified",
      coverage: "effect_proven",
      basis: "call_args_success_and_instantiated",
    });
    const o = verifyStep(
      deployStep,
      SIGNER,
      out(DEPLOY, "deploy"),
      undefined,
      undefined,
      OTHER_RUNTIME,
    );
    expect(o).toMatchObject({ verification: "unknown", code: "unsupported_runtime" });
    expect(verifyStep(deployStep, SIGNER, out(DEPLOY, "deploy")).code).toBe("unsupported_runtime");
  });
  it("map_account: unknown from events, verified with an OriginalAccount read", () => {
    expect(
      verifyStep(mapStep, SIGNER, out(MAP, "map"), undefined, undefined, RUNTIME),
    ).toMatchObject({
      verification: "unknown",
      basis: "call_success",
    });
    const s = verifyStep(
      mapStep,
      SIGNER,
      out(MAP, "map"),
      { originalAccount: { h160: H160, accountId: SIGNER, before: SIGNER } },
      undefined,
      RUNTIME,
    );
    expect(s).toMatchObject({ verification: "verified", basis: "original_account_readback" });
    expect(
      verifyStep(mapStep, SIGNER, out(MAP, "map"), undefined, undefined, OTHER_RUNTIME).code,
    ).toBe("unsupported_runtime");
  });
});
