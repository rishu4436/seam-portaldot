// All events and shapes in this file are SYNTHETIC test data. Nothing here was observed on Portaldot V3, and nothing
// here is evidence that V3 verification works. The tests prove the verifiers fail closed.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { compile, type Hex, type Plan } from "@seam/compiler";
import {
  action,
  buildReceipt,
  defineManifest,
  explainReasonCode,
  factsFromSnapshot,
  REASON_CODE_WORDING,
  SYNTHETIC_NFTS_SHAPE,
  SYNTHETIC_REVIVE_SHAPE,
  verifyNftsMintOutcome,
  verifyReviveCallOutcome,
  type ChainEvent,
  type OutcomeVerdict,
} from "../src/index.js";

const OWNER = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const OTHER = "0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48";
const DEST = "0x1111111111111111111111111111111111111111";
const ev = (pallet: string, name: string, ...args: string[]): ChainEvent => ({
  pallet,
  name,
  args,
});
const SUCCESS = ev("System", "ExtrinsicSuccess", "{}");
const FAILED = ev("System", "ExtrinsicFailed", "Module", "{}");

const nftsWant = { collection: "7", item: "42", mintTo: OWNER };
const nftsEvent = (c = "7", i = "42", o = OWNER) => ev("Nfts", "Issued", c, i, o);
const nfts = (
  events: ChainEvent[],
  over: {
    status?: "finalized" | "included" | "failed";
    observedShape?: boolean;
    want?: typeof nftsWant;
  } = {},
) =>
  verifyNftsMintOutcome(
    {
      status: over.status ?? "finalized",
      events,
      observedShape: over.observedShape ?? false,
      shape: SYNTHETIC_NFTS_SHAPE,
    },
    over.want ?? nftsWant,
  );

describe("nfts.mint outcome verifier (SYNTHETIC shapes)", () => {
  it("exact match is effect_proven ONLY when the event shape was observed", () => {
    const proven = nfts([nftsEvent(), SUCCESS], { observedShape: true });
    expect([proven.verification, proven.coverage]).toEqual(["verified", "effect_proven"]);
    const capped = nfts([nftsEvent(), SUCCESS], { observedShape: false });
    expect(capped.verification).toBe("unknown");
    expect(capped.coverage).toBe("contract_emitted");
    expect(capped.reason).toMatch(/not verified on V3/);
  });
  it("wrong item, collection or mint_to is never proven", () => {
    for (const e of [nftsEvent("7", "43"), nftsEvent("8", "42"), nftsEvent("7", "42", OTHER)]) {
      const r = nfts([e, SUCCESS], { observedShape: true });
      expect(r.verification).toBe("not_verified");
      expect(r.coverage).not.toBe("effect_proven");
      expect(r.code).toBe("effect_mismatch");
    }
  });
  it("a failed dispatch is failed, even if a matching event is listed", () => {
    for (const events of [[nftsEvent(), FAILED], [nftsEvent()]]) {
      const r = nfts(events, { status: "failed", observedShape: true });
      expect([r.verification, r.coverage, r.code]).toEqual(["not_verified", "none", "tx_failed"]);
    }
    expect(nfts([nftsEvent(), FAILED], { observedShape: true }).code).toBe("tx_failed");
  });
  it("no events: extrinsic_finalized only, unknown", () => {
    const r = nfts([SUCCESS], { observedShape: true });
    expect([r.verification, r.coverage, r.code]).toEqual([
      "unknown",
      "extrinsic_finalized",
      "effect_unproven",
    ]);
  });
  it("unrelated events are contract_emitted-level unknown, not a match", () => {
    const r = nfts([ev("Balances", "Transfer", OWNER, OTHER, "1"), SUCCESS], {
      observedShape: true,
    });
    expect(r.verification).toBe("unknown");
    expect(r.coverage).toBe("extrinsic_finalized");
  });
  it("a matching event in a block that is not finalized is not proven", () => {
    const r = nfts([nftsEvent(), SUCCESS], { status: "included", observedShape: true });
    expect(r.verification).toBe("unknown");
    expect(r.coverage).toBe("call_dispatched");
    expect(r.code).toBe("not_finalized");
  });
  it("wrong arity of the event args is a shape mismatch, not a match", () => {
    const r = nfts([ev("Nfts", "Issued", "7", "42"), SUCCESS], { observedShape: true });
    expect(r.verification).toBe("unknown");
    expect(r.coverage).toBe("contract_emitted");
  });
});

const reviveWant = { dest: DEST as Hex, value: "0", data: "0xdeadbeef" as Hex };
const reviveEvent = (d = DEST, v = "0", data = "0xdeadbeef") => ev("Revive", "Called", d, v, data);
const revive = (
  events: ChainEvent[],
  over: {
    status?: "finalized" | "included" | "failed";
    observedShape?: boolean;
    want?: typeof reviveWant;
  } = {},
) =>
  verifyReviveCallOutcome(
    {
      status: over.status ?? "finalized",
      events,
      observedShape: over.observedShape ?? false,
      shape: SYNTHETIC_REVIVE_SHAPE,
    },
    over.want ?? reviveWant,
  );

