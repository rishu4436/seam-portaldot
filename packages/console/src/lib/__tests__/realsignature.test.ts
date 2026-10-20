// @vitest-environment node
// Regression for the LIVE run on fc91363: a real wallet signature was blocked at submit with signed_signature_invalid
// while the panel said "Signed bytes match the approval".
//
// Root cause (console side): preSubmit called Chainsmith's signedExtrinsicDecoder(facts) WITHOUT the signing requests.
// The era's block hash is not inside a signed extrinsic, so the decoder can only check a signature against a request it
// is given; with none it always reports signatureValid=false. preSubmit now passes the request(s) the wallet signed.
//
// The real-signature case uses the public, finalized V3 transfer 0x8a2c8b92…a4ad (block #118310) and the committed
// V3 spec 3002 metadata. Its signed bytes are not committed (signed bytes stay out of the repo unless they are already in
// evidence), so that case runs only when SEAM_REAL_TX_FILE points to a local {tx, request} JSON; the wiring case always runs.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factsFromMetadata } from "@seam/compiler/browser";
import { signedExtrinsicDecoder } from "@seam/chain/browser";
import { preSubmit, type ChainFns } from "../signflow";

const root = (p: string) => resolve(process.cwd(), "../..", p);
const demo = JSON.parse(
  readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
);
const facts = factsFromMetadata({
  metadataHex: readFileSync(
    root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
    "utf8",
  ).trim(),
  genesisHash: demo.manifest.chain.genesisHash,
  tokenSymbol: "tPOT",
  tokenDecimals: 14,
});
const file = process.env.SEAM_REAL_TX_FILE;
const real = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;

describe("submit gate gets the signing requests", () => {
  it("preSubmit passes the request(s) to signedExtrinsicDecoder", async () => {
    const decoder = vi.fn(() => () => null);
    const chain: ChainFns = {
      preflight: vi.fn(async () => ({ steps: [] })),
      signedExtrinsicDecoder: decoder,
    };
    const request = { nonce: 1, payload: { blockHash: "0x" + "22".repeat(32) } };
    await preSubmit({
      chain,
      send: async () => null,
      pre: { approvalInput: { plan: demo.plan }, approval: {} } as never,
      facts,
      signedTx: "0x00",
      requests: [request],
      now: new Date(),
      store: { markUsed() {}, isUsed: () => false } as never,
      freshFingerprint: async () => facts.fingerprint,
    });
    expect(decoder).toHaveBeenCalledWith(facts, [request]);
  });

  it.runIf(!!real)("a real V3 wallet signature verifies only when the request is passed", () => {
    expect(facts.fingerprint.specVersion).toBe(3002);
    // As fc91363 called it: no requests, so a real signature reads as invalid.
    expect(signedExtrinsicDecoder(facts as never)(real.tx)?.signatureValid).toBe(false);
    // As it is called now.
    const d = signedExtrinsicDecoder(facts as never, [real.request])(real.tx)!;
    expect(d.signatureValid).toBe(true);
    expect(d.call).toBe(demo.plan.steps[0].encodedCall);
  });
});
