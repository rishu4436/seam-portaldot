import { expect, it } from "vitest";
import { compile } from "@seam/compiler";
import { preflight } from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { ALICE, BOB, snapshotFacts, snapshotInputs } from "./helpers.js";

const facts = snapshotFacts();
const plan = compile(
  {
    version: 1,
    signer: { type: "ss58", value: ALICE },
    actions: [
      {
        id: "mint",
        kind: "assets.mint",
        args: { assetId: "8801000", amount: "1", recipient: BOB },
      },
    ],
  },
  facts,
);
const node = (issuer?: string, unreadable = false) =>
  new FakeNode({
    facts,
    inputs: snapshotInputs(),
    assetBalances: [{ assetId: "8801000", minBalance: 1n, accounts: {}, issuer }],
    ...(unreadable ? { failRpc: ["state_getStorage"] } : {}),
  });
it("refuses minting an existing asset when the signer is not the issuer", async () => {
  const n = node(`0x${"01".repeat(32)}`);
  const r = await preflight(n, plan, facts);
  expect(r.result.steps[0]!.dryRun).toBe("failed");
  expect(r.result.steps[0]!.note).toContain("not the issuer");
  expect(n.submitted).toEqual([]);
});
it("an authorized issuer passes the permission check without claiming execution success", async () => {
  const r = await preflight(node(plan.signer.publicKey), plan, facts);
  expect(r.result.steps[0]!.dryRun).toBe("unknown");
  expect(r.result.steps[0]!.note).not.toContain("Mint permission");
});
it("unreadable issuer state fails closed before any signature", async () => {
  const r = await preflight(node(undefined, true), plan, facts);
  expect(r.result.steps[0]!.dryRun).toBe("failed");
  expect(r.result.steps[0]!.note).toContain("permission could not be verified");
});
