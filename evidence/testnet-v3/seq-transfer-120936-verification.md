# Sequential 2-step assets.transfer_keep_alive, step 1 at block #120936: independent verification

Step 1 checks out on every chain point: verdict **verified (step 1)**. Every receipt claim for step 1 matches the chain, and this time the approval hash **matches** when recomputed. Step 2 was never sent. This was a read-only check (no signer, nothing signed or sent) against `https://test-node-v3.portaldot.dev`, genesis `0xd4f9…83bd`, spec 3002, transaction version 2. The finalized head at read time was #120969. Full data is in `seq-transfer-120936-verification.json`.

Reproduce:

- `node packages/chain/scripts/v3-find-tx.mjs --hash 0x8a07ad3206f11dc121570d71ea924e8a60c5fa8ce311001184184de2b3d74e37 --signer 5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE --asset 806707 --plan /workspace/demo-shots/seam-receipt-seq-0xf974fd1c.json --max-blocks 400`
- `node packages/chain/scripts/v3-verify-signature.mjs --block 120936 --hash 0x8a07ad3206f11dc121570d71ea924e8a60c5fa8ce311001184184de2b3d74e37`
- `node packages/chain/scripts/v3-plan-fingerprint.mjs --digest 0x8bc3d4cd38574e44aae882b61c8f9f41aad9d6be076744bb55b7e2b3a2a092a8 --from 120880 --to 120940`
- A one-off read-only node check (not committed) for the CheckMetadataHash mode, `createApproval`, `metadataLayoutHash` at #120930/#120931, account nonces and the asset's `minBalance`.

## Chain

- **Block**: #120936 `0xed27dfe0a7694f8fa3dc5df10502926e0a9144d828c040ee6b307609ed125440`, canonical and finalized.
- **Extrinsic**: index 1, blake2-256 equals tx `0x8a07ad32…4e37`. Signer `5HEuRGmZ…yqKpE` (seam-demo).
- **Call**: `assets.transferKeepAlive(806707, 5EkVZovj…pBVHXB, 1)`, bytes `0x2709ce3c…b17204`, equal to `receipt.plan.steps[0].encodedCall`. `v3-find-tx` prints `callMatch: false` / `outcome: mismatch` only because it compares one tx with all plan steps at once (atomic view); on this 2-step sequential plan the step-level comparison is the right one, and it is equal.
- **Signature**: valid with the real context: era mortal period 64 phase 2, birth #120898 `0x7c980533…a526` (the envelope checkpoint). Controls: invalid with no context and with a wrong checkpoint.
- **CheckMetadataHash**: mode **0** (Disabled), decoded from the extrinsic's own bytes by `signedExtrinsicDecoder`.
- **Nonce**: 3, no gap. The account nonce was 3 after #119996 (nonce 2) and still 3 at #120935, then 4 after #120936. Asset balance (2) and free tPOT (95587366396859) are the same after #119996 and before #120936.
- **Dispatch**: `ExtrinsicSuccess`. `Assets.Transferred` asset 806707, from seam-demo to `5EkVZovj…pBVHXB`, amount 1.
- **Fee**: `TransactionFeePaid` 1470874750396, equal to the receipt fee (preflight estimate 1470874817473).
- **Balances** (#120935 → #120936): seam-demo asset 2 → 1, recipient 2503 → 2504. Seam-demo free tPOT 95587366396859 → 94116491646463, a drop of 1470874750396, equal to the fee.

## Plan, fingerprint, approval

- **Plan digest** recomputed from `receipt.plan` with `computePlanDigest`: `0x13b62017c19c6b8088e2c080dd57e06de4d9789ac5351cdb31b695bde46f779f`, equal to `receipt.planDigest` and `receipt.plan.planDigest`.
- **Fingerprint digest** `0x8bc3d4cd…92a8` equals the digest recomputed from live metadata at every block #120880–#120930 (start of the scan window). From #120931 on, the raw metadata differs, so the digest does too.
- **Approval hash**: **match**. `createApproval({...receipt.approvalInputs, now: new Date(receipt.approvalInputs.now)})` from `@seam/policy` (main `cb4442b`) gives `0xf974fd1c485a4a3e44846ca365255675cd38e2a609382aea2983a0d7f92b3ed7`, equal to `receipt.approvalHash`.

## Runtime lock

The receipt records `lockBasis: layout_hash`, code `runtime_layout_unchanged`, changed field `metadataHash` only. Checked independently:

- Raw metadata hash was `0xe2eee0e6a7a1fccc043973cd01640f3debaefeafe0a7f9586f5085aa26e51fde` at #120930 and `0x1615e1d4fc4fe2dc390a67a778ca4fea125c3ea0e4cc7ed69fd0156ac3e0a1e8` from #120931. These are the receipt's prepared and current hashes.
- `metadataLayoutHash` of both live blobs is `0x221ba8f7dd81e0341fca9f0074a3e433659c97300cbbb2f874dbd5f0d998b304`, equal to the receipt's prepared and current layout hashes. The layout hash is the same at every block #120880–#120940.

## Step 2 (not sent)

The receipt shows step 2 `not_run`, blocked at submit with `signed_dry_run_failed`. On chain, seam-demo holds 1 unit of asset 806707 after #120936 (still 1 at #120989), and the asset's `minBalance` is 1 (not sufficient, status Live). A `transfer_keep_alive` of 1 would take the account to 0 and reap it, which keep-alive refuses: this is the likely cause. Nonce (4 after #120936, as prepared) and era (checkpoint #120898 + 64) are ruled out. The exact dispatch error is not observable: the signed step-2 bytes were kept in memory only.

## Receipt claims

Equal to the chain for step 1: tx hash, block number and hash, signer, plan digest, fee, extrinsic index (1) and the `Assets.Transferred` event. No mismatches. The receipt's overall `result` is `partial`, which is correct.
