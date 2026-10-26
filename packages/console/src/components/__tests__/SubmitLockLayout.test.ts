// @vitest-environment node
// Submit-time runtime lock on the layout hash, through the console's preSubmit with the REAL @seam/policy gate, the REAL
// @seam/chain/browser decoder (its metadataHashMode comes from the extension bytes) and the committed V3 spec 3002
// metadata. Extrinsic: the real extension-signed V3 transfer #118310 (CheckMetadataHash mode 0) from Chainsmith's
// fixture; the mode-1 case is that same extrinsic with only its mode byte set to 1, as read back by the real decoder.
// The live drift (Revive.EthBlockBuilderIR default) is synthesized with Chainsmith's metadata mutators.
// No wallet, no keys, nothing signed or sent; only the preflight RPC is stubbed.
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factsFromMetadata } from "@seam/compiler/browser";
import * as chainBrowser from "@seam/chain/browser";
import { checkBeforeSubmit, rawMetadataHash } from "@seam/policy/browser";
import { withFallback } from "../../../../chain/tests/metadataMutate.js";
import { newApprovalStore, preSign, preSubmit, type ChainFns } from "../../lib/signflow";
import { buildLiveReceipt } from "../../lib/livereceipt";
import { buildSequentialReceipt } from "../../lib/seqreceipt";

// Fixture paths resolve from this test file, not process.cwd(), so `vitest --root packages/console` works from the repo root.
const CONSOLE_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");

