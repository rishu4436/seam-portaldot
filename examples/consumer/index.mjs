// Offline consumer of the SEAM SDK: discover (bundled snapshot) -> compile -> policy check -> receipt.
// Imports only public package names. Needs no node, no keys, no network and no repo paths.
import {
  action,
  buildReceipt,
  bundledSnapshotDir,
  classifyReceipt,
  defineManifest,
  explainPlan,
  explainPolicy,
  factsFromSnapshot,
  receiptIntegrity,
} from "@seam/sdk";
import { compile } from "@seam/compiler";
import { definePolicy, evaluatePolicy } from "@seam/policy";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

const facts = factsFromSnapshot(bundledSnapshotDir());
const manifest = defineManifest({
  signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
  actions: [action.transfer("pay", { assetId: "1", amount: "2500", recipient: BOB })],
});
const plan = compile(manifest, facts);
console.log(explainPlan(plan));

const policy = definePolicy({
  allowedAssets: ["1"],
  allowedRecipients: [BOB],
  maxAmountPerAsset: { 1: "10000" },
});
const result = evaluatePolicy({ policy, plan, facts, manifest });
console.log(explainPolicy(result));

// With no chain outcomes, every step is not_run: an honest empty receipt, never a success.
const receipt = buildReceipt({ plan, outcomes: [] });
console.log(
  `receipt integrity: ${receiptIntegrity(receipt).status}; outcome: ${classifyReceipt(receipt).code}`,
);

// Browser entry: the same receipt checks, with no node builtins. Run them on a recorded V3 receipt
// (copied from evidence/testnet-v3/receipts-v2/plan-atomic-1792411355057.json). This is integrity only:
// it shows the receipt was not edited, not that the transaction exists. Use `seam verify --endpoint` for that.
import {
  checkReceipt as checkReceiptBrowser,
  receiptIntegrity as integrityBrowser,
} from "@seam/sdk/browser";
import { readFileSync } from "node:fs";
const recorded = JSON.parse(
  readFileSync(
    new URL("./fixtures/recorded-receipt-atomic-1792411355057.json", import.meta.url),
    "utf8",
  ),
);
console.log(
  `recorded receipt: checkReceipt=${checkReceiptBrowser(recorded)}; integrity: ${integrityBrowser(recorded).status}`,
);
const tampered = structuredClone(recorded);
tampered.steps[0].status = tampered.steps[0].status === "verified" ? "failed" : "verified";
console.log(`tampered receipt: checkReceipt=${checkReceiptBrowser(tampered)}`);
