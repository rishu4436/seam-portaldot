import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { compile, type Hex, type Plan } from "@seam/compiler";
import {
  buildReceipt,
  defineManifest,
  action,
  factsFromSnapshot,
  verifyReceiptLive,
  type ChainEvent,
  type ReceiptChainReader,
  type StepOutcome,
} from "../src/index.js";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ALICE_HEX = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d" as Hex;
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const BOB_HEX = "0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48";
const facts = factsFromSnapshot(fileURLToPath(new URL("./fixtures", import.meta.url)));
const ev = (pallet: string, name: string, ...args: string[]): ChainEvent => ({
  pallet,
  name,
  args,
});
const SUCCESS = ev("System", "ExtrinsicSuccess", "{}");
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const signer = { type: "ss58" as const, value: ALICE, ss58Prefix: 42 };

const seqPlan: Plan = compile(
  defineManifest({
    signer,
    actions: [
      action.transfer("a", { assetId: "1", amount: "1", recipient: BOB }),
      action.transfer("b", { assetId: "1", amount: "2", recipient: BOB }),
    ],
  }),
  facts,
);
const tr = (amt: string) => ev("Assets", "Transferred", "1", ALICE_HEX, BOB_HEX, amt);
const seqOutcomes: StepOutcome[] = [
  {
    actionId: "a",
    status: "finalized",
    txHash: H(0xa1),
    block: { number: 5, hash: H(5) },
    events: [tr("1"), SUCCESS],
  },
  {
    actionId: "b",
    status: "finalized",
    txHash: H(0xa2),
    block: { number: 6, hash: H(6) },
    events: [tr("2"), SUCCESS],
  },
];
const seqReceipt = buildReceipt({ plan: seqPlan, outcomes: seqOutcomes });
const seqChain = (
  over: { call?: (id: "a" | "b") => Hex | undefined; events?: ChainEvent[] } = {},
): ReceiptChainReader => ({
  finalizedNumber: async () => 10,
  canonicalHash: async (n) => H(n),
  readTx: async (block, tx) => {
    const id = tx === H(0xa1) ? "a" : tx === H(0xa2) ? "b" : null;
    if (!id || block !== H(id === "a" ? 5 : 6)) return null;
    const callHex = over.call
      ? over.call(id)
      : seqPlan.steps.find((s) => s.actionId === id)!.encodedCall!;
    return {
      extrinsicIndex: 1,
      signer: ALICE_HEX,
      callHex,
      events: over.events ?? seqOutcomes.find((o) => o.actionId === id)!.events,
    };
  },
});

const atomicPlan: Plan = compile(
  defineManifest({
    signer,
    actions: [
      {
        ...action.transfer("a", { assetId: "1", amount: "1", recipient: BOB }),
        preferredMode: "atomic" as const,
      },
      {
        ...action.transfer("b", { assetId: "1", amount: "2", recipient: BOB }),
        preferredMode: "atomic" as const,
      },
    ],
  }),
  facts,
  { allowAtomicUnverified: true },
);
const batchEvents = [tr("1"), tr("2"), ev("Utility", "BatchCompleted"), SUCCESS];
const atomicReceipt = buildReceipt({
  plan: atomicPlan,
  outcomes: [
    {
      actionId: "batch",
      status: "finalized",
      txHash: H(0xb1),
      block: { number: 7, hash: H(7) },
      events: batchEvents,
    },
  ],
});
const atomicChain = (callHex: Hex | undefined): ReceiptChainReader => ({
  finalizedNumber: async () => 10,
  canonicalHash: async (n) => H(n),
  readTx: async (b, t) =>
    t === H(0xb1) && b === H(7)
      ? { extrinsicIndex: 1, signer: ALICE_HEX, callHex, events: batchEvents }
      : null,
});

