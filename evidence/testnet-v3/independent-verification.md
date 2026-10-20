# Independent on-chain verification of the V3 testnet evidence

Generated 2026-10-20T12:30:11.445Z (UTC) from `https://test-node-v3.portaldot.dev` over HTTPS, read-only (no wallet, no signer, nothing sent).
Genesis `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd`, `portaldot-v3` spec 3002, tx version 2, finalized head #117279.

Reproduce: `npm run build && node packages/chain/scripts/v3-independent-verify.mjs`. Full detail per tx (expected vs observed events, decoded args, reasons) is in `independent-verification.json`.

**Method (does not trust the SEAM records):** for each of the 18 sent transactions the script reads `chain_getBlockHash(recorded number)` and compares it with the recorded hash, checks the number is at or below the finalized head, fetches the block and finds the extrinsic by blake2-256 of its full bytes, decodes call and signer with `state_getMetadata` at that block, reads `System.Events` at that block filtered to that extrinsic, takes the dispatch result from `ExtrinsicSuccess`/`ExtrinsicFailed` (module error decoded), and only then compares call bytes, signer and the ordered event list (normalised: ss58 = hex public key, decimal numbers, JSON key order) with the committed evidence. Archive state was available for every block, so nothing is unverifiable.

**Result:** {'verified': 17, 'expected_dispatch_failure': 1}.

| row | tx | block | idx | call | dispatch | outcome |
|---|---|---|---|---|---|---|
| 1 | `0x7577717d…1812` | #102233 | 1 | revive.mapAccount | ExtrinsicSuccess | **verified** |
| 2 | `0x390bc579…23af` | #102241 | 1 | nfts.create | ExtrinsicSuccess | **verified** |
| 3 | `0x9ea5ff6b…8f75` | #102327 | 1 | nfts.mint | ExtrinsicSuccess | **verified** |
| 4 | `0xbc93ca2f…7194` | #102411 | 1 | assets.create | ExtrinsicSuccess | **verified** |
| 5 | `0xcb5c06f8…4ff6` | #102451 | 1 | balances.transferKeepAlive | ExtrinsicSuccess | **verified** |
| 6 | `0x18f8a011…da70` | #102456 | 1 | balances.transferKeepAlive | ExtrinsicSuccess | **verified** |
| 7 | `0x8b84f63e…82be` | #102493 | 1 | assets.mint | ExtrinsicSuccess | **verified** |
| 8 | `0x5a3fcfe8…0ea4` | #102529 | 1 | assets.transferKeepAlive | ExtrinsicSuccess | **verified** |
| 9 | `0x86daea7e…46b6` | #102612 | 1 | assets.transferKeepAlive | ExtrinsicSuccess | **verified** |
| 10 | `0xdcdb39b5…05cf` | #102616 | 1 | nfts.mint | ExtrinsicSuccess | **verified** |
| 11 | `0x5c6f24c9…71be` | #102639 | 1 | assets.transferKeepAlive | ExtrinsicSuccess | **verified** |
| 12-13/pay | `0x67015f59…971a` | #102653 | 1 | assets.transferKeepAlive | ExtrinsicSuccess | **verified** |
| 12-13/nft | `0x5adae6e9…44da` | #102657 | 1 | nfts.mint | ExtrinsicSuccess | **verified** |
| 14 | `0xd1662231…da80` | #102665 | 1 | utility.batchAll | ExtrinsicFailed assets.BalanceLow | **expected_dispatch_failure** |
| 15 | `0x6be1232e…f355` | #102671 | 1 | utility.batchAll | ExtrinsicSuccess | **verified** |
| R1 | `0xad39bce1…acb2` | #102843 | 1 | revive.instantiateWithCode | ExtrinsicSuccess | **verified** |
| R2 | `0xec917338…7482` | #102853 | 1 | revive.call | ExtrinsicSuccess | **verified** |
| R3 | `0xc0ad1497…338f` | #102862 | 2 | revive.call | ExtrinsicSuccess | **verified** |

Notes:
- Row 14 (rollback probe, `0xd1662231…da80`) is `expected_dispatch_failure`: `ExtrinsicFailed assets.BalanceLow`, which is what the probe intended. It is not counted as a success.
- Rows 3, 9, 10 and 11 have no call bytes in their records (those records were rebuilt from the chain by signer and nonce), so for them only block, index, signer, events and dispatch are independent checks; the call was decoded but not compared with committed bytes.
- Rows 14 and 15 compare each inner call of the on-chain `Utility.batch_all` with the plan's `encodedCall`s. R2/R3 also check `dest` against the plan's contract.
- Event comparison is ordered and exact on every argument, including fees and weights.

## Revive.OriginalAccount (read 2026-10-20T12:34:04.919Z UTC, block #117321)

From live spec 3002 metadata: modifier `Optional`, hasher `Identity`, key `H160`, value `AccountId32`. A key built by hand (`xxh128("Revive") ++ xxh128("OriginalAccount") ++ h160`) equals the decorated-metadata key for `0x81ed1dfbec067703fdca3daa7efcbeff4ba101ec`: True. The read returns `5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1` (the run's signer). Script: `packages/chain/scripts/v3-original-account-check.mjs`.
