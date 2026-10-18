import { describe, expect, it, beforeAll } from "vitest";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import type { Plan, RuntimeFacts } from "@seam/compiler";
import {
  InMemoryApprovalStore,
  checkBeforeSubmit,
  createApproval,
  evaluatePolicy,
  portaldotPolicy,
  type Policy,
} from "@seam/policy";
import {
  assembleSignedExtrinsic,
  buildSigningRequests,
  dryRunSigned,
  fingerprintFromChainInputs,
  preflight,
  readCheckpoint,
  signedCallsOf,
  type Hex,
} from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import {
  ALICE,
  BOB,
  CHARLIE,
  atomicPlan,
  demoManifest,
  demoPlan,
  devKeys,
  snapshotFacts,
  snapshotInputs,
} from "./helpers.js";

const limits = {
  allowedAssets: ["1", "2"],
  allowedContracts: [CHARLIE],
  allowedRecipients: [BOB],
  maxAmountPerAsset: { "1": "5000000000000000", "2": "1" },
  maxNativeValue: "0",
  maxGasLimit: "10000000000",
  maxWeight: "1000000000",
  maxFee: "10000000000",
};
let keys: Awaited<ReturnType<typeof devKeys>>;
beforeAll(async () => {
  keys = await devKeys();
});

/** Real @seam/policy (fddfee3) end to end on @seam/chain outputs, against the fake node. */
async function run(
  plan: Plan,
  facts: RuntimeFacts,
  policy: Policy,
  nodeOpts: Partial<ConstructorParameters<typeof FakeNode>[0]> = {},
) {
  const node = new FakeNode({
    inputs: snapshotInputs(),
    facts,
    existingAssets: ["1", "2"],
    ...nodeOpts,
  });
  const pf = await preflight(node, plan, facts);
  const policyResult = evaluatePolicy({
    policy,
    plan: plan as never,
    facts: facts as never,
    preflight: pf.result,
    manifest: demoManifest() as never,
  });
  const now = new Date("2026-10-11T12:00:00Z");
  const envelope = {
    signer: ALICE,
    nonce: pf.nonce,
    mortalityBlocks: 64,
    checkpoint: await readCheckpoint(node),
    expiresAt: "2026-10-11T12:30:00Z",
  };
  const base = {
    manifestDigest: plan.manifestDigest,
    plan: plan as never,
    envelope,
    preflight: pf.result,
    policy,
    policyResult,
  };
  const approval = createApproval({ ...base, fingerprint: facts.fingerprint, now });
  if (!approval.ok) throw new Error(approval.reason);
  const signed = buildSigningRequests(plan, facts, envelope).map((q) =>
    assembleSignedExtrinsic(
      q.payload,
      u8aToHex(keys.alice.sign(hexToU8a(q.signBytesHex), { withType: true })),
      facts,
    ),
  );
  const dry = await dryRunSigned(node, signed, facts);
  const store = new InMemoryApprovalStore();
  const gate = (
    o: {
      signedCalls?: Hex[];
      current?: RuntimeFacts["fingerprint"];
      signedDryRun?: typeof dry.results;
      sendIndex?: number;
      previousSteps?: [];
    } = {},
  ) =>
    checkBeforeSubmit({
      ...base,
      approval: approval.approval,
      preparedFingerprint: facts.fingerprint,
      currentFingerprint: o.current ?? fingerprintFromChainInputs(snapshotInputs()).fingerprint,
      signedCalls: o.signedCalls ?? signedCallsOf(signed, facts),
      signedDryRun: o.signedDryRun ?? dry.results,
      now,
      store,
      ...(o.sendIndex !== undefined
        ? { sendIndex: o.sendIndex, previousSteps: o.previousSteps ?? [] }
        : {}),
    });
  return { policyResult, approval, envelope, signed, dry, gate };
}

describe("plugs into Bot 3's policy package (fddfee3) as-is", () => {
  it("createApproval refuses an envelope without a checkpoint; the chain envelope has one", async () => {
    const facts = snapshotFacts();
    const { envelope, policyResult } = await run(demoPlan(), facts, portaldotPolicy(limits));
    expect(policyResult.allowed).toBe(true);
    expect(envelope.checkpoint).toEqual({ number: 2721455, hash: snapshotInputs().head.hash });
    const pf = { steps: [], totalFee: { value: "0" } };
    const noCheckpoint = createApproval({
      manifestDigest: demoPlan().manifestDigest,
      plan: demoPlan() as never,
      envelope: { ...envelope, checkpoint: undefined as never },
      preflight: pf,
      policy: portaldotPolicy(limits),
      policyResult,
      fingerprint: facts.fingerprint,
      now: new Date("2026-10-11T12:00:00Z"),
    });
    expect(noCheckpoint.ok).toBe(false);
  });

  it("atomic plan: the signed batch_all dry-runs ok and the gate passes with requireSignedDryRun on", async () => {
    const { plan, facts } = atomicPlan();
    const { dry, gate, signed } = await run(plan, facts, portaldotPolicy(limits));
    expect(dry.results).toEqual(["ok"]);
    expect(gate()).toMatchObject({ ok: true, reasons: [] });

    // a wallet that signed something else is caught from the extracted bytes
    const seq = buildSigningRequests(demoPlan(), snapshotFacts(), {
      signer: ALICE,
      nonce: 0,
      mortalityBlocks: 64,
      checkpoint: { number: 2721455, hash: snapshotInputs().head.hash },
      expiresAt: "x",
    });
    expect(gate({ signedCalls: [seq[0]!.callHex] }).reasons.map((r) => r.code)).toEqual([
      "signed_bytes_mismatch",
    ]);
    // a runtime change seen by the re-read is caught
    const inputs = snapshotInputs();
    const upgraded = fingerprintFromChainInputs({
      ...inputs,
      properties: { ...inputs.properties, tokenDecimals: 12 },
    }).fingerprint;
    expect(gate({ current: upgraded }).reasons.map((r) => r.code)).toEqual(["runtime_changed"]);
    expect(signed).toHaveLength(1);
  });

  it("a failed signed dry run always blocks", async () => {
    const { plan, facts } = atomicPlan();
    const { dry, gate } = await run(plan, facts, portaldotPolicy(limits), {
      failCall: () => ({ index: 26, error: 0 }),
    });
    expect(dry.results).toEqual(["failed"]);
    expect(dry.details[0]!.detail).toMatch(/assets\.BalanceLow/);
    expect(gate().reasons.map((r) => r.code)).toEqual(["signed_dry_run_failed"]);
  });

  it("sequential plan, requireSignedDryRun on: the per-step gate (sendIndex) needs only that step's dry run", async () => {
    const facts = snapshotFacts();
    const strict = await run(demoPlan(), facts, portaldotPolicy(limits));
    // later transactions have future nonces, so they are 'unknown' until the earlier ones are on chain
    expect(strict.dry.results).toEqual(["ok", "unknown", "unknown"]);
    expect(strict.dry.details[1]!.detail).toMatch(/nonce is in the future/);
    // gating the whole plan at once can't pass; gating step 1 on its own does
    expect(strict.gate().reasons.map((r) => r.code)).toContain("signed_dry_run_missing");
    expect(strict.gate({ sendIndex: 0 })).toMatchObject({ ok: true, reasons: [] });
    // step 2 can't go before step 1 was sent, and its own dry run must be ok
    const codes = strict.gate({ sendIndex: 1 }).reasons.map((r) => r.code);
    expect(codes).toContain("out_of_order");
    expect(codes).toContain("signed_dry_run_missing");
  });
});