describe("verify-live hardening: chain_verified requires plan + call comparison + state assertions", () => {
  it("fixtures are what the tests assume", () => {
    expect(seqReceipt.result).toBe("verified");
    expect(atomicPlan.mode).toMatch(/^atomic_/);
    expect(atomicPlan.outerCall?.encodedCall).toBeTruthy();
  });
  it("sequential: plan + every step call + proven effects => chain_verified", async () => {
    const v = await verifyReceiptLive(seqReceipt, seqChain(), { plan: seqPlan });
    expect(v.problems).toEqual([]);
    expect(v.status).toBe("chain_verified");
    expect(v.steps.map((s) => s.status)).toEqual(["chain_verified", "chain_verified"]);
  });
  it("no plan => never chain_verified (unknown, stated)", async () => {
    const v = await verifyReceiptLive(seqReceipt, seqChain());
    expect(v.status).toBe("unknown");
    expect(v.notes.join(" ")).toMatch(/no plan/i);
    expect(v.steps.every((s) => s.status !== "chain_verified")).toBe(true);
  });
  it("plan given but one step call bytes differ => failed", async () => {
    const v = await verifyReceiptLive(
      seqReceipt,
      seqChain({ call: (id) => (id === "b" ? ("0x0102" as Hex) : seqPlan.steps[0]!.encodedCall!) }),
      { plan: seqPlan },
    );
    expect(v.status).toBe("failed");
    expect(v.problems.join(" ")).toMatch(/b: the call on chain is not the planned call/);
  });
  it("call bytes unreadable => unknown, not verified", async () => {
    const v = await verifyReceiptLive(seqReceipt, seqChain({ call: () => undefined }), {
      plan: seqPlan,
    });
    expect(v.status).toBe("unknown");
  });
  it("planned step with no encoded call cannot be compared => unknown", async () => {
    const p = JSON.parse(JSON.stringify(seqPlan)) as Plan;
    p.steps[0]!.encodedCall = null;
    const v = await verifyReceiptLive(seqReceipt, seqChain(), { plan: p });
    expect(v.status).not.toBe("chain_verified");
  });
  it("a plan step missing from the receipt (not run) => unknown, never verified", async () => {
    const partial = buildReceipt({ plan: seqPlan, outcomes: [seqOutcomes[0]!] });
    const v = await verifyReceiptLive(partial, seqChain(), { plan: seqPlan });
    expect(v.status).toBe("unknown");
  });
  it("missing state assertion (contract call, no effect) => unknown, never verified", async () => {
    const cplan = compile(
      defineManifest({
        signer,
        actions: [action.transfer("pay", { assetId: "1", amount: "1", recipient: BOB })],
      }),
      facts,
    );
    const rec = buildReceipt({
      plan: cplan,
      outcomes: [
        {
          actionId: "pay",
          status: "finalized",
          txHash: H(0xc1),
          block: { number: 5, hash: H(5) },
          events: [SUCCESS],
        },
      ],
    });
    // Transfer event absent: the receipt itself is not verified, so the chain cannot be chain_verified.
    expect(rec.steps[0]!.coverage).not.toBe("effect_proven");
    const chain: ReceiptChainReader = {
      finalizedNumber: async () => 10,
      canonicalHash: async (n) => H(n),
      readTx: async () => ({
        extrinsicIndex: 1,
        signer: ALICE_HEX,
        callHex: cplan.steps[0]!.encodedCall!,
        events: [SUCCESS],
      }),
    };
    const v = await verifyReceiptLive(rec, chain, { plan: cplan });
    // The planned Transferred event is missing, so the receipt itself says not_verified: that re-checks as failed.
    if (rec.steps[0]!.verification === "not_verified") {
      expect(v.status).toBe("failed");
      expect(v.problems.join(" ")).toMatch(/not_verified/);
    } else {
      expect(v.status).toBe("unknown");
      expect(v.notes.join(" ")).toMatch(/not effect_proven|state assertion|effect/i);
    }
    expect(v.status).not.toBe("chain_verified");
  });
  it("atomic: outer batch call bytes match => chain_verified", async () => {
    const v = await verifyReceiptLive(
      atomicReceipt,
      atomicChain(atomicPlan.outerCall!.encodedCall),
      { plan: atomicPlan },
    );
    expect(v.problems).toEqual([]);
    expect(v.status).toBe("chain_verified");
  });
  it("atomic: outer batch call bytes differ => failed", async () => {
    const v = await verifyReceiptLive(atomicReceipt, atomicChain("0xdeadbeef" as Hex), {
      plan: atomicPlan,
    });
    expect(v.status).toBe("failed");
    expect(v.problems.join(" ")).toMatch(/batch call/);
  });
  it("atomic: outer call unreadable => unknown", async () => {
    const v = await verifyReceiptLive(atomicReceipt, atomicChain(undefined), { plan: atomicPlan });
    expect(v.status).toBe("unknown");
  });
  it("atomic: plan without outerCall cannot be compared => not chain_verified", async () => {
    const p = JSON.parse(JSON.stringify(atomicPlan)) as Plan;
    delete p.outerCall;
    const v = await verifyReceiptLive(
      atomicReceipt,
      atomicChain(atomicPlan.outerCall!.encodedCall),
      { plan: p },
    );
    expect(v.status).not.toBe("chain_verified");
  });
  it("atomic: no plan => unknown", async () => {
    const v = await verifyReceiptLive(
      atomicReceipt,
      atomicChain(atomicPlan.outerCall!.encodedCall),
    );
    expect(v.status).toBe("unknown");
  });
});
