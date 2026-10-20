// @vitest-environment node
// Regression for the LIVE run on fc91363: a real wallet signature was blocked at submit with signed_signature_invalid
// while the panel said "Signed bytes match the approval".
//
// Root cause (console side): preSubmit called Chainsmith's signedExtrinsicDecoder(facts) with no context. The era's
// block hash is not inside a signed extrinsic, so with no context every signature reads as invalid. preSubmit now passes
// the approved envelope (its checkpoint), which the decoder accepts since Chainsmith's 239974f.
//
// Runs preSubmit end to end with the REAL @seam/policy engine and the REAL @seam/chain/browser decoder over:
//  - a //Alice dev-key signed extrinsic (public dev key, test only; never a wallet or keystore), and
//  - the real extension-signed V3 transfer 0x8a2c8b92…a4ad (#118310) from Chainsmith's committed fixture.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { u8aToHex } from "@polkadot/util";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { describe, expect, it, vi } from "vitest";
import {
  computeManifestDigest,
  computePlanDigest,
  factsFromMetadata,
} from "@seam/compiler/browser";
import * as chainBrowser from "@seam/chain/browser";
import { newApprovalStore, preSign, preSubmit, type ChainFns } from "../signflow";

const root = (p: string) => resolve(process.cwd(), "../..", p);
const json = (p: string) => JSON.parse(readFileSync(root(p), "utf8"));
const demo = json("packages/console/src/demo/v3-demo-transfer.json");
const seq = json("packages/console/src/demo/v3-demo-transfer-policy-sequential.json");
const recorded = json("evidence/testnet-v3/preflight-1792509095721.json").result;
const realTx = json("packages/chain/tests/fixtures/v3-signed-extrinsics.json").transactions.find(
  (t: { block: number }) => t.block === 118310,
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
const callHex = demo.plan.steps[0].encodedCall as `0x${string}`;
const demoInput = { policy: seq.policy, plan: demo.plan, manifest: demo.manifest };

/** The same demo plan re-signed-for //Alice: signer swapped, digests recomputed with the compiler's own functions. */
function aliceInput(alice: { address: string; publicKey: Uint8Array }) {
  const manifest = { ...demo.manifest, signer: { type: "ss58", value: alice.address } };
  const plan = {
    ...demo.plan,
    manifestDigest: computeManifestDigest(manifest as never),
    signer: { type: "ss58", value: alice.address, publicKey: u8aToHex(alice.publicKey) },
  };
  plan.planDigest = computePlanDigest(plan as never);
  return { policy: seq.policy, plan, manifest };
}

/** Real decoder, optionally stripped of its context (the fc91363 call shape). */
const chainFns = (withContext: boolean): ChainFns => ({
  preflight: vi.fn(async (_s, _p, _f, o?: { signedExtrinsics?: string[] }) =>
    o?.signedExtrinsics
      ? { ...recorded, steps: recorded.steps.map((s: object) => ({ ...s, dryRun: "ok" })) }
      : recorded,
  ),
  signedExtrinsicDecoder: (f: unknown, ctx?: unknown) =>
    chainBrowser.signedExtrinsicDecoder(
      f as never,
      (withContext ? ctx : undefined) as never,
    ) as never,
  blockTimeFromFacts: chainBrowser.blockTimeFromFacts as never,
  buildSigningEnvelope: chainBrowser.buildSigningEnvelope as never,
});

async function gate(
  input: object,
  signer: string,
  nonce: number,
  checkpoint: { number: number; hash: string },
  tx: string,
  withContext: boolean,
) {
  const now = new Date();
  const c = chainFns(withContext);
  const pre = await preSign({
    chain: c,
    send: async () => null,
    input: input as never,
    facts,
    signer,
    ctx: {
      nonce,
      mortalityBlocks: 64,
      checkpointNumber: checkpoint.number,
      checkpointHash: checkpoint.hash,
    },
    now,
  });
  if (!pre.res.ok) throw new Error(pre.res.message);
  return preSubmit({
    chain: c,
    send: async () => null,
    pre: pre.res.value,
    facts,
    signedTx: tx,
    now,
    store: newApprovalStore(),
    freshFingerprint: async () => facts.fingerprint,
  });
}

describe("submit gate verifies real signatures (needs chain 239974f)", () => {
  it("//Alice dev-key signed extrinsic passes preSubmit; a (facts)-only decoder gives signed_signature_invalid", async () => {
    await cryptoWaitReady();
    const alice = new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri("//Alice");
    const checkpoint = { number: realTx.birth, hash: realTx.birthHash };
    const req = chainBrowser.buildSigningRequest(callHex, facts as never, {
      signer: alice.address,
      nonce: 1,
      mortalityBlocks: 64,
      checkpoint,
    });
    const sig = u8aToHex(alice.sign(req.signBytesHex));
    const tx = chainBrowser.assembleSignedExtrinsic(req.payload, sig, facts as never, {
      scheme: "sr25519",
    });
    const ok = await gate(aliceInput(alice), alice.address, 1, checkpoint, tx, true);
    expect(ok.ok ? "passed" : ok.message).toBe("passed");
    const bad = await gate(aliceInput(alice), alice.address, 1, checkpoint, tx, false);
    expect(!bad.ok && bad.message).toMatch(/signed_signature_invalid/);
  });

  it("the real extension-signed V3 transfer (#118310) passes preSubmit with the envelope as context", async () => {
    const checkpoint = { number: realTx.birth, hash: realTx.birthHash };
    const ok = await gate(
      demoInput,
      realTx.signer,
      realTx.nonce,
      checkpoint,
      realTx.extrinsic,
      true,
    );
    expect(ok.ok ? "passed" : ok.message).toBe("passed");
    const bad = await gate(
      demoInput,
      realTx.signer,
      realTx.nonce,
      checkpoint,
      realTx.extrinsic,
      false,
    );
    expect(!bad.ok && bad.message).toMatch(/signed_signature_invalid/);
  });
});