describe("revive.call outcome verifier (SYNTHETIC shapes)", () => {
  it("exact dest, value and data: effect_proven only with an observed shape", () => {
    expect(revive([reviveEvent(), SUCCESS], { observedShape: true }).coverage).toBe(
      "effect_proven",
    );
    const capped = revive([reviveEvent(), SUCCESS], { observedShape: false });
    expect([capped.verification, capped.coverage]).toEqual(["unknown", "contract_emitted"]);
    expect(capped.reason).toMatch(/not verified on V3/);
  });
  it("wrong dest, value or data is rejected", () => {
    for (const e of [
      reviveEvent("0x2222222222222222222222222222222222222222"),
      reviveEvent(DEST, "1"),
      reviveEvent(DEST, "0", "0xdeadbeee"),
    ]) {
      const r = revive([e, SUCCESS], { observedShape: true });
      expect(r.verification).toBe("not_verified");
      expect(r.coverage).not.toBe("effect_proven");
    }
  });
  it("a failed dispatch is failed; no events is extrinsic_finalized", () => {
    expect(revive([FAILED], { status: "failed", observedShape: true }).code).toBe("tx_failed");
    expect(revive([SUCCESS], { observedShape: true }).coverage).toBe("extrinsic_finalized");
  });
  it("address comparison ignores case", () => {
    expect(
      revive([reviveEvent(DEST.toUpperCase().replace("0X", "0x")), SUCCESS], {
        observedShape: true,
      }).verification,
    ).toBe("verified");
  });
});

describe("verdicts feed buildReceipt, failing closed", () => {
  const facts = factsFromSnapshot(fileURLToPath(new URL("./fixtures", import.meta.url)));
  const base = compile(
    defineManifest({
      signer: {
        type: "ss58",
        value: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        ss58Prefix: 42,
      },
      actions: [
        action.transfer("pay", {
          assetId: "1",
          amount: "1",
          recipient: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
        }),
      ],
    }),
    facts,
  );
  // Synthetic: relabel the compiled step as nfts.mint (the compiler cannot build one without observed V3 metadata).
  const plan: Plan = {
    ...base,
    steps: [{ ...base.steps[0]!, actionId: "nft", kind: "nfts.mint" }],
  } as Plan;
  const outcome = (events: ChainEvent[]) => [
    {
      actionId: "nft",
      status: "finalized" as const,
      txHash: "0xaa" as Hex,
      block: { number: 1, hash: ("0x" + "01".repeat(32)) as Hex },
      events,
    },
  ];

  it("without a verdict an nfts.mint step stays unsupported_runtime", () => {
    expect(buildReceipt({ plan, outcomes: outcome([nftsEvent(), SUCCESS]) }).steps[0]!.code).toBe(
      "unsupported_runtime",
    );
  });
  it("with an observed-shape verdict the step is verified and effect_proven", () => {
    const v = nfts([nftsEvent(), SUCCESS], { observedShape: true });
    const r = buildReceipt({
      plan,
      outcomes: outcome([nftsEvent(), SUCCESS]),
      verdicts: { nft: v },
    });
    expect([r.steps[0]!.verification, r.steps[0]!.coverage]).toEqual(["verified", "effect_proven"]);
    expect(r.result).toBe("verified");
  });
  it("a capped verdict never makes the receipt verified", () => {
    const v = nfts([nftsEvent(), SUCCESS], { observedShape: false });
    const r = buildReceipt({
      plan,
      outcomes: outcome([nftsEvent(), SUCCESS]),
      verdicts: { nft: v },
    });
    expect(r.steps[0]!.verification).toBe("unknown");
    expect(r.result).toBe("not_verified");
  });
  it("a forged verified verdict is ignored when the receipt step itself failed or is not finalized", () => {
    const forged: OutcomeVerdict = {
      verification: "verified",
      coverage: "effect_proven",
      reason: "forged",
    };
    const failed = buildReceipt({
      plan,
      outcomes: [{ ...outcome([FAILED])[0]!, status: "failed" }],
      verdicts: { nft: forged },
    });
    expect(failed.steps[0]!.verification).toBe("not_verified");
    const included = buildReceipt({
      plan,
      outcomes: [{ ...outcome([nftsEvent(), SUCCESS])[0]!, status: "included" }],
      verdicts: { nft: forged },
    });
    expect(included.steps[0]!.verification).not.toBe("verified");
    const noEvents = buildReceipt({
      plan,
      outcomes: outcome([SUCCESS]),
      verdicts: { nft: forged },
    });
    expect(noEvents.steps[0]!.verification).toBe("unknown");
  });
});

describe("fixed wording for V3 reason codes", () => {
  it("NO_OBSERVED_V3_METADATA and V3_ARG_SHAPE_MISMATCH have plain wording", () => {
    expect(explainReasonCode("NO_OBSERVED_V3_METADATA")).toMatch(
      /no observed Portaldot V3 metadata/i,
    );
    expect(explainReasonCode("V3_ARG_SHAPE_MISMATCH")).toBe(
      "the target chain's call has different arguments than SEAM expected, so SEAM refused to build it rather than guess.",
    );
  });
  it("an unknown code has no invented wording", () => {
    expect(explainReasonCode("SOMETHING_NEW")).toBeUndefined();
    expect(Object.keys(REASON_CODE_WORDING)).toEqual(
      expect.arrayContaining(["NO_OBSERVED_V3_METADATA", "V3_ARG_SHAPE_MISMATCH"]),
    );
  });
});
