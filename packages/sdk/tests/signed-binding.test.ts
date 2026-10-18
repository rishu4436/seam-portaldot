/**
 * SEAM-001 SDK side: Seam.execute never trusts the wallet's reported signedCall. It asks the chain adapter to decode
 * every signed transaction against the approved calls, hands the gate the raw bytes plus a trusted decoder, and
 * submits nothing (zero submit calls) if anything differs.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { Hex, Plan } from "@seam/compiler";
import { definePolicy, type SigningEnvelope } from "@seam/policy";
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

/** A fake chain whose "signed transaction" is its call bytes, so decoding is the identity: tampering = a different tx. */
function fake(
  o: {
    omit?: ("verifySigned" | "signedDecoder")[];
    undecodable?: (tx: Hex) => boolean;
    verifyAlwaysOk?: boolean;
  } = {},
) {
  const log = { submits: [] as string[], dryRuns: 0, verifyCalls: 0, decodeCalls: [] as string[] };
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
    dryRunSigned: async (txs: Hex[]) => {
      log.dryRuns++;
      return txs.map((_, i) => (i === 0 ? "ok" : "unknown"));
    },
    submit: async (_tx: Hex, id: string): Promise<StepOutcome> => {
      log.submits.push(id);
      return { actionId: id, status: "not_run", events: [] };
    },
    verifySigned: (txs: Hex[], calls: Hex[]) => {
      log.verifyCalls++;
      const reasons: string[] = [];
      if (txs.length !== calls.length) reasons.push("count_mismatch");
      calls.forEach((c, i) => {
        if (txs[i] !== undefined && txs[i]!.toLowerCase() !== c.toLowerCase())
          reasons.push(`step_${i}:call_mismatch`);
      });
      return { ok: o.verifyAlwaysOk ? true : reasons.length === 0, signedCalls: txs, reasons };
    },
    signedDecoder: () => (xt: Hex) => {
      log.decodeCalls.push(xt);
      return o.undecodable?.(xt) ? null : { call: xt, signer: ALICE, signatureValid: true };
    },
  };
  for (const k of o.omit ?? []) delete chain[k];
  return { chain: chain as ChainAdapter, log };
}
async function run(chain: ChainAdapter, wallet: WalletSigner) {
  const seam = new Seam(chain);
  const p = await seam.prepare(manifest(), facts, policy);
  const a = seam.approve({ ...p, policy, facts });
  if (!a.ok) throw new Error(a.reason);
  return seam.execute({ ...p, policy, facts, approval: a.approval, wallet });
}
const honest: WalletSigner = {
  sign: async (calls) => calls.map((c) => ({ signedTx: c, signedCall: c })),
};
const flip = (c: Hex) => (c.slice(0, -2) + (c.endsWith("00") ? "01" : "00")) as Hex;

describe("SEAM-001 SDK: signed transactions are decoded and bound, wallet signedCall is never trusted", () => {
  it("the wallet REPORTS the expected signedCall but the signedTx carries a different call: blocked, zero submits", async () => {
    const { chain, log } = fake();
    const liar: WalletSigner = {
      sign: async (calls) =>
        calls.map((c, i) => ({ signedTx: i === 1 ? flip(c) : c, signedCall: c })),
    };
    const r = await run(chain, liar);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("submit_gate");
      expect(r.reason).toMatch(/call_mismatch/);
    }
    expect(log.submits).toEqual([]);
    expect(log.dryRuns).toBe(0);
  });

  it.each([
    [
      "fewer signed transactions",
      (calls: Hex[]) => calls.slice(0, 2).map((c) => ({ signedTx: c, signedCall: c })),
    ],
    [
      "extra signed transactions",
      (calls: Hex[]) => [...calls, calls[0]!].map((c) => ({ signedTx: c, signedCall: c })),
    ],
    [
      "wrong order",
      (calls: Hex[]) =>
        [calls[1]!, calls[0]!, calls[2]!].map((c) => ({ signedTx: c, signedCall: c })),
    ],
    [
      "replayed first transaction",
      (calls: Hex[]) =>
        [calls[0]!, calls[0]!, calls[2]!].map((c) => ({ signedTx: c, signedCall: c })),
    ],
  ])("%s: blocked, zero submits", async (_n, make) => {
    const { chain, log } = fake();
    const r = await run(chain, { sign: async (calls) => make(calls) });
    expect(r.ok).toBe(false);
    expect(log.submits).toEqual([]);
  });

  it("an adapter that cannot verify signed transactions fails closed (no verifySigned / no decoder)", async () => {
    for (const omit of [["verifySigned"], ["signedDecoder"]] as const) {
      const { chain, log } = fake({ omit: [...omit] });
      const r = await run(chain, honest);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/cannot (verify|decode)/i);
      expect(log.submits).toEqual([]);
    }
  });

  it("even if the adapter says ok, a transaction the gate cannot decode blocks the run (zero submits)", async () => {
    const { chain, log } = fake({ verifyAlwaysOk: true, undecodable: () => true });
    const r = await run(chain, honest);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.check?.reasons.map((x) => x.code)).toContain("signed_extrinsic_undecodable");
    expect(log.submits).toEqual([]);
  });

  it("the gate is fed the decoded calls (trusted_decoder_required is satisfied) and honest runs submit in order", async () => {
    const { chain, log } = fake();
    const r = await run(chain, honest);
    expect(log.verifyCalls).toBe(1);
    expect(log.decodeCalls.length).toBeGreaterThan(0);
    expect(log.submits[0]).toBe("pay");
    expect(r.ok).toBe(true);
  });

  it("a wallet that reports a DIFFERENT signedCall than it signed is ignored: decoded bytes decide", async () => {
    const { chain, log } = fake();
    const sloppy: WalletSigner = {
      sign: async (calls) => calls.map((c) => ({ signedTx: c, signedCall: flip(c) })),
    };
    const r = await run(chain, sloppy);
    expect(r.ok).toBe(true); // the bytes are honest, so the false report does not matter
    expect(log.submits[0]).toBe("pay");
  });
});
