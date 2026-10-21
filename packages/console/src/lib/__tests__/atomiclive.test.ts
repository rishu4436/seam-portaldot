// @vitest-environment node
// Atomic LIVE (Utility.batch_all): one engine approval, ONE //Alice dev-key signature over the batch_all call (public
// dev key, test only; never a wallet or keystore), the REAL @seam/chain/browser decoder in the submit gate, then a FAKED
// submit (nothing is broadcast). The run's receipt is atomic_unverified unless the policy's rollbackProofOk accepts the
// facts' batch_all rollback proof. Per-step verdicts come from perStepOfBatch + verifyStep on the faked outcome.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { u8aToHex } from "@polkadot/util";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { describe, expect, it, vi } from "vitest";
import { compile, factsFromMetadata } from "@seam/compiler/browser";
import * as chainBrowser from "@seam/chain/browser";
import { newApprovalStore, preSign, preSubmit, type ChainFns } from "../signflow";
import { atomicStepReceipts } from "../stepverify";
import { buildLiveReceipt } from "../livereceipt";
import { runAtomicity } from "../atomicity";

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
}) as unknown as {
  fingerprint: { genesisHash: string; metadataHash: string; specVersion: number };
  behaviour: Record<string, unknown>;
};
const RECIPIENT = "0x76d0e8b40899d424129b4ec688f889b3ce5cb12cadfa72c8898f4cb25d7cb172";

async function setup() {
  await cryptoWaitReady();
  const alice = new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri("//Alice");
  const pay = demo.manifest.actions[0];
  const manifest = {
    ...demo.manifest,
    signer: { type: "ss58", value: alice.address },
    actions: [
      { ...pay, id: "pay1", preferredMode: "atomic" },
      { ...pay, id: "pay2", preferredMode: "atomic" },
    ],
  };
  const plan = compile(
    manifest as never,
    facts as never,
    { allowAtomicUnverified: true } as never,
  ) as unknown as {
    mode: string;
    outerCall: { encodedCall: `0x${string}` };
    steps: { actionId: string; kind: string }[];
    signer: { publicKey: string };
  };
  const policy = { ...seq.policy, allowedModes: ["atomic_unverified"], maxSteps: 2 };
  return { alice, manifest, plan, policy };
}

// Shaped like @seam/chain preflight-core for an atomic plan: per-step dryRun stays "unknown"; the one signed batch's
// system_dryRun outcome is in transactions[0].
const result = (p: unknown) => ({
  ...recorded,
  steps: (p as { steps: { actionId: string }[] }).steps.map((s) => ({
    ...recorded.steps[0],
    actionId: s.actionId,
    dryRun: "unknown",
  })),
});
const chain = (): ChainFns => ({
  preflight: vi.fn(async (_s, p: unknown) => result(p)),
  preflightReport: vi.fn(async (_s, p: unknown, _f, o?: { signedExtrinsics?: string[] }) => ({
    result: result(p),
    atBlock: { number: 130000, hash: "0x" + "34".repeat(32) },
    transactions: (o?.signedExtrinsics ?? []).map(() => ({
      dryRun: { outcome: "ok" as const, detail: "system_dryRun: dispatch ok" },
    })),
  })),
  signedExtrinsicDecoder: (f: unknown, ctx?: unknown) =>
    chainBrowser.signedExtrinsicDecoder(f as never, ctx as never) as never,
  blockTimeFromFacts: chainBrowser.blockTimeFromFacts as never,
  buildSigningEnvelope: chainBrowser.buildSigningEnvelope as never,
});

