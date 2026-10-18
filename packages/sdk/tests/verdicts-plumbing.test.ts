// Seam.execute({ verdicts }) reaches every receipt it builds. ALL V3 shapes/events here are SYNTHETIC test data:
// nothing was observed on Portaldot V3. The plan is a compiled transfer whose step is relabelled nfts.mint (the compiler
// cannot build one without observed V3 metadata), so only the receipt wiring is exercised, not any chain behaviour.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { Hex, Plan } from "@seam/compiler";
import { definePolicy, evaluatePolicy, planDigest, type SigningEnvelope } from "@seam/policy";
import {
  Seam,
  SYNTHETIC_NFTS_SHAPE,
  action,
  defineManifest,
  factsFromSnapshot,
  verifyNftsMintOutcome,
  type ChainAdapter,
  type ChainEvent,
  type WalletSigner,
} from "../src/index.js";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const OWNER = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const facts = factsFromSnapshot(fileURLToPath(new URL("./fixtures", import.meta.url)));
const policy = definePolicy({
  allowedAssets: ["1"],
  allowedRecipients: [BOB],
  allowUnknown: { storageDeposit: true },
});
const honest: WalletSigner = {
  sign: async (calls) => calls.map((c) => ({ signedTx: c, signedCall: c })),
};
const events: ChainEvent[] = [
  { pallet: "Nfts", name: "Issued", args: ["7", "42", OWNER] },
  { pallet: "System", name: "ExtrinsicSuccess", args: ["{}"] },
];
const verdict = (observedShape: boolean) =>
  verifyNftsMintOutcome(
    { status: "finalized", events, observedShape, shape: SYNTHETIC_NFTS_SHAPE },
    { collection: "7", item: "42", mintTo: OWNER as Hex },
  );

function chain(steps: string[]): ChainAdapter {
  return {
    discover: async () => facts,
    readFingerprint: async () => facts.fingerprint,
    preflight: async (plan: Plan) => ({
      preflight: {
        steps: plan.steps.map((s) => ({
          actionId: s.actionId,
          weight: { value: "1" },
          fee: { value: "1" },
          storageDeposit: { unknown: true },
          dryRun: "ok" as const,
        })),
        totalFee: { value: "1" },
      },
      envelope: {
        signer: ALICE,
        nonce: 7,
        mortalityBlocks: 64,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        checkpoint: { number: 100, hash: `0x${"ab".repeat(32)}` },
      } satisfies SigningEnvelope,
    }),
    dryRunSigned: async (txs: Hex[]) => txs.map(() => "ok"),
    submit: async (_t: Hex, id: string) => {
      steps.push(id);
      return {
        actionId: id,
        status: "finalized",
        txHash: "0xaa",
        block: { number: 1, hash: `0x${"01".repeat(32)}` },
        events,
      };
    },
    verifySigned: (txs: Hex[]) => ({ ok: true, signedCalls: txs, reasons: [] }),
    signedDecoder: () => (xt: Hex) => ({ call: xt, signer: ALICE, signatureValid: true }),
  } as unknown as ChainAdapter;
}

async function run(verdicts?: Parameters<Seam["execute"]>[0]["verdicts"], two = false) {
  const submitted: string[] = [];
  const seam = new Seam(chain(submitted));
  const m = defineManifest({
    signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
    actions: [
      action.transfer("pay", { assetId: "1", amount: "2500", recipient: BOB }),
      ...(two ? [action.transfer("pay2", { assetId: "1", amount: "1", recipient: BOB })] : []),
    ],
  });
  const p = await seam.prepare(m, facts, policy);
  const relabelled = {
    ...p.plan,
    steps: [{ ...p.plan.steps[0]!, kind: "nfts.mint" }, ...p.plan.steps.slice(1)],
  } as Plan;
  const plan = { ...relabelled, planDigest: planDigest(relabelled) } as Plan;
  const policyResult = evaluatePolicy({ policy, plan, facts, preflight: p.preflight, manifest: m });
  const a = seam.approve({ ...p, plan, policyResult, policy, facts });
  if (!a.ok) throw new Error(a.reason);
  const r = await seam.execute({
    ...p,
    plan,
    policyResult,
    policy,
    facts,
    approval: a.approval,
    wallet: honest,
    ...(verdicts ? { verdicts } : {}),
  });
  if (!r.ok) throw new Error(r.reason);
  return { receipt: r.receipt, stoppedReason: r.stoppedReason, submitted };
}

describe("Seam.execute verdicts plumbing (SYNTHETIC)", () => {
  it("without verdicts the nfts.mint step stays unsupported_runtime (unchanged)", async () => {
    const { receipt: r } = await run();
    expect(r.steps[0]!.code).toBe("unsupported_runtime");
    expect(r.result).not.toBe("verified");
  });
  it("with an observed-shape verdict the receipt reflects effect_proven", async () => {
    const { receipt: r } = await run({ pay: verdict(true) });
    expect([r.steps[0]!.verification, r.steps[0]!.coverage]).toEqual(["verified", "effect_proven"]);
  });
  it("a capped verdict (shape not observed) is never effect_proven", async () => {
    const { receipt: r } = await run({ pay: verdict(false) });
    expect(r.steps[0]!.coverage).not.toBe("effect_proven");
    expect(r.steps[0]!.verification).not.toBe("verified");
  });
  it("a verdict for another actionId changes nothing", async () => {
    const { receipt: r } = await run({ other: verdict(true) });
    expect(r.steps[0]!.code).toBe("unsupported_runtime");
  });
  it("multi-step sequential run: the verdict also reaches the receipts that gate the next step", async () => {
    const without = await run(undefined, true);
    expect(without.submitted).toEqual(["pay"]);
    expect(without.stoppedReason).toMatch(/SEAM stopped before step 2/);
    const withV = await run({ pay: verdict(true) }, true);
    expect(withV.submitted).toEqual(["pay", "pay2"]);
    expect(withV.receipt.steps[0]!.coverage).toBe("effect_proven");
  });
});
