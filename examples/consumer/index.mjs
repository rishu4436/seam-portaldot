// Offline consumer of the SEAM SDK: discover (bundled snapshot) -> compile -> policy check -> receipt.
// Imports only public package names. Needs no node, no keys, no network and no repo paths.
import { action, buildReceipt, bundledSnapshotDir, classifyReceipt, defineManifest, explainPlan, explainPolicy,
  factsFromSnapshot, receiptIntegrity } from '@seam/sdk';
import { compile } from '@seam/compiler';
import { definePolicy, evaluatePolicy } from '@seam/policy';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const facts = factsFromSnapshot(bundledSnapshotDir());
const manifest = defineManifest({
  signer: { type: 'ss58', value: ALICE, ss58Prefix: 42 },
  actions: [action.transfer('pay', { assetId: '1', amount: '2500', recipient: BOB })],
});
const plan = compile(manifest, facts);
console.log(explainPlan(plan));

const policy = definePolicy({ allowedAssets: ['1'], allowedRecipients: [BOB], maxAmountPerAsset: { 1: '10000' } });
const result = evaluatePolicy({ policy, plan, facts, manifest });
console.log(explainPolicy(result));

// With no chain outcomes, every step is not_run: an honest empty receipt, never a success.
const receipt = buildReceipt({ plan, outcomes: [] });
console.log(`receipt integrity: ${receiptIntegrity(receipt).status}; outcome: ${classifyReceipt(receipt).code}`);
