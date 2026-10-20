// Submit-time runtime lock on the layout hash: live V3 spec 3002 metadata drifts in Revive.EthBlockBuilderIR's storage
// default only. Real committed V3 blob; drifted/changed blobs are synthesized from it with targeted codec edits.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { factsFromMetadata, metadataLayoutHash as compilerLayout } from "@seam/compiler";
import { metadataLayoutHash as chainLayout } from "../../chain/src/metadata-layout.js";
import {
  withFallback,
  mutateV14,
  callTypeId,
  lookupDef,
} from "../../chain/tests/metadataMutate.js";
import {
  checkRuntimeLock,
  rawMetadataHash,
  checkBeforeSubmit,
  createApproval,
  evaluatePolicy,
  callsToSign,
  InMemoryApprovalStore,
  type BoundApproval,
  type DecodedSignedExtrinsic,
  type Hex,
  type Plan,
  type RuntimeFingerprint,
} from "../src/index.js";

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), "utf8");
const V3 = read("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex")
  .trim()
  .toLowerCase() as Hex;
const LAYOUT = "0x221ba8f7dd81e0341fca9f0074a3e433659c97300cbbb2f874dbd5f0d998b304";
const DRIFT = withFallback(V3, "Revive", "EthBlockBuilderIR", "0x00");
const OTHER_DEFAULT = withFallback(V3, "System", "Number", "0x2a000000");
const CALL_CHANGED = mutateV14(V3, (j) => {
  const def = lookupDef(j, callTypeId(j, "Assets"));
  def.variant.variants[0].name = "renamed_call";
});

const demo = JSON.parse(read("packages/console/src/demo/v3-demo-transfer.json"));
const fpOf = (hex: Hex): RuntimeFingerprint => ({
  ...demo.fingerprint,
  metadataHash: rawMetadataHash(hex),
});
const PREP = fpOf(V3);
const CUR = fpOf(DRIFT);
const OFF = { metadataHashModeOff: true };

describe("fixtures", () => {
  it("real V3 blob: raw hash is the demo fingerprint's, layout is the pinned v2 value", () => {
    expect(rawMetadataHash(V3)).toBe(demo.fingerprint.metadataHash);
    expect(compilerLayout(V3)).toBe(LAYOUT);
    expect(chainLayout(V3)).toBe(LAYOUT);
  });
  it("drift changes the raw hash but not the layout; other edits change the layout", () => {
    expect(rawMetadataHash(DRIFT)).not.toBe(rawMetadataHash(V3));
    expect(compilerLayout(DRIFT)).toBe(LAYOUT);
    expect(compilerLayout(OTHER_DEFAULT)).not.toBe(LAYOUT);
    expect(compilerLayout(CALL_CHANGED)).not.toBe(LAYOUT);
  });
});

