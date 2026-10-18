/**
 * SEAM-002 (continue only after finalized AND verified; later steps not_run) and SEAM-005 (reserve before submit,
 * commit on ack, release on definite rejection, uncertain on ambiguity, reconcile, never a blind retry).
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { Hex, Plan } from "@seam/compiler";
import { definePolicy, InMemoryApprovalStore, usageKey, type SigningEnvelope } from "@seam/policy";
import {
  Seam,
  defineManifest,
  action,
  factsFromSnapshot,
  type ChainAdapter,
  type ChainEvent,
  type StepOutcome,
  type WalletSigner,
} from "../src/index.js";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const ALICE_HEX = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const BOB_HEX = "0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48";
const facts = factsFromSnapshot(fileURLToPath(new URL("./fixtures", import.meta.url)));
const policy = definePolicy({
  allowedAssets: ["1", "2"],
  allowedContracts: [BOB],
  allowedRecipients: [BOB],
  allowUnknown: { storageDeposit: true },
});
const manifest = () =>
  defineManifest({
    signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
    actions: [
      action.transfer("pay", { assetId: "1", amount: "2500", recipient: BOB }),
      action.contractCall("call", {
        contract: BOB,
        value: "0",
        gasLimit: "5000000000",
        data: "0x633aa551",
      }),
      action.mint("receipt", { assetId: "2", amount: "1", recipient: BOB }),
    ],
  });
const blk = (n: number) => ({ number: n, hash: `0x${n.toString(16).padStart(64, "0")}` as Hex });
const ev = (pallet: string, name: string, ...args: string[]): ChainEvent => ({
  pallet,
  name,
  args,
});
const SUCCESS = ev("System", "ExtrinsicSuccess", "{}");
const good: StepOutcome[] = [
  {
    actionId: "pay",
    status: "finalized",
    txHash: "0xaa",
    block: blk(1),
    events: [ev("Assets", "Transferred", "1", ALICE_HEX, BOB_HEX, "2500"), SUCCESS],
  },
  {
    actionId: "call",
    status: "finalized",
    txHash: "0xbb",
    block: blk(2),
    events: [ev("Contracts", "ContractEmitted", BOB_HEX, "0x01"), SUCCESS],
  },
  {
    actionId: "receipt",
    status: "finalized",
    txHash: "0xcc",
    block: blk(3),
    events: [ev("Assets", "Issued", "2", BOB_HEX, "1"), SUCCESS],
  },
];

type Step = (StepOutcome & { delivery?: string }) | "throw";
function fake(steps: Step[], store: InMemoryApprovalStore, lookup?: any) {
  const log = { submits: [] as string[], statesAtSubmit: [] as (string | undefined)[], key: "" };
  const chain: any = {
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
        totalFee: { value: "3" },
      },
      envelope: {
        signer: ALICE,
        nonce: 7,
        mortalityBlocks: 64,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        checkpoint: { number: 100, hash: `0x${"ab".repeat(32)}` },
      } satisfies SigningEnvelope,
    }),
    dryRunSigned: async (txs: Hex[]) => txs.map((_, i) => (i === 0 ? "ok" : "unknown")),
    submit: async (_tx: Hex, id: string) => {
      const i = log.submits.length;
      log.submits.push(id);
      log.statesAtSubmit.push(store.stateOf(usageKey(log.key as Hex, i))?.state);
      const s = steps[i];
      if (s === "throw") throw new Error("connection lost after send");
      return s ?? { actionId: id, status: "failed", events: [] };
    },
    verifySigned: (txs: Hex[]) => ({ ok: true, signedCalls: txs, reasons: [] }),
    signedDecoder: () => (xt: Hex) => ({ call: xt, signer: ALICE, signatureValid: true }),
  };
  if (lookup) chain.lookupTx = lookup;
  return { chain: chain as ChainAdapter, log };
}
const honest: WalletSigner = {
  sign: async (calls) => calls.map((c) => ({ signedTx: c, signedCall: c })),
};
async function setup(steps: Step[], lookup?: any) {
  const store = new InMemoryApprovalStore();
  const { chain, log } = fake(steps, store, lookup);
  const seam = new Seam(chain, store);
  const p = await seam.prepare(manifest(), facts, policy);
  const a = seam.approve({ ...p, policy, facts });
  if (!a.ok) throw new Error(a.reason);
  log.key = a.approval.hash;
  const exec = () =>
    seam.execute({
      ...p,
      policy,
      facts,
      approval: a.approval,
      wallet: honest,
      effects: { call: { emittedData: "0x01" as Hex } },
    });
  return { seam, store, log, exec, key: (i: number) => usageKey(a.approval.hash, i) };
}

describe("SEAM-002: continue only after finalized AND verified", () => {
  it.each([
    ["included (not final)", { ...good[0]!, status: "included" as const }],
    ["finalized but unverifiable (no Transferred event)", { ...good[0]!, events: [SUCCESS] }],
    [
      "finalized with ExtrinsicFailed",
      { ...good[0]!, events: [ev("System", "ExtrinsicFailed", "x")] },
    ],
  ])("step 1 %s: step 2 is never sent, later steps are not_run", async (_n, first) => {
    const t = await setup([first, good[1]!, good[2]!]);
    const r = await t.exec();
    expect(t.log.submits).toEqual(["pay"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.receipt.steps.map((s) => s.status).slice(1)).toEqual(["not_run", "not_run"]);
      expect(r.stoppedReason).toBeTruthy();
      expect(r.receipt.result).not.toBe("verified");
    }
  });
  it("all steps finalized and verified: runs all three in order", async () => {
    const t = await setup(good);
    const r = await t.exec();
    expect(t.log.submits).toEqual(["pay", "call", "receipt"]);
    expect(r.ok && r.receipt.result).toBe("verified");
  });
});

describe("SEAM-005: reserve, commit, release, uncertain, reconcile, never blind retry", () => {
  it("reserves before submit and commits with the tx hash on acknowledgement", async () => {
    const t = await setup(good);
    await t.exec();
    expect(t.log.statesAtSubmit).toEqual(["reserved", "reserved", "reserved"]);
    expect(t.store.stateOf(t.key(0))).toMatchObject({ state: "committed", txHash: "0xaa" });
    expect(t.store.stateOf(t.key(2))).toMatchObject({ state: "committed", txHash: "0xcc" });
  });

  it("a definite rejection releases the reservation (the node never took it)", async () => {
    const t = await setup([
      {
        actionId: "pay",
        status: "failed",
        events: [],
        error: "1010: Invalid Transaction",
        delivery: "rejected",
      } as any,
    ]);
    const r = await t.exec();
    expect(t.log.submits).toEqual(["pay"]);
    expect(t.store.stateOf(t.key(0))).toBeUndefined();
    expect(r.ok && r.uncertain).toBeFalsy();
  });

  it.each([
    ["submit throws after sending", "throw" as Step],
    [
      "adapter reports an uncertain delivery",
      {
        actionId: "pay",
        status: "submitted",
        txHash: "0xaa",
        events: [],
        delivery: "uncertain",
      } as Step,
    ],
  ])(
    "%s: marked uncertain, nothing further is sent, and a second execute does NOT resend",
    async (_n, first) => {
      const t = await setup([first, good[1]!, good[2]!]);
      const r = await t.exec();
      expect(t.log.submits).toEqual(["pay"]);
      expect(t.store.stateOf(t.key(0))?.state).toBe("uncertain");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.uncertain).toMatchObject({ actionId: "pay", index: 0 });
        expect(r.receipt.steps.map((s) => s.status)).not.toContain("finalized");
        expect(r.receipt.result).not.toBe("verified");
      }
      const again = await t.exec();
      expect(again.ok).toBe(false);
      expect(t.log.submits).toEqual(["pay"]); // never a blind retry
    },
  );

  it("reconcile: found_finalized commits the reservation; found_included also commits", async () => {
    for (const state of ["found_finalized", "found_included"] as const) {
      const t = await setup(["throw"], async () => ({ state, block: blk(9) }));
      const r = await t.exec();
      if (!r.ok || !r.uncertain) throw new Error("expected uncertain");
      const rec = await t.seam.reconcile({ uncertain: r.uncertain, txHash: "0xaa" });
      expect(rec.state).toBe("committed");
      expect(t.store.stateOf(t.key(0))?.state).toBe("committed");
    }
  });

  it("reconcile: unknown (RPC unreachable) and a non-definitive not_found stay uncertain; never claim absence", async () => {
    for (const result of [
      { state: "unknown", detail: "rpc unreachable" },
      { state: "not_found", definitive: false },
    ]) {
      const t = await setup(["throw"], async () => result);
      const r = await t.exec();
      if (!r.ok || !r.uncertain) throw new Error("expected uncertain");
      expect((await t.seam.reconcile({ uncertain: r.uncertain })).state).toBe("still_uncertain");
      expect(t.store.stateOf(t.key(0))?.state).toBe("uncertain");
    }
  });

  it("reconcile: a lookup that throws stays uncertain; a definitive not_found releases the key", async () => {
    const a = await setup(["throw"], async () => {
      throw new Error("boom");
    });
    const ra = await a.exec();
    if (!ra.ok || !ra.uncertain) throw new Error("expected uncertain");
    expect((await a.seam.reconcile({ uncertain: ra.uncertain, txHash: "0xaa" })).state).toBe(
      "still_uncertain",
    );
    const b = await setup(["throw"], async () => ({ state: "not_found", definitive: true }));
    const rb = await b.exec();
    if (!rb.ok || !rb.uncertain) throw new Error("expected uncertain");
    expect((await b.seam.reconcile({ uncertain: rb.uncertain, txHash: "0xaa" })).state).toBe(
      "released",
    );
    expect(b.store.stateOf(b.key(0))).toBeUndefined();
  });
});
