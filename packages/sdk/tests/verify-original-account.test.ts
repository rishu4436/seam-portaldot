import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  computeFingerprintDigest,
  computePlanDigest,
  type Hex,
  type Plan,
  type PlanStep,
} from "@seam/compiler";
import {
  buildReceipt,
  verifyReceiptLive,
  type ChainEvent,
  type ReceiptChainReader,
  type StepOutcome,
} from "../src/index.js";

const runs = (f: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../evidence/testnet-v3/runs/${f}`, import.meta.url)),
      "utf8",
    ),
  );
// REAL records from the hosted V3 testnet (spec 3002).
const MAP = runs("map-account-1792408724499.json");
const RUNTIME = runs("plan-revive-call-1792412445848.json").fingerprint;
const SIGNER = "0x80270a11d7b2e2b8b2dfb1ca3a45ab3b3f2339613709108c72f04074a8048467" as Hex;
const H160 = "0x81ed1dfbec067703fdca3daa7efcbeff4ba101ec";
const OTHER = ("0x" + "22".repeat(32)) as Hex;
const events: ChainEvent[] = MAP.events.map((e: ChainEvent) => ({
  pallet: e.pallet,
  name: e.name,
  args: e.args,
}));
const TX = MAP.txHash as Hex;
const BLOCK = MAP.block as { number: number; hash: Hex };

const step = {
  actionId: "map",
  kind: "revive.map_account",
  capability: "Revive.map_account",
  palletIndex: 80,
  callIndex: 7,
  decodedArgs: { account: SIGNER },
  encodedCall: "0x5007",
  status: "ok",
} as unknown as PlanStep;
const base = {
  planVersion: 1,
  manifestDigest: ("0x" + "01".repeat(32)) as Hex,
  fingerprintDigest: computeFingerprintDigest(RUNTIME),
  signer: { publicKey: SIGNER },
  mode: "sequential",
  modeReason: "test",
  steps: [step],
  planDigest: "0x" as Hex,
} as unknown as Plan;
const plan: Plan = { ...base, planDigest: computePlanDigest(base) };
const outcome: StepOutcome = {
  actionId: "map",
  status: "finalized",
  txHash: TX,
  block: BLOCK,
  events,
  callHex: "0x5007" as Hex,
};
const readAs = (accountId: string | null) => ({
  originalAccount: { h160: H160, accountId },
});
const verifiedReceipt = buildReceipt({
  plan,
  outcomes: [outcome],
  runtime: RUNTIME,
  effects: { map: readAs(SIGNER) },
});
const unknownReceipt = buildReceipt({ plan, outcomes: [outcome], runtime: RUNTIME });

const chain = (over: Partial<ReceiptChainReader> = {}): ReceiptChainReader => ({
  finalizedNumber: async () => BLOCK.number + 10,
  canonicalHash: async (n) => (n === BLOCK.number ? BLOCK.hash : null),
  readTx: async (b, t) =>
    b === BLOCK.hash && t === TX
      ? { extrinsicIndex: 2, signer: SIGNER, callHex: "0x5007" as Hex, events }
      : null,
  runtimeFingerprint: async () => RUNTIME,
  ...over,
});
const live = (r = verifiedReceipt, reader = chain(), opts = {}) =>
  verifyReceiptLive(r, reader, { plan, runtime: RUNTIME, ...opts });

describe("verify-live: revive.map_account via ReceiptChainReader.originalAccount", () => {
  it("fixtures: the receipt built with a signer read is verified", () => {
    expect(verifiedReceipt.steps[0]).toMatchObject({
      verification: "verified",
      basis: "original_account_readback",
    });
    expect(unknownReceipt.steps[0]!.verification).toBe("unknown");
  });
  it("read maps to the signer => chain_verified, read at the step's block for the signer's H160", async () => {
    const calls: [string, string | undefined][] = [];
    const v = await live(
      verifiedReceipt,
      chain({
        originalAccount: async (h, at) => {
          calls.push([h, at]);
          return SIGNER;
        },
      }),
    );
    expect(v.problems).toEqual([]);
    expect(v.status).toBe("chain_verified");
    expect(v.steps).toEqual([{ actionId: "map", status: "chain_verified" }]);
    expect(calls).toEqual([[H160, BLOCK.hash]]);
  });
  it("no originalAccount method => unknown, not failed", async () => {
    const v = await live();
    expect(v.status).toBe("unknown");
    expect(v.problems).toEqual([]);
    expect(v.steps[0]!.status).toBe("unknown");
    expect(v.notes.join("\n")).toMatch(/cannot read Revive\.OriginalAccount/);
  });
  it("read throws => unknown, not failed", async () => {
    const v = await live(
      verifiedReceipt,
      chain({
        originalAccount: async () => {
          throw new Error("rpc down");
        },
      }),
    );
    expect(v.status).toBe("unknown");
    expect(v.problems).toEqual([]);
    expect(v.notes.join("\n")).toMatch(/read failed \(rpc down\)/);
  });
  it("undecodable value => unknown, not failed", async () => {
    const v = await live(verifiedReceipt, chain({ originalAccount: async () => "0x1234" as Hex }));
    expect(v.status).toBe("unknown");
    expect(v.problems).toEqual([]);
    expect(v.notes.join("\n")).toMatch(/could not be decoded/);
  });
  it("read maps to a different account => failed with a problem", async () => {
    const v = await live(verifiedReceipt, chain({ originalAccount: async () => OTHER }));
    expect(v.status).toBe("failed");
    expect(v.steps[0]!.status).toBe("failed");
    expect(v.problems.join("\n")).toMatch(/not_verified \(effect_mismatch\)/);
  });
  it("read shows unmapped => failed with a problem", async () => {
    const v = await live(verifiedReceipt, chain({ originalAccount: async () => null }));
    expect(v.status).toBe("failed");
    expect(v.problems.join("\n")).toMatch(/effect_mismatch/);
  });
  it("a caller-supplied read in effects is never used live", async () => {
    const v = await live(verifiedReceipt, chain(), { effects: { map: readAs(SIGNER) } });
    expect(v.status).toBe("unknown");
    expect(v.problems).toEqual([]);
  });
  it("receipt says unknown but the chain now proves the mapping => unknown, not failed", async () => {
    const v = await live(unknownReceipt, chain({ originalAccount: async () => SIGNER }));
    expect(v.status).toBe("unknown");
    expect(v.problems).toEqual([]);
  });
  it("without the runtime the check stays capped (unknown), reader not needed", async () => {
    const v = await verifyReceiptLive(
      verifiedReceipt,
      chain({ originalAccount: async () => SIGNER }),
      { plan },
    );
    expect(v.status).toBe("unknown");
    expect(v.problems).toEqual([]);
  });
});