describe("atomic batch_all LIVE (//Alice, real decoder, faked submit)", () => {
  it("compiles to one batch_all call, one approval, one signature, passes the submit gate; receipt atomic_unverified", async () => {
    const { alice, manifest, plan, policy } = await setup();
    expect(plan.mode).toBe("atomic_unverified");
    expect(plan.outerCall.encodedCall).toMatch(/^0x/);
    const c = chain();
    const checkpoint = { number: realTx.birth, hash: realTx.birthHash };
    const now = new Date();
    const pre = await preSign({
      chain: c,
      send: async () => null,
      input: { policy, plan, manifest } as never,
      facts,
      signer: alice.address,
      ctx: {
        nonce: 3,
        mortalityBlocks: 64,
        checkpointNumber: checkpoint.number,
        checkpointHash: checkpoint.hash,
      },
      now,
    });
    if (!pre.res.ok) throw new Error(pre.res.message);
    // ONE signature, over the batch_all outer call.
    const req = chainBrowser.buildSigningRequest(plan.outerCall.encodedCall, facts as never, {
      signer: alice.address,
      nonce: 3,
      mortalityBlocks: 64,
      checkpoint,
    });
    const signed = chainBrowser.assembleSignedExtrinsic(
      req.payload,
      u8aToHex(alice.sign(req.signBytesHex)),
      facts as never,
      { scheme: "sr25519" },
    );
    const decoded = chainBrowser.signedExtrinsicDecoder(
      facts as never,
      pre.res.value.approvalInput.envelope as never,
    )(signed as never);
    expect(decoded?.call).toBe(plan.outerCall.encodedCall);
    expect(decoded?.metadataHashMode).toBe(0);
    const s = await preSubmit({
      chain: c,
      send: async () => null,
      pre: pre.res.value,
      facts,
      signedTx: signed,
      now,
      store: newApprovalStore(),
      freshFingerprint: async () => ({ fingerprint: facts.fingerprint }),
    });
    expect(s.ok ? "passed" : s.message).toBe("passed");

    // Faked submit: a finalized batch with both transfers (nothing broadcast).
    const ev = {
      pallet: "Assets",
      name: "Transferred",
      args: ["806707", plan.signer.publicKey, RECIPIENT, "1"],
    };
    const outcome = {
      status: "finalized" as const,
      txHash: "0x" + "12".repeat(32),
      block: { number: 130000, hash: "0x" + "34".repeat(32) },
      events: [
        ev,
        ev,
        { pallet: "Utility", name: "BatchCompleted", args: [] },
        { pallet: "System", name: "ExtrinsicSuccess", args: [] },
      ],
    };
    const steps = atomicStepReceipts(
      plan,
      outcome as never,
      decoded?.call,
      plan.signer.publicKey,
      facts.fingerprint as never,
    );
    expect(steps).toHaveLength(2);
    const atomicity = runAtomicity(plan, facts);
    expect(atomicity?.status).toBe("atomic_unverified");
    const receipt = buildLiveReceipt({
      out: {
        status: "unverified",
        message: "",
        coverage: "extrinsic_finalized",
        simulation: "none",
        signing: "binding_ok",
        txState: "finalized",
        provenance: "chain_verified",
        rpcAttempts: 1,
        submitted: true,
        txHash: outcome.txHash,
        block: outcome.block,
      } as never,
      effect: { verdict: "effect_proven", steps } as never,
      checked: true,
      atomicity,
    });
    expect(receipt.atomicity?.status).toBe("atomic_unverified");
    const t = JSON.stringify(receipt);
    expect(t).not.toContain(signed.slice(2, 80));
    expect(t).not.toMatch(/metadataHex/);
  });
});

describe("runAtomicity rule", () => {
  const kinds = [{ kind: "assets.transfer" }];
  const proof = {
    genesisHash: facts.fingerprint.genesisHash,
    metadataHash: facts.fingerprint.metadataHash,
    specVersion: facts.fingerprint.specVersion,
    txHash: "0x" + "ee".repeat(32),
    preState: { supply: "1" },
    postState: { supply: "1" },
    composition: ["assets.transfer"],
  };
  const withProof = (p: object) => ({
    ...facts,
    behaviour: { batchAllRollback: "verified", batchAllRollbackProof: p },
  });
  it("non-atomic plans get no atomicity field", () => {
    expect(runAtomicity({ mode: "sequential", steps: kinds }, facts)).toBeUndefined();
  });
  it("atomic_unverified plan stays unverified", () => {
    expect(runAtomicity({ mode: "atomic_unverified", steps: kinds }, facts)?.status).toBe(
      "atomic_unverified",
    );
  });
  it("atomic_verified plan is verified only when the policy accepts the rollback proof", () => {
    const plan = { mode: "atomic_verified", steps: kinds };
    expect(runAtomicity(plan, withProof(proof))?.status).toBe("atomic_verified");
    const bad = runAtomicity(plan, withProof({ ...proof, genesisHash: "0x" + "00".repeat(32) }));
    expect(bad).toMatchObject({ status: "atomic_unverified" });
    expect(bad?.reason).toMatch(/genesisHash/);
    expect(
      runAtomicity(plan, { ...facts, behaviour: { batchAllRollback: "verified" } })?.status,
    ).toBe("atomic_unverified");
    expect(runAtomicity(plan, undefined)?.status).toBe("atomic_unverified");
  });
});
