# Builder-plan assets.transfer, block #119634: independent verification

The transaction checks out on every chain point: verdict **verified**. This was a read-only check (no wallet, no signer, nothing sent) against `https://test-node-v3.portaldot.dev`, genesis `0xd4f9…83bd`, spec 3002, transaction version 2. The finalized head at read time was #119646. Full data is in `builder-transfer-119634-verification.json`.

Reproduce:

- `node packages/chain/scripts/v3-find-tx.mjs --hash 0x74a76dcbe62d1c8bf1cf5bf2701938ab65df5cbb0b30c6303d2b96dfc36ded6d --signer 5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE --asset 806707`
- `node packages/chain/scripts/v3-verify-signature.mjs --block 119634 --hash 0x74a76dcbe62d1c8bf1cf5bf2701938ab65df5cbb0b30c6303d2b96dfc36ded6d`

| check | observed | ok |
|---|---|---|
| block | #119634 `0xb0b7e0b55571619b1717a6f08fef5c655d4633935ceb8624233c541ab55eb3da`, extrinsic index 1 | canonical, finalized |
| signer | `5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE` | yes |
| call | one `Assets.transfer_keep_alive(id 806707, target 5EkVZovjHsUQ2YLa2CnaVND8259u5c9h8eBtmRVweBpBVHXB, amount 1)` | yes |
| call bytes | `0x2709ce3c31000076d0e8b40899d424129b4ec688f889b3ce5cb12cadfa72c8898f4cb25d7cb17204` | see "Plan" |
| dispatch | `ExtrinsicSuccess` (weight refTime 1145368000, proofSize 18392, Normal, pays fee) | yes |
| `Assets.Transferred` | asset 806707, from `0xe4f48afd…db0b` (signer), to `0x76d0e8b4…b172` (recipient), amount 1 | yes |
| fee (`TransactionFeePaid`) | 1470877249652 planck = 0.01470877249652 tPOT, tip 0 | |
| asset 806707, signer | #119633: 4, #119634: 3 (−1) | yes |
| asset 806707, recipient | #119633: 2501, #119634: 2502 (+1) | yes |
| signer free tPOT | 98529120200481 → 97058242950829 planck (0.98529120200481 → 0.97058242950829 tPOT), a drop of exactly the fee | yes |
| signature | valid with SEAM's `signedExtrinsicDecoder`, context: genesis, spec 3002, tx version 2, mortal era period 64 phase 11 (`0xb500`), birth block #119627 `0x77dd4023f35fce7726d78d172bef4bb50d5b6a0ddfd83f60f8b06805d1ab8c47`. Controls: no context → false; wrong checkpoint → false | yes |
| nonce | 1, directly after #118310 (nonce 0). No gap. The signer's balances before #119634 equal those after #118310, so nothing else was spent in between | yes |

## Plan

No plan file is committed for this builder plan, and the receipt carries no plan or call bytes. So the plan digest `0xcaa071a7ac70e8e286b9c0d5c05b4fe7d7fec8fcbe745b86072ce8e8c999f63f` is **not recomputed** here; it is the receipt's claim only. The call bytes were checked against the decoded call. They are byte-identical to the committed demo plan's step `pay` (`packages/console/src/demo/v3-demo-transfer.json`), which encodes the same transfer.

## The downloaded receipt, as a claim

`/workspace/demo-shots/seam-receipt-0x74a76dcb.json` agrees with the chain on tx hash, block number and hash, and signer. Where it does not:

- `result` is `"unverified"`, while `verification` and `effect.verdict` are `effect_proven` (and the console showed Effect Proven). This is Pixel's field to fix.
- `fee` is 1470877255420, but the chain's `TransactionFeePaid` is 1470877249652 (5768 planck less). The receipt's value looks like the preflight estimate.
- `effect.extrinsicIndex` is −1 and `effect.event` is `{}`, but the chain shows extrinsic index 1 with an `Assets.Transferred` event.
- `approvalHash` equals `planDigest`.

This transaction is not in `budget.json`, because the demo account paid the fee, not the test wallet. This check only shows what the chain recorded; it does not show how the transaction was signed.
