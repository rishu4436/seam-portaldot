/**
 * Plan-bytes binding through the SDK flow (policy 50d2911 + compiler verifyPlan 1021d28): when the caller passes the
 * Manifest, Seam.approve / Seam.execute recompile it on the live facts and refuse a plan whose bytes differ, even if
 * the attacker recomputed the plan digest and left decodedArgs honest.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { Hex, Plan } from "@seam/compiler";
import { definePolicy, planDigest, type SigningEnvelope } from "@seam/policy";
import {
  Seam,
  defineManifest,
  action,
  factsFromSnapshot,
  type ChainAdapter,
  type StepOutcome,
  type WalletSigner,
} from "../src/index.js";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const CHARLIE = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";
const facts = factsFromSnapshot(fileURLToPath(new URL("./fixtures", import.meta.url)));
const policy = definePolicy({ allowedAssets: ["1"], allowedRecipients: [BOB] });
const payTo = (recipient: string) =>
  defineManifest({
    signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
    actions: [action.transfer("pay", { assetId: "1", amount: "2500", recipient })],
  });

function fake() {
  const log = { submits: [] as string[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
  const chain: any = {
    discover: async () => facts,
    readFingerprint: async () => facts.fingerprint,
    preflight: async (plan: Plan) => ({
      preflight: {
        steps: plan.steps.map((s) => ({
          actionId: s.actionId,
          weight: { value: "1" },
          fee: { value: "1" },
          storageDeposit: { value: "0" },
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
    submit: async (_tx: Hex, id: string): Promise<StepOutcome> => {
      log.submits.push(id);
      return { actionId: id, status: "not_run", events: [] };
    },
    verifySigned: (txs: Hex[], calls: Hex[]) => {
      const ok = txs.length === calls.length && txs.every((t, i) => t === calls[i]);
      return { ok, signedCalls: txs, reasons: ok ? [] : ["call_mismatch"] };
    },
    signedDecoder: () => (xt: Hex) => ({ call: xt, signer: ALICE, signatureValid: true }),
  };
  return { chain: chain as ChainAdapter, log };
}
const wallet: WalletSigner = {
  sign: async (calls) => calls.map((c) => ({ signedTx: c, signedCall: c })),
};
const live = { currentBlockNumber: () => 101, currentAccountNonce: () => 7 };

/** decodedArgs still say Bob (policy passes), the call bytes pay Charlie, digest recomputed. */
function forge(honest: Plan, seam: Seam): Plan {
  const evil = seam.compile(payTo(CHARLIE), facts);
  const p = JSON.parse(JSON.stringify(honest)) as Plan;
  (p.steps[0] as { encodedCall?: Hex }).encodedCall = evil.steps[0]!.encodedCall;
  return { ...p, planDigest: planDigest(p) } as Plan;
}

describe("SDK flow: plan-bytes binding", () => {
  it("honest plan: approve (requirePlanVerified) and live execute pass and submit", async () => {
    const { chain, log } = fake();
    const seam = new Seam(chain);
    const manifest = payTo(BOB);
    const p = await seam.prepare(manifest, facts, policy);
    const a = seam.approve({ ...p, policy, facts, manifest, requirePlanVerified: true });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const r = await seam.execute({
      ...p,
      policy,
      facts,
      approval: a.approval,
      wallet,
      manifest,
      live,
    });
    expect(r.ok).toBe(true);
    expect(log.submits).toEqual(["pay"]);
  });

  it("edited plan paying Charlie with recomputed digest: approve refuses", async () => {
    const { chain } = fake();
    const seam = new Seam(chain);
    const manifest = payTo(BOB);
    const p = await seam.prepare(manifest, facts, policy);
    const plan = forge(p.plan, seam);
    // Without the Manifest the old gate approves it: this is the hole.
    expect(seam.approve({ ...p, plan, policy, facts }).ok).toBe(true);
    const a = seam.approve({ ...p, plan, policy, facts, manifest });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toMatch(/call bytes/);
  });

  it("edited plan approved without the Manifest is blocked at submit with plan_bytes_mismatch, zero submits", async () => {
    const { chain, log } = fake();
    const seam = new Seam(chain);
    const manifest = payTo(BOB);
    const p = await seam.prepare(manifest, facts, policy);
    const plan = forge(p.plan, seam);
    const a = seam.approve({ ...p, plan, policy, facts });
    if (!a.ok) throw new Error(a.reason);
    const r = await seam.execute({
      ...p,
      plan,
      policy,
      facts,
      approval: a.approval,
      wallet,
      manifest,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.check?.reasons.map((x) => x.code)).toContain("plan_bytes_mismatch");
    expect(log.submits).toEqual([]);
  });

  it("live mode without the Manifest fails closed (live_manifest_missing), zero submits", async () => {
    const { chain, log } = fake();
    const seam = new Seam(chain);
    const p = await seam.prepare(payTo(BOB), facts, policy);
    const a = seam.approve({ ...p, policy, facts });
    if (!a.ok) throw new Error(a.reason);
    const r = await seam.execute({ ...p, policy, facts, approval: a.approval, wallet, live });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.check?.reasons.map((x) => x.code)).toContain("live_manifest_missing");
    expect(log.submits).toEqual([]);
  });
});
