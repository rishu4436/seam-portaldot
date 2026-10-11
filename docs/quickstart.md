# Quickstart

This guide goes from a fresh clone to a compiled, policy-checked plan in about five minutes. Everything here runs offline against a saved snapshot of the public Portaldot node (spec 1002, block 2,721,455), so you need no node, wallet or tokens.

## 1. Install and build

Needs Node 22 or later.

```bash
npm install
npm run build
npm test
```

## 2. Write a Manifest

A Manifest says what you want to happen, not how. This one is the demo flow: transfer an asset, call an ink! contract, then mint a receipt token. It's in [`examples/demo-manifest.json`](examples/demo-manifest.json).

```json
{
  "version": 1,
  "signer": { "type": "ss58", "value": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", "ss58Prefix": 42 },
  "actions": [
    { "id": "pay", "kind": "assets.transfer", "args": { "assetId": "1", "amount": "2500", "recipient": "5FHneW46..." } },
    { "id": "call", "kind": "contracts.call", "args": { "contract": "5FHneW46...", "value": "0", "gasLimit": "5000000000", "data": "0x633aa551" } },
    { "id": "receipt", "kind": "assets.mint", "args": { "assetId": "2", "amount": "1", "recipient": "5FHneW46..." } }
  ]
}
```

Amounts are always whole numbers in base units, written as strings. Use `toBaseUnits("2.5", 14)` from the SDK to convert.

## 3. Check it and get its digest

```bash
npx seam digest docs/examples/demo-manifest.json
# Manifest is valid. Digest: 0x4152a194...
```

The digest is the same on any machine for the same Manifest, whatever the key order.

## 4. Compile it against the runtime

```bash
npx seam compile docs/examples/demo-manifest.json
```

```
Plan for 3 steps: steps run one at a time, and SEAM stops at the first one that fails.
- pay: assets.transfer is ready (Assets.transfer_keep_alive).
- call: contracts.call is ready (Contracts.call).
- receipt: assets.mint is ready (Assets.mint).
Why this mode: Utility.batch_all exists but its rollback on failure is not verified ...
```

Now try a Manifest that asks for something this chain doesn't have:

```bash
npx seam compile docs/examples/missing-pallet-manifest.json
# - nft: can't run, because Nfts.mint is not on this runtime (spec 1002).
```

SEAM reads what the runtime really offers instead of assuming, so a missing pallet becomes a plain answer instead of a failed transaction. Add `--json` to any command to get the raw plan.

## 5. Check it against a policy

A policy is the set of rules your app allows. Anything not allowed, and anything SEAM can't confirm, is blocked.

```bash
npx seam check docs/examples/demo-manifest.json --policy docs/examples/demo-policy.json
# Offline check passed: all 13 rules that don't need a node passed. ...

npx seam check docs/examples/demo-manifest.json --policy docs/examples/strict-policy.json
# - pay: Blocked: amount 2500 is over the limit of 1000 for asset 1.
```

Fees, weight and dry runs need a live node, so they're checked during preflight, before approval.

## 6. Run it for real, from code

```ts
import { Seam, defineManifest, action, explainReceipt } from '@seam/sdk';
import { createPortaldotAdapter } from '@seam/chain';
import { portaldotPolicy } from '@seam/policy';

const chain = createPortaldotAdapter('wss://<testnet-rpc>');
const seam = new Seam(chain);
const facts = await seam.discover();                       // reads the live runtime
const policy = portaldotPolicy({ allowedAssets: ['1', '2'], allowedRecipients: [BOB], allowedContracts: [CONTRACT] });

const manifest = defineManifest({ signer: { type: 'ss58', value: ALICE }, actions: [
  action.transfer('pay', { assetId: '1', amount: '2500', recipient: BOB }),
] });

const prepared = await seam.prepare(manifest, facts, policy);   // compile + preflight + policy
const approval = seam.approve({ ...prepared, policy, facts });  // the user reviews and approves this
if (!approval.ok) throw new Error(approval.reason);

const wallet = chain.walletFrom(extension.signer.signPayload);  // the user's wallet signs; SEAM never sees keys
const run = await seam.execute({ ...prepared, policy, facts, approval: approval.approval, wallet });
console.log(run.ok ? explainReceipt(run.receipt) : run.reason);
```

> The Portaldot V3 testnet RPC isn't public yet. Until it is, step 6 runs against a local dev node. Submitting to mainnet is refused unless you set `allowMainnet`.

## 7. Check a receipt

Every run ends in a receipt that says what the chain actually shows, step by step.

```bash
npx seam verify receipt.json
# Receipt is intact (digest matches).
# Verified: all 3 steps finalized and the chain shows exactly what was planned.
```

If anyone edits the receipt afterwards, `seam verify` says so.

Next, see the [reference](reference.md) for every field, status and block reason.
