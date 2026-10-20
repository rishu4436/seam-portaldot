# Sequential 2-step assets.transfer_keep_alive at blocks #121390 and #121394: independent verification

Both steps check out on every point: verdict **verified**. The run was signed through the polkadot.js extension by the SEAM team, from the console on main `2a445a6`. This check was read-only (no signer, nothing signed or sent) against `https://test-node-v3.portaldot.dev`, genesis `0xd4f9…83bd`, spec 3002, transaction version 2. Receipt: `/workspace/demo-shots/seam-receipt-seq-0x8a933ad6.json`. Full data is in `seq-transfer-121390-verification.json`.

Reproduce (per step): `v3-find-tx.mjs --hash <tx> --signer 5HEuRGmZ…yqKpE --asset 806707 --plan <receipt>` and `v3-verify-signature.mjs --block <n> --hash <tx>`, plus a one-off read-only node check (not committed) for the CheckMetadataHash mode, the plan digest, `createApproval`, raw and layout metadata hashes, and `System.Account` at #121375/#121389/#121390/#121393/#121394.

## Steps

| | Step 1 | Step 2 |
|---|---|---|
| Tx | `0xadced4b5…11a1` | `0xaea50145…1926` |
| Block | #121390 `0xc151311f…948f`, finalized, ext index 1 | #121394 `0xe536bf47…d036`, finalized, ext index 1 |
| Signer | seam-demo `5HEuRGmZ…yqKpE` | seam-demo |
| Nonce | 4 (account 4 → 5) | 5 (account 5 → 6) |
| Signature | valid (era 64/31, birth #121375 = envelope checkpoint); controls invalid | valid; controls invalid |
| CheckMetadataHash | mode 0 | mode 0 |
| Call | `assets.transferKeepAlive(806707, 5EkVZovj…pBVHXB, 1)` = `plan.steps[0].encodedCall` | same call = `plan.steps[1].encodedCall` |
| Fee (TransactionFeePaid) | 1470873880829 = receipt | 1470873873177 = receipt |
| Free tPOT drop | 1470873880829 (= fee) | 1470873873177 (= fee) |
| Events | Withdraw, Assets.Transferred (806707, 1), Deposit, TransactionFeePaid, ExtrinsicSuccess | same |

Nonces are consecutive (4, 5). `v3-find-tx` prints `outcome: mismatch` only because it compares one tx with all plan steps at once (atomic view); the step-level comparison is the right one here and is equal for both steps.

## Plan and approval

- **Plan digest** recomputed with `computePlanDigest(receipt.plan)`: `0xcc654666…1146`, equal to `receipt.planDigest` and `receipt.plan.planDigest`.
- **Approval hash** recomputed with `createApproval({...receipt.approvalInputs, now})` from `@seam/policy`: `0x8a933ad6…90b5`, **match**.

## Runtime lock

Both receipt locks say `lockBasis: raw`, `runtime_unchanged`. Confirmed: the raw metadata hash is `0x66e056e6…addb` at #121375 (checkpoint), #121389, #121390, #121393 and #121394, equal to the receipt fingerprint's `metadataHash`. The layout hash is `0x221ba8f7…b304` throughout. No drift during the run, so the raw basis is correct.

## Receipt gap

The receipt records only the plan-level envelope nonce (`approvalInputs.envelope.nonce` = 4). `receipt.steps[]` has no per-step nonce, so step 2's nonce (5) comes from the chain only.

## Mismatches

None.
