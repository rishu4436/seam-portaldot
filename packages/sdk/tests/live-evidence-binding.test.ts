import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { compile } from "@seam/compiler";
import {
  action,
  defineManifest,
  factsFromSnapshot,
  buildReceipt,
  verifyReceiptLive,
  type ReceiptChainReader,
} from "../src/index.js";
const facts = factsFromSnapshot(fileURLToPath(new URL("./fixtures", import.meta.url)));
const signer = {
  type: "ss58" as const,
  value: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  ss58Prefix: 42,
};
const bob = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const success = { pallet: "System", name: "ExtrinsicSuccess", args: ["{}"] };
describe("independent live evidence", () => {
  it("rejects using one finalized transfer for two sequential actions", async () => {
    const plan = compile(
      defineManifest({
        signer,
        actions: ["one", "two"].map((id) =>
          action.transfer(id, { assetId: "1", amount: "10", recipient: bob }),
        ),
      }),
      facts,
    );
    const events = [
      {
        pallet: "Assets",
        name: "Transferred",
        args: ["1", plan.signer.publicKey, plan.steps[0].decodedArgs.recipientAccountId!, "10"],
      },
      success,
    ];
    const outcomes = plan.steps.map((s) => ({
      actionId: s.actionId,
      status: "finalized" as const,
      txHash: hash(9),
      block: { number: 5, hash: hash(5) },
      events,
    }));
    const reader: ReceiptChainReader = {
      finalizedNumber: async () => 10,
      canonicalHash: async () => hash(5),
      readTx: async () => ({
        extrinsicIndex: 1,
        nonce: 1,
        signer: plan.signer.publicKey,
        callHex: plan.steps[0].encodedCall!,
        events,
      }),
    };
    const result = await verifyReceiptLive(buildReceipt({ plan, outcomes }), reader, { plan });
    expect(result.status).toBe("failed");
    expect(result.problems.join()).toMatch(/distinct transactions/);
  });
  it("cannot prove contract state using an actual value supplied by the caller", async () => {
    const plan = compile(
      defineManifest({
        signer,
        actions: [
          action.contractCall("call", {
            contract: bob,
            value: "0",
            gasLimit: "1000000000",
            data: "0x633aa551",
          }),
        ],
      }),
      facts,
    );
    const events = [success],
      effects = { call: { stateReadback: { expected: "settled", actual: "settled" } } };
    const receipt = buildReceipt({
      plan,
      outcomes: [
        {
          actionId: "call",
          status: "finalized",
          txHash: hash(9),
          block: { number: 5, hash: hash(5) },
          events,
        },
      ],
      effects,
    });
    const reader: ReceiptChainReader = {
      finalizedNumber: async () => 10,
      canonicalHash: async () => hash(5),
      readTx: async () => ({
        extrinsicIndex: 1,
        signer: plan.signer.publicKey,
        callHex: plan.steps[0].encodedCall!,
        events,
      }),
    };
    const result = await verifyReceiptLive(receipt, reader, { plan, effects });
    expect(result.status).not.toBe("chain_verified");
    expect(result.notes.join()).toMatch(/caller-supplied state/);
  });
});
