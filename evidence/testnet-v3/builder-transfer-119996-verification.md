# Builder-plan assets.transfer, block #119996: independent verification

The transaction checks out on every chain point: verdict **verified**. The receipt's claims match the chain, except the approval hash, which cannot be checked from the receipt. This was a read-only check (no wallet, no signer, nothing sent) against `https://test-node-v3.portaldot.dev`, genesis `0xd4f9…83bd`, spec 3002, transaction version 2. The finalized head at read time was #120008. Full data is in `builder-transfer-119996-verification.json`.

Reproduce:

- `node packages/chain/scripts/v3-find-tx.mjs --hash 0xf883200e66da02360137d5a82f8f2700bcf75473429c25beece1fdbc7da31402 --signer 5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE --asset 806707 --plan /workspace/demo-shots/seam-receipt-0xf883200e.json`
- `node packages/chain/scripts/v3-verify-signature.mjs --block 119996 --hash 0xf883200e66da02360137d5a82f8f2700bcf75473429c25beece1fdbc7da31402`
- `node packages/chain/scripts/v3-plan-fingerprint.mjs --digest 0x837a6a0daf2988cd65a9bdc62d468b35b699816efeb23cf7e4d7a404267dfc86 --from 119930 --to 119996`

| check | observed | ok |
|---|---|---|
| block | #119996 `0x43326f29394dfad70747ff790d31e07ca068695279552c7083c42c02065f0edb`, extrinsic index 1 | canonical, finalized |
| signer | `5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE` | yes |
| nonce | 2, directly after #119634 (nonce 1). No gap: the signer's balances before #119996 equal those after #119634 | yes |
| call | one `Assets.transfer_keep_alive(id 806707, target 5EkVZovjHsUQ2YLa2CnaVND8259u5c9h8eBtmRVweBpBVHXB, amount 1)` | yes |
| call bytes vs `receipt.plan` step `step1` `encodedCall` | `0x2709ce3c31000076d0e8b40899d424129b4ec688f889b3ce5cb12cadfa72c8898f4cb25d7cb17204` | equal |
| signature | valid with `signedExtrinsicDecoder`, context: genesis, spec 3002, tx version 2, mortal era period 64 phase 36 (`0x4502`), birth block #119972 `0xc4cc2708d8a95a8d2f111c0597bde6cb8691d4a162ee04b1b7705d4ba8279688`. Controls: no context → false; wrong checkpoint → false | yes |
| dispatch | `ExtrinsicSuccess` (weight refTime 1145368000, proofSize 18392, Normal, pays fee) | yes |
| `Assets.Transferred` | asset 806707, from `0xe4f48afd…db0b` (signer), to `0x76d0e8b4…b172` (recipient), amount 1 | yes |
| fee (`TransactionFeePaid`) | 1470876553970 planck = 0.0147087655397 tPOT, tip 0. Receipt `fee` 1470876553970: equal (receipt `feeEstimate` 1470876594312) | yes |
| asset 806707, signer | #119995: 3, #119996: 2 (−1) | yes |
| asset 806707, recipient | #119995: 2502, #119996: 2503 (+1) | yes |
| signer free tPOT | 97058242950829 → 95587366396859 planck, a drop of exactly the fee | yes |

## Plan, fingerprint and approval

- **Plan digest**: recomputed from `receipt.plan` with the compiler's `computePlanDigest`: `0x11b3a4cc1141136fbed62bd7a64e37ee3a2fea90bdfb7461e9fe490a68eca71a`. This equals both `receipt.planDigest` and `receipt.plan.planDigest`.
- **Fingerprint**: `receipt.plan` carries only `fingerprintDigest` `0x837a6a0daf2988cd65a9bdc62d468b35b699816efeb23cf7e4d7a404267dfc86`, not the fingerprint object. Recomputed from the live metadata at each block, it equals the digest at every block from #119958 to #119996. The fingerprint there is V3: genesis `0xd4f9…83bd`, `portaldot-v3` 3002, tx version 2, ss58 42, tPOT/14, metadata hash `0x44e51bb5…c82b`. At #119930–#119957 the raw metadata (and so the digest) differed.
- **Layout hash**: the plan carries none. The v2 layout hash of that live metadata is `0x221ba8f7dd81e0341fca9f0074a3e433659c97300cbbb2f874dbd5f0d998b304`, the expected V3 value, and it is the same at every block from #119930 to #119996.
- **Approval hash** `0x1402610bbaf050bfa1a6340665ea8649328a3a1383eaa13a4da6ff14d6519ef2`: **unverifiable**. The receipt carries no approval input (envelope, preflight, policy, policy result), so `createApproval` cannot be rerun.

## Receipt claims

Equal to the chain: tx hash, block number and hash, signer, plan digest, fee, extrinsic index (1) and the `Assets.Transferred` event (asset, from, to, amount). There are no mismatches. One inconsistency remains inside the receipt: `liveStatus` is `"unverified"`, while `result` is `"verified"` and `verification` and `effect.verdict` are `effect_proven`.

This transaction is not in `budget.json`, because the demo account paid the fee, not the test wallet.
