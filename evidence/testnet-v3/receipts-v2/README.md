# Current-version SEAM receipts (v2)

Built by `packages/chain/scripts/v3-receipts-v2.mjs` (read-only, HTTPS, `https://test-node-v3.portaldot.dev`). For each plan run, events, signer and call bytes are re-read live from V3, not copied from the record. The receipt is built with the current `@seam/sdk` `buildReceipt` (runtime = the record's fingerprint, so the spec 3002 default checks apply). `receiptIntegrity` and `verifyReceiptLive` (with the record's plan and runtime) then run on it. The original files in `runs/` are unchanged.

| run | result | steps | integrity | live |
|---|---|---|---|---|
| `plan-sequential-1792411270138.json` | verified | pay:verified nft:verified | integrity_checked | chain_verified |
| `plan-atomic-1792411355057.json` | verified | mint:verified nft:verified | integrity_checked | chain_verified |
| `plan-revive-call-1792412445848.json` | not_verified | call:unknown(effect_unproven) | integrity_checked | unknown |
| `plan-revive-terminate-1792412498767.json` | not_verified | terminate:unknown(effect_unproven) | integrity_checked | unknown |

- `nfts.mint` is verified by the default V3 check: `Nfts.Issued(collection, item, owner)` must equal the plan's collection, item and recipient. A wrong item, collection or owner gives effect_mismatch (`packages/sdk/tests/nfts-default.test.ts`, "wrong item, collection or owner").
- `revive.call` stays **unknown** (`effect_unproven`). No expected `ContractEmitted` was supplied, so only the call bytes and success are proven. The data-0x01 (SELFDESTRUCT) call emitted no contract event.