describe("checkRuntimeLock layout basis", () => {
  it("default (no blobs) stays strict raw", () => {
    expect(checkRuntimeLock(PREP, PREP)).toMatchObject({ ok: true, lockBasis: "raw" });
    const r = checkRuntimeLock(PREP, CUR);
    expect(r).toMatchObject({ ok: false, code: "runtime_changed", changed: ["metadataHash"] });
  });
  it("drift passes with both blobs and mode off, recording both raw hashes", () => {
    const r = checkRuntimeLock(PREP, CUR, {
      preparedMetadataHex: V3,
      currentMetadataHex: DRIFT,
      ...OFF,
    });
    expect(r).toMatchObject({
      ok: true,
      lockBasis: "layout_hash",
      code: "runtime_layout_unchanged",
      preparedMetadataHash: PREP.metadataHash,
      currentMetadataHash: CUR.metadataHash,
      preparedLayoutHash: LAYOUT,
      currentLayoutHash: LAYOUT,
    });
  });
  it("one blob missing blocks", () => {
    expect(checkRuntimeLock(PREP, CUR, { preparedMetadataHex: V3, ...OFF }).ok).toBe(false);
    expect(checkRuntimeLock(PREP, CUR, { currentMetadataHex: DRIFT, ...OFF }).ok).toBe(false);
  });
  it("CheckMetadataHash mode on or unknown blocks", () => {
    const b = { preparedMetadataHex: V3, currentMetadataHex: DRIFT };
    expect(checkRuntimeLock(PREP, CUR, b)).toMatchObject({ ok: false, code: "runtime_changed" });
    expect(checkRuntimeLock(PREP, CUR, { ...b, metadataHashModeOff: false }).ok).toBe(false);
  });
  it("a blob that doesn't hash to its fingerprint's metadataHash blocks", () => {
    expect(
      checkRuntimeLock(PREP, CUR, { preparedMetadataHex: DRIFT, currentMetadataHex: V3, ...OFF })
        .ok,
    ).toBe(false);
    expect(
      checkRuntimeLock(PREP, CUR, { preparedMetadataHex: V3, currentMetadataHex: V3, ...OFF }).ok,
    ).toBe(false);
  });
  it.each([
    "specVersion",
    "transactionVersion",
    "genesisHash",
    "specName",
    "ss58Prefix",
    "tokenSymbol",
    "tokenDecimals",
    "typesBundleHash",
  ] as const)("%s change blocks even with the same layout", (k) => {
    const v =
      k === "genesisHash"
        ? "0x" + "11".repeat(32)
        : k === "specName" || k === "tokenSymbol" || k === "typesBundleHash"
          ? "x"
          : 9999;
    const r = checkRuntimeLock(PREP, { ...CUR, [k]: v } as RuntimeFingerprint, {
      preparedMetadataHex: V3,
      currentMetadataHex: DRIFT,
      ...OFF,
    });
    expect(r.ok).toBe(false);
    expect(r.changed).toContain(k);
  });
  it.each([
    ["another storage default", OTHER_DEFAULT],
    ["a call renamed", CALL_CHANGED],
  ])("a real layout change (%s) blocks with runtime_changed", (_n, hex) => {
    const r = checkRuntimeLock(PREP, fpOf(hex), {
      preparedMetadataHex: V3,
      currentMetadataHex: hex,
      ...OFF,
    });
    expect(r).toMatchObject({ ok: false, code: "runtime_changed", preparedLayoutHash: LAYOUT });
    expect(r.currentLayoutHash).not.toBe(LAYOUT);
  });
  it("undecodable or non-hex blob blocks", () => {
    const junk = ("0x6d657461" + "0e" + "ff".repeat(40)) as Hex; // "meta" magic, V14, garbage body
    expect(
      checkRuntimeLock(PREP, fpOf(junk), {
        preparedMetadataHex: V3,
        currentMetadataHex: junk,
        ...OFF,
      }).ok,
    ).toBe(false);
    expect(
      checkRuntimeLock(PREP, CUR, { preparedMetadataHex: V3, currentMetadataHex: "nothex", ...OFF })
        .ok,
    ).toBe(false);
  });
  it("never trusts a caller-supplied layout hash", () => {
    const r = checkRuntimeLock(
      PREP,
      { ...CUR, metadataLayoutHash: LAYOUT } as never,
      {
        preparedMetadataHex: V3,
        currentMetadataHex: OTHER_DEFAULT,
        ...OFF,
      } as never,
    );
    expect(r.ok).toBe(false);
  });
});

// ---- through checkBeforeSubmit on the real V3 demo plan ----------------------------------------
const facts = factsFromMetadata({
  metadataHex: V3,
  genesisHash: demo.fingerprint.genesisHash,
  tokenSymbol: demo.fingerprint.tokenSymbol,
  tokenDecimals: demo.fingerprint.tokenDecimals,
  ss58Prefix: demo.fingerprint.ss58Prefix,
} as never) as never;
const plan = demo.plan as Plan;
const policy = { ...demo.policy, allowedModes: ["sequential"] };
const preflight = {
  steps: plan.steps.map((s) => ({
    actionId: s.actionId,
    weight: { value: "1" },
    fee: { value: "1" },
    storageDeposit: { value: "0" },
    dryRun: "ok" as const,
  })),
  totalFee: { value: "1" },
};
const NOW = new Date("2026-10-20T10:00:00Z");
const envelope = {
  signer: demo.manifest.signer.value,
  nonce: 0,
  mortalityBlocks: 64,
  checkpoint: { number: 1, hash: ("0x" + "22".repeat(32)) as Hex },
  expiresAt: "2026-10-20T10:04:00Z",
};
const policyResult = evaluatePolicy({ policy, plan, facts, preflight, manifest: demo.manifest });
const appr = createApproval({
  manifestDigest: plan.manifestDigest,
  plan,
  envelope,
  preflight,
  policy,
  policyResult,
  fingerprint: PREP,
  now: NOW,
});
const xts = callsToSign(plan).map((_, i) => ("0x0" + i + "aa") as Hex);
const dec =
  (mode?: 0 | 1) =>
  (x: Hex): DecodedSignedExtrinsic => ({
    call: callsToSign(plan)[Number(x[3])] as Hex,
    signer: demo.manifest.signer.value,
    nonce: Number(x[3]),
    signatureValid: true,
    ...(mode === undefined ? {} : { metadataHashMode: mode }),
  });
