# Demo-account assets.transfer, block #118310: independent verification

The transfer checks out on every point: verdict **verified**. This was a read-only check (no wallet, no signer, nothing sent) against `https://test-node-v3.portaldot.dev`, genesis `0xd4f9…83bd`, spec 3002. The finalized head at read time was #118348. Full data is in `demo-transfer-118310-verification.json`.

Reproduce:
`node packages/chain/scripts/v3-find-tx.mjs --hash 0x8a2c8b92560b8238c3ecdcda10f822b3c995926452f4c51c43fb3bca131ea4ad --signer 5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE --plan packages/console/src/demo/v3-demo-transfer.json --asset 806707`

| check | observed | ok |
|---|---|---|
| block | #118310 `0xaa549f11e1533e570d2178abefc64cc9630bc036213ad011d66ccd0975c31ff1`, extrinsic index 1 | canonical, finalized |
| signer | `5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE` (the plan's signer) | yes |
| call | one `Assets.transfer_keep_alive(id 806707, target 5EkVZovjHsUQ2YLa2CnaVND8259u5c9h8eBtmRVweBpBVHXB, amount 1)` | yes |
| call bytes vs plan | `0x2709ce3c31000076d0e8b40899d424129b4ec688f889b3ce5cb12cadfa72c8898f4cb25d7cb17204` = plan step `pay` `encodedCall` | equal |
| plan digest | recomputed with `computePlanDigest` = `0x5eda2d74a9e793025e1ad8dcb6c3ada83571fd2fb0217b62a335696d765246eb` (as recorded) | equal |
| dispatch | `ExtrinsicSuccess` | yes |
| `Assets.Transferred` | asset 806707, from `0xe4f48afd…db0b` (signer), to `0x76d0e8b4…b172` (recipient), amount 1 | yes |
| fee (`TransactionFeePaid`) | 1470879799519 planck = 0.01470879799519 tPOT, tip 0 | |
| asset 806707, signer | #118309: 5, #118310: 4 (−1) | yes |
| asset 806707, recipient | #118309: 2500, #118310: 2501 (+1) | yes |
| signer free tPOT | 1.0 → 0.98529120200481, a drop of exactly the fee | yes |

This transaction is not in `budget.json`, because the demo account paid the fee, not the test wallet.

This check only shows what the chain recorded. It does not show how the transaction was signed (for example, whether a browser extension was used).
