/**
 * @seam/sdk/browser: the receipt outcome verifiers with no node builtins, the very same functions as the node entry, and
 * each step kind checked against its REAL Portaldot V3 record (evidence/testnet-v3/runs, spec 3002) plus a tampered copy.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Hex, PlanStep } from "@seam/compiler";
import * as node from "../src/index.js";
import * as browser from "../src/browser.js";
import type { ChainEvent, StepOutcome } from "../src/browser.js";

const require = createRequire(import.meta.url);
const entry = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

/* eslint-disable @typescript-eslint/no-explicit-any */
const runs = (f: string): any =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../evidence/testnet-v3/runs/${f}`, import.meta.url)),
      "utf8",
    ),
  );
const SEQ = runs("plan-sequential-1792411270138.json"); // [pay assets.transfer, nft nfts.mint]
const ATOMIC = runs("plan-atomic-1792411355057.json"); // batch_all [mint assets.mint, nft nfts.mint]
const CALL = runs("plan-revive-call-1792412445848.json"); // revive.call, emitted LOG0 (data 0x, no topics)
const DEPLOY = runs("revive-deploy-1792412368928.json");
const MAP = runs("map-account-1792408724499.json");
const RUNTIME = CALL.fingerprint; // portaldot-v3 spec 3002
const SIGNER = SEQ.plan.signer.publicKey as Hex;
const H160 = "0x81ed1dfbec067703fdca3daa7efcbeff4ba101ec";

const ev = (list: ChainEvent[]): ChainEvent[] =>
  list.map((e) => ({ pallet: e.pallet, name: e.name, args: [...e.args] }));
const used = (rec: any, id: string): StepOutcome => {
  const o = rec.nftVerdictReceipt.outcomesUsed.find((x: StepOutcome) => x.actionId === id);
  return { ...o, events: ev(o.events) };
};
const stepOf = (rec: any, id: string): PlanStep =>
  rec.plan.steps.find((s: PlanStep) => s.actionId === id);
/** Same as `o`, with the first event named `pallet.name` given a different argument at `argIndex`. */
const tamper = (o: StepOutcome, pallet: string, name: string, argIndex: number): StepOutcome => {
  const events = ev(o.events);
  const e = events.find((x) => x.pallet === pallet && x.name === name)!;
  e.args[argIndex] = /^0x/.test(e.args[argIndex]!)
    ? `0x${"ee".repeat((e.args[argIndex]!.length - 2) / 2)}`
    : String(BigInt(e.args[argIndex]!) + 1n);
  return { ...o, events };
};
const raw = (r: any, id: string): StepOutcome => ({
  actionId: id,
  status: "finalized",
  txHash: r.txHash,
  block: r.block,
  events: ev(r.events),
  callHex: r.callHex,
});

describe("browser entry has no node-only code", () => {
  const esbuild = require("esbuild") as typeof import("esbuild");
  const bundle = (file: string) =>
    esbuild.buildSync({
      entryPoints: [entry(file)],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });

  it("bundles for the browser with no node builtin, no file store and no flow/CLI module", () => {
    const inputs = Object.keys(bundle("browser.ts").metafile.inputs);
    expect(inputs.some((i) => /^(node:|fs$|path$|os$|crypto$|net$|child_process$)/.test(i))).toBe(
      false,
    );
    for (const nodeOnly of ["fileStore", "flow", "cli", "verify-live", "offline", "drift"])
      expect(inputs.some((i) => i.endsWith(`sdk/src/${nodeOnly}.ts`))).toBe(false);
  });

  it("the node entry does pull node builtins (so the check above can fail)", () => {
    const r = esbuild.buildSync({
      entryPoints: [entry("index.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const imports = Object.values(r.metafile.inputs).flatMap((i) => i.imports.map((x) => x.path));
    expect(imports.some((p) => /^node:|^fs$/.test(p))).toBe(true);
  });
});

describe("browser entry exports the very same functions as the node entry", () => {
  it("every browser export is identical (===) to the node export of the same name", () => {
    const names = Object.keys(browser);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect((browser as any)[n], n).toBe((node as any)[n]);
  });
  it("exposes the dispatcher and every per-kind verifier", () => {
    for (const n of [
      "verifyStep",
      "expectedEvent",
      "buildReceipt",
      "verifyNftsMintOutcome",
      "verifyReviveCallV3Outcome",
      "verifyReviveInstantiateOutcome",
      "verifyMapAccountOutcome",
      "decodeV3ReviveCall",
      "decodeV3InstantiateWithCode",
      "instantiateCodeHash",
      "reviveAddressOf",
      "isObservedV3",
      "perStepOfBatch",
    ])
      expect(typeof (browser as any)[n], n).toBe("function");
  });
});

describe("browser verifyStep on REAL V3 records, every kind", () => {
  const { verifyStep } = browser;

  it("assets.transfer: verified; a tampered amount is not_verified", () => {
    const s = stepOf(SEQ, "pay");
    expect(verifyStep(s, SIGNER, used(SEQ, "pay"), undefined, undefined, RUNTIME)).toMatchObject({
      verification: "verified",
      coverage: "effect_proven",
    });
    const bad = tamper(used(SEQ, "pay"), "Assets", "Transferred", 3);
    expect(verifyStep(s, SIGNER, bad, undefined, undefined, RUNTIME)).toMatchObject({
      verification: "not_verified",
      code: "effect_mismatch",
    });
  });

  it("assets.mint: verified; a tampered amount is not_verified", () => {
    const s = stepOf(ATOMIC, "mint");
    const o = { ...used(ATOMIC, "batch"), actionId: "mint" };
    expect(verifyStep(s, SIGNER, o, undefined, undefined, RUNTIME).verification).toBe("verified");
    const bad = tamper(o, "Assets", "Issued", 2);
    expect(verifyStep(s, SIGNER, bad, undefined, undefined, RUNTIME).verification).toBe(
      "not_verified",
    );
  });

  it("nfts.mint: verified on spec 3002; a tampered item is not verified; another runtime stays unknown", () => {
    const s = stepOf(SEQ, "nft");
    const o = used(SEQ, "nft");
    expect(verifyStep(s, SIGNER, o, undefined, undefined, RUNTIME)).toMatchObject({
      verification: "verified",
      coverage: "effect_proven",
    });
    const bad = tamper(o, "Nfts", "Issued", 1);
    expect(verifyStep(s, SIGNER, bad, undefined, undefined, RUNTIME).verification).not.toBe(
      "verified",
    );
    expect(
      verifyStep(s, SIGNER, o, undefined, undefined, { ...RUNTIME, specVersion: 1002 })
        .verification,
    ).toBe("unknown");
  });

  it("revive.call: unknown without an expected event, verified with the exact one, not verified with a wrong one", () => {
    const s = CALL.plan.steps[0] as PlanStep;
    const o: StepOutcome = {
      actionId: "call",
      status: "finalized",
      txHash: CALL.run.receipt.steps[0].txHash,
      block: CALL.run.receipt.steps[0].block,
      events: ev(CALL.lastSubmit.inclusion.events),
      callHex: s.encodedCall as Hex,
    };
    const none = verifyStep(s, SIGNER, o, undefined, undefined, RUNTIME);
    expect(none.verification).toBe("unknown");
    expect(none.basis).toBe("call_args_and_success");
    expect(verifyStep(s, SIGNER, o, { emittedData: "0x" }, undefined, RUNTIME).verification).toBe(
      "verified",
    );
    expect(
      verifyStep(s, SIGNER, o, { emittedData: "0xabcd" }, undefined, RUNTIME).verification,
    ).toBe("not_verified");
  });

  it("revive.instantiate_with_code: verified on spec 3002; tampered call bytes are not verified", () => {
    const step = {
      actionId: "deploy",
      kind: "revive.instantiate_with_code",
      palletIndex: 80,
      callIndex: 3,
      decodedArgs: {
        codeHash: browser.instantiateCodeHash(DEPLOY.evmInitCode),
        value: "0",
        gasLimit: "50000000000",
        proofSize: "1000000",
        storageDepositLimit: "1500000000000000",
      },
      status: "ok",
    } as unknown as PlanStep;
    const o = raw(DEPLOY, "deploy");
    expect(verifyStep(step, SIGNER, o, undefined, undefined, RUNTIME)).toMatchObject({
      verification: "verified",
      basis: "call_args_success_and_instantiated",
    });
    const badCall = (o.callHex as string).slice(0, -2) + "ff";
    expect(
      verifyStep(step, SIGNER, { ...o, callHex: badCall as Hex }, undefined, undefined, RUNTIME)
        .verification,
    ).not.toBe("verified");
  });

  it("revive.map_account: unknown from events, verified with an OriginalAccount read, not with a wrong one", () => {
    const step = {
      actionId: "map",
      kind: "revive.map_account",
      palletIndex: 80,
      callIndex: 7,
      decodedArgs: { account: SIGNER },
      status: "ok",
    } as unknown as PlanStep;
    const o = raw(MAP, "map");
    expect(verifyStep(step, SIGNER, o, undefined, undefined, RUNTIME).verification).toBe("unknown");
    expect(
      verifyStep(
        step,
        SIGNER,
        o,
        { originalAccount: { h160: H160, accountId: SIGNER, before: SIGNER } },
        undefined,
        RUNTIME,
      ).verification,
    ).toBe("verified");
    expect(
      verifyStep(
        step,
        SIGNER,
        o,
        { originalAccount: { h160: H160, accountId: `0x${"11".repeat(32)}`, before: SIGNER } },
        undefined,
        RUNTIME,
      ).verification,
    ).not.toBe("verified");
  });
});

describe("browser perStepOfBatch on the REAL V3 atomic run (batch_all mint + nft, #102671)", () => {
  const { perStepOfBatch, buildReceipt } = browser;
  it("is the node export and bundles without flow.ts", () => {
    expect(browser.perStepOfBatch).toBe(node.perStepOfBatch);
  });
  const s = ATOMIC.run.receipt.steps[0];
  const callHex = ATOMIC.signingRequests[0].payload.method as Hex;
  const batch = (c?: Hex): StepOutcome => ({
    ...used(ATOMIC, "batch"),
    ...(c ? { callHex: c } : {}),
  });
  it("splits the real batch per step and every step verifies", () => {
    expect(s.block.number).toBe(102671);
    const outcomes = perStepOfBatch(ATOMIC.plan, [batch()], callHex);
    expect(outcomes.filter((o) => o.actionId !== "batch").every((o) => !!o.callHex)).toBe(true);
    const r = buildReceipt({ plan: ATOMIC.plan, outcomes, runtime: RUNTIME });
    expect(r.steps.map((x) => x.verification)).toEqual(["verified", "verified"]);
  });
  it("a tampered batch call gives no step any call bytes", () => {
    const bad = (callHex.slice(0, -2) + (callHex.endsWith("00") ? "01" : "00")) as Hex;
    const outcomes = perStepOfBatch(ATOMIC.plan, [batch(bad)], undefined);
    expect(outcomes.filter((o) => o.actionId !== "batch").some((o) => o.callHex)).toBe(false);
  });
  it("tampered batch events: the affected steps are not_verified", () => {
    const bad = tamper(tamper(batch(), "Assets", "Issued", 2), "Nfts", "Issued", 1);
    const outcomes = perStepOfBatch(ATOMIC.plan, [bad], callHex);
    const r = buildReceipt({ plan: ATOMIC.plan, outcomes, runtime: RUNTIME });
    expect(r.steps.map((x) => x.verification)).toEqual(["not_verified", "not_verified"]);
  });
});