const submit = (over: Record<string, unknown> = {}) =>
  checkBeforeSubmit({
    approval: (appr as { approval: BoundApproval }).approval,
    manifestDigest: plan.manifestDigest,
    plan,
    envelope,
    preflight,
    policy,
    policyResult,
    preparedFingerprint: PREP,
    currentFingerprint: CUR,
    signedCalls: callsToSign(plan) as Hex[],
    signedExtrinsics: xts,
    decodeSignedExtrinsic: dec(0),
    signedDryRun: callsToSign(plan).map(() => "ok" as const),
    sendIndex: 0,
    previousSteps: [],
    now: NOW,
    store: new InMemoryApprovalStore(),
    ...over,
  });
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe("checkBeforeSubmit with metadata blobs", () => {
  it("setup is a valid approval", () => {
    expect(policyResult.allowed).toBe(true);
    expect(appr.ok).toBe(true);
  });
  it("drift + blobs + mode 0 passes as runtime_layout_unchanged", () => {
    const r = submit({ preparedMetadataHex: V3, currentMetadataHex: DRIFT });
    expect(r.reasons).toEqual([]);
    expect(r.passed.map((p) => p.code)).toContain("runtime_layout_unchanged");
  });
  it("drift without blobs still blocks runtime_changed", () => {
    expect(codes(submit())).toContain("runtime_changed");
  });
  it("CheckMetadataHash mode 1 keeps runtime_changed", () => {
    expect(
      codes(
        submit({
          preparedMetadataHex: V3,
          currentMetadataHex: DRIFT,
          decodeSignedExtrinsic: dec(1),
        }),
      ),
    ).toContain("runtime_changed");
  });
  it("mode not reported by the decoder keeps runtime_changed", () => {
    expect(
      codes(
        submit({
          preparedMetadataHex: V3,
          currentMetadataHex: DRIFT,
          decodeSignedExtrinsic: dec(),
        }),
      ),
    ).toContain("runtime_changed");
  });
  it("no trusted decoder keeps runtime_changed", () => {
    expect(
      codes(
        submit({
          preparedMetadataHex: V3,
          currentMetadataHex: DRIFT,
          decodeSignedExtrinsic: undefined,
          signedExtrinsics: undefined,
        }),
      ),
    ).toContain("runtime_changed");
  });
  it("different layout hash blocks runtime_changed", () => {
    expect(
      codes(
        submit({
          currentFingerprint: fpOf(CALL_CHANGED),
          preparedMetadataHex: V3,
          currentMetadataHex: CALL_CHANGED,
        }),
      ),
    ).toContain("runtime_changed");
  });
  it("unchanged runtime is unaffected by blobs", () => {
    const r = submit({ currentFingerprint: PREP, preparedMetadataHex: V3, currentMetadataHex: V3 });
    expect(r.passed.map((p) => p.code)).toContain("runtime_unchanged");
  });
  it("result carries the layout_hash runtimeLock with both hashes", () => {
    const r = submit({ preparedMetadataHex: V3, currentMetadataHex: DRIFT });
    expect(r.runtimeLock).toMatchObject({
      ok: true,
      lockBasis: "layout_hash",
      code: "runtime_layout_unchanged",
      preparedMetadataHash: PREP.metadataHash,
      currentMetadataHash: CUR.metadataHash,
      preparedLayoutHash: LAYOUT,
      currentLayoutHash: LAYOUT,
    });
    expect(r.runtimeLock).toEqual(
      checkRuntimeLock(PREP, CUR, {
        preparedMetadataHex: V3,
        currentMetadataHex: DRIFT,
        metadataHashModeOff: true,
      }),
    );
  });
  it("strict block carries runtimeLock ok:false runtime_changed, equal to a direct call", () => {
    const r = submit();
    expect(r.runtimeLock).toMatchObject({
      ok: false,
      code: "runtime_changed",
      changed: ["metadataHash"],
    });
    expect(r.runtimeLock).toEqual(checkRuntimeLock(PREP, CUR, { metadataHashModeOff: true }));
    const m1 = submit({
      preparedMetadataHex: V3,
      currentMetadataHex: DRIFT,
      decodeSignedExtrinsic: dec(1),
    });
    expect(m1.runtimeLock).toEqual(
      checkRuntimeLock(PREP, CUR, {
        preparedMetadataHex: V3,
        currentMetadataHex: DRIFT,
        metadataHashModeOff: false,
      }),
    );
  });
  it("unchanged runtime carries a raw runtimeLock", () => {
    expect(submit({ currentFingerprint: PREP }).runtimeLock).toMatchObject({
      ok: true,
      lockBasis: "raw",
      code: "runtime_unchanged",
    });
  });
});
