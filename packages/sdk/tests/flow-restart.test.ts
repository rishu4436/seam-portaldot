/** SEAM-005 restart: an uncertain send survives a process restart; the second execute is refused; reconcile settles it. */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex, Plan } from "@seam/compiler";
import { definePolicy, usageKey, type SigningEnvelope } from "@seam/policy";
import {
  Seam,
  defineManifest,
  action,
  factsFromSnapshot,
  type ChainAdapter,
  type WalletSigner,
} from "../src/index.js";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const facts = factsFromSnapshot(fileURLToPath(new URL("./fixtures", import.meta.url)));
const policy = definePolicy({
  allowedAssets: ["1"],
  allowedRecipients: [BOB],
  allowUnknown: { storageDeposit: true },
});
const manifest = () =>
  defineManifest({
    signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
    actions: [action.transfer("pay", { assetId: "1", amount: "2500", recipient: BOB })],
  });
const honest: WalletSigner = {
  sign: async (calls) => calls.map((c) => ({ signedTx: c, signedCall: c })),
};

function chain(submit: (id: string) => any, lookup?: any) {
  const log = { submits: 0 };
  const c: any = {
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
      log.submits++;
      return submit(id);
    },
    verifySigned: (txs: Hex[]) => ({ ok: true, signedCalls: txs, reasons: [] }),
    signedDecoder: () => (xt: Hex) => ({ call: xt, signer: ALICE, signatureValid: true }),
  };
  if (lookup) c.lookupTx = lookup;
  return { chain: c as ChainAdapter, log };
}

describe("SEAM-005: durable store through the flow (restart)", () => {
  it("Seam accepts a store file path", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "seam-flow-")), "a.json");
    const { chain: c, log } = chain((id) => ({
      actionId: id,
      status: "finalized",
      txHash: "0xaa",
      block: { number: 1, hash: `0x${"01".repeat(32)}` },
      events: [
        {
          pallet: "Assets",
          name: "Transferred",
          args: [
            "1",
            "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
            "0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48",
            "2500",
          ],
        },
        { pallet: "System", name: "ExtrinsicSuccess", args: ["{}"] },
      ],
    }));
    const seam = new Seam(c, path);
    const p = await seam.prepare(manifest(), facts, policy);
    const a = seam.approve({ ...p, policy, facts });
    if (!a.ok) throw new Error(a.reason);
    const r = await seam.execute({ ...p, policy, facts, approval: a.approval, wallet: honest });
    expect(r.ok).toBe(true);
    expect(log.submits).toBe(1);
    // a restarted process with the same file: the approval is already used
    const seam2 = new Seam(
      chain(() => {
        throw new Error("must not be called");
      }).chain,
      path,
    );
    const r2 = await seam2.execute({ ...p, policy, facts, approval: a.approval, wallet: honest });
    expect(r2.ok).toBe(false);
  });

  it("uncertain send, crash, restart: second execute refused, reconcile via lookupTx settles to committed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "seam-flow-")), "a.json");
    const first = chain(() => {
      throw new Error("connection lost after send");
    });
    const s1 = new Seam(first.chain, path);
    const p = await s1.prepare(manifest(), facts, policy);
    const a = s1.approve({ ...p, policy, facts });
    if (!a.ok) throw new Error(a.reason);
    const r1 = await s1.execute({ ...p, policy, facts, approval: a.approval, wallet: honest });
    if (!r1.ok || !r1.uncertain) throw new Error("expected an uncertain send");
    expect(first.log.submits).toBe(1);

    // --- crash: everything in memory is gone; only the file remains ---
    const second = chain(
      () => {
        throw new Error("must not be sent again");
      },
      async () => ({
        state: "found_finalized",
        block: { number: 5, hash: `0x${"05".repeat(32)}` },
      }),
    );
    const s2 = new Seam(second.chain, path);
    const r2 = await s2.execute({ ...p, policy, facts, approval: a.approval, wallet: honest });
    expect(r2.ok).toBe(false);
    expect(second.log.submits).toBe(0);

    const rec = await s2.reconcile({ uncertain: r1.uncertain, txHash: "0xaa" });
    expect(rec.state).toBe("committed");
    const s3 = new Seam(second.chain, path);
    expect(
      (await s3.execute({ ...p, policy, facts, approval: a.approval, wallet: honest })).ok,
    ).toBe(false); // still used
    expect(second.log.submits).toBe(0);
  });

  it("a corrupt store file: execute fails closed with zero submits", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "seam-flow-")), "a.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "garbage");
    const { chain: c, log } = chain((id) => ({ actionId: id, status: "finalized", events: [] }));
    const seam = new Seam(c, path);
    const p = await seam.prepare(manifest(), facts, policy);
    const a = seam.approve({ ...p, policy, facts });
    if (!a.ok) throw new Error(a.reason);
    await expect(
      seam.execute({ ...p, policy, facts, approval: a.approval, wallet: honest }),
    ).rejects.toThrow(/approval store/i);
    expect(log.submits).toBe(0);
  });
});