const root = (p: string) => resolve(CONSOLE_DIR, "../..", p);
const json = (p: string) => JSON.parse(readFileSync(root(p), "utf8"));
const demo = json("packages/console/src/demo/v3-demo-transfer.json");
const seq = json("packages/console/src/demo/v3-demo-transfer-policy-sequential.json");
const recorded = json("evidence/testnet-v3/preflight-1792509095721.json").result;
const realTx = json("packages/chain/tests/fixtures/v3-signed-extrinsics.json").transactions.find(
  (t: { block: number }) => t.block === 118310,
);
const V3 = readFileSync(root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"), "utf8")
  .trim()
  .toLowerCase();
const DRIFT = withFallback(V3 as never, "Revive", "EthBlockBuilderIR", "0x00") as string;
const OTHER = withFallback(V3 as never, "System", "Number", "0x2a000000") as string;
const LAYOUT = "0x221ba8f7dd81e0341fca9f0074a3e433659c97300cbbb2f874dbd5f0d998b304";
const facts = factsFromMetadata({
  metadataHex: V3,
  genesisHash: demo.manifest.chain.genesisHash,
  tokenSymbol: "tPOT",
  tokenDecimals: 14,
}) as unknown as { fingerprint: Record<string, unknown>; source: { metadataHex: string } };
const fpOf = (hex: string) => ({ ...facts.fingerprint, metadataHash: rawMetadataHash(hex) });
const checkpoint = { number: realTx.birth, hash: realTx.birthHash };
const input = { policy: seq.policy, plan: demo.plan, manifest: demo.manifest };
const now = new Date();

const chain = (): ChainFns => ({
  preflight: vi.fn(async (_s, _p, _f, o?: { signedExtrinsics?: string[] }) =>
    o?.signedExtrinsics
      ? { ...recorded, steps: recorded.steps.map((s: object) => ({ ...s, dryRun: "ok" })) }
      : recorded,
  ),
  signedExtrinsicDecoder: (f: unknown, ctx?: unknown) =>
    chainBrowser.signedExtrinsicDecoder(f as never, ctx as never) as never,
  blockTimeFromFacts: chainBrowser.blockTimeFromFacts as never,
  buildSigningEnvelope: chainBrowser.buildSigningEnvelope as never,
});
const realDecode = (x: string) => chainBrowser.signedExtrinsicDecoder(facts as never)(x as never);

/** The real extrinsic with only its CheckMetadataHash mode byte set to 1, as the real decoder reads it. */
function withModeOne(hex: string): string {
  const call = realDecode(hex)?.call;
  for (let i = 4; i < hex.length; i += 2) {
    if (hex.slice(i, i + 2) !== "00") continue;
    const b = hex.slice(0, i) + "01" + hex.slice(i + 2);
    try {
      const d = realDecode(b);
      if (d?.metadataHashMode === 1 && d.call === call) return b;
    } catch {
      /* not this byte */
    }
  }
  throw new Error("mode byte not found");
}

async function run(tx: string, current?: { hex?: string; fp?: object }) {
  const c = chain();
  const pre = await preSign({
    chain: c,
    send: async () => null,
    input,
    facts,
    signer: realTx.signer,
    ctx: {
      nonce: realTx.nonce,
      mortalityBlocks: 64,
      checkpointNumber: checkpoint.number,
      checkpointHash: checkpoint.hash,
    },
    now,
  });
  if (!pre.res.ok) throw new Error(pre.res.message);
  const hex = current?.hex;
  const s = await preSubmit({
    chain: c,
    send: async () => null,
    pre: pre.res.value,
    facts,
    signedTx: tx,
    now,
    store: newApprovalStore(),
    freshFingerprint: async () => ({
      fingerprint: current?.fp ?? fpOf(hex ?? V3),
      ...(hex ? { metadataHex: hex } : {}),
    }),
  });
  return { s, pre: pre.res.value, c };
}

describe("submit lock on the layout hash (real policy gate, real decoder)", () => {
  it("the real decoder reports mode 0 for the real V3 transfer", () => {
    expect(realDecode(realTx.extrinsic)?.metadataHashMode).toBe(0);
  });
  it("unchanged runtime passes on the raw basis", async () => {
    const { s } = await run(realTx.extrinsic, { hex: V3 });
    expect(s.ok && s.value.runtimeLock).toMatchObject({
      ok: true,
      lockBasis: "raw",
      code: "runtime_unchanged",
    });
  });
  it("raw-hash-only drift passes with lockBasis layout_hash and both raw + layout hashes from the gate", async () => {
    const { s } = await run(realTx.extrinsic, { hex: DRIFT });
    if (!s.ok) throw new Error(s.message);
    expect(s.value.passed.map((p) => p.code)).toContain("runtime_layout_unchanged");
    expect(s.value.runtimeLock).toMatchObject({
      ok: true,
      lockBasis: "layout_hash",
      code: "runtime_layout_unchanged",
      preparedMetadataHash: rawMetadataHash(V3),
      currentMetadataHash: rawMetadataHash(DRIFT),
      preparedLayoutHash: LAYOUT,
      currentLayoutHash: LAYOUT,
    });
  });
  it("a real layout change still blocks with runtime_changed", async () => {
    const { s } = await run(realTx.extrinsic, { hex: OTHER });
    expect(!s.ok && s.message).toMatch(/Blocked at submit \([^)]*runtime_changed/);
  });
  it("fails closed when the real decoder reads CheckMetadataHash mode 1", async () => {
    const m1 = withModeOne(realTx.extrinsic);
    const { s } = await run(m1, { hex: DRIFT });
    expect(!s.ok && s.message).toMatch(/runtime_changed/);
  });
  it("fails closed when the fresh read has no metadata", async () => {
    const { s } = await run(realTx.extrinsic, { fp: fpOf(DRIFT) });
    expect(!s.ok && s.message).toMatch(/runtime_changed/);
  });
  it("receipts' runtimeLock deep-equals check.runtimeLock; absent without one; never any metadataHex", async () => {
    const { s, pre, c } = await run(realTx.extrinsic, { hex: DRIFT });
    if (!s.ok) throw new Error(s.message);
    // The gate's own result on the same inputs preSubmit used.
    const check = checkBeforeSubmit({
      ...(pre.approvalInput as object),
      approval: pre.approval,
      preparedFingerprint: facts.fingerprint,
      currentFingerprint: fpOf(DRIFT),
      preparedMetadataHex: V3,
      currentMetadataHex: DRIFT,
      signedCalls: [],
      signedExtrinsics: [realTx.extrinsic],
      decodeSignedExtrinsic: c.signedExtrinsicDecoder(facts, pre.approvalInput.envelope),
      requireTrustedDecoder: true,
      signedDryRun: recorded.steps.map(() => "ok"),
      now,
      store: newApprovalStore(),
    } as never);
    expect(check.ok).toBe(true);
    expect(s.value.runtimeLock).toEqual(check.runtimeLock);
    const out = {
      status: "unverified",
      message: "",
      coverage: "none",
      simulation: "none",
      signing: "binding_ok",
      txState: "finalized",
      provenance: "unknown",
      rpcAttempts: 0,
      submitted: true,
      txHash: "0x" + "ab".repeat(32),
    };
    const live = buildLiveReceipt({
      out: { ...out, runtimeLock: s.value.runtimeLock } as never,
      checked: false,
    });
    expect(live.runtimeLock).toEqual(check.runtimeLock);
    expect("runtimeLock" in buildLiveReceipt({ out: out as never, checked: false })).toBe(false);
    const seqR = buildSequentialReceipt({
      ok: true,
      signRequests: 1,
      message: "",
      steps: [
        {
          index: 0,
          actionId: "a",
          status: "sent",
          message: "",
          sendIndex: 0,
          runtimeLock: s.value.runtimeLock,
        },
      ],
    } as never);
    expect(seqR.steps[0]!.runtimeLock).toEqual(check.runtimeLock);
    for (const r of [live, seqR]) {
      const txt = JSON.stringify(r);
      expect(txt).not.toMatch(/metadataHex/);
      expect(txt).not.toContain(DRIFT.slice(2, 202));
      expect(txt).not.toContain(V3.slice(2, 202));
    }
  });
});
