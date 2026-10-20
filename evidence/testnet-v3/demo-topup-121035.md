# seam-demo asset top-up, block #121035 (Portaldot V3 testnet, spec 3002)

Why: the 2-step demo transfer on `cb4442b` blocked step 2 at the signed dry run. seam-demo held 1 unit of asset 806707 (minBalance 1), so a second `transfer_keep_alive` of 1 could not dispatch. This top-up gives seam-demo enough balance for the rerun.

| Field | Value |
|---|---|
| Tx hash | `0x0329221171eaa7f473d7a7d6a1a77422247058b839693b4fc0567a2455e0490f` |
| Block | #121035 `0xce04b9b92b90f213fe2e2c3c915cddab98f61136c0986c0602088b6cf31f3470`, extrinsic index 1 |
| Status | finalized, canonical (finalized head #121037 when checked), `System.ExtrinsicSuccess` |
| Signer | SEAM test account `5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1`, nonce 20 |
| Call | `assets.transferKeepAlive(id 806707, target 5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE, amount 5)` |
| Event | `Assets.Transferred(806707, 5Exjao…, 5HEuRG…, 5)` |
| Fee | 1470874560699 planck (0.01470874560699 tPOT), `TransactionFeePaid` |
| seam-demo asset 806707 | 1 at #121034 -> 6 at #121035 |
| Test account asset 806707 | 999997495 -> 999997490 |
| Test account free tPOT | 98177110626304877 -> 98175639751744178 (drop = fee exactly) |

Method: same approach as the #118070 funding (`@polkadot/api` over HTTP, SEAM test keystore decoded with the password from env), as a single `assets.transferKeepAlive`, with no batch and no tPOT moved. The script checked the genesis hash and signer address before signing. No keys, seeds or signatures are recorded here.

Budget (`budget.json`): spent 18.24360248255822 tPOT of the 23.04034302112647 tPOT cap; 4.79674053856825 tPOT left.

Raw data: `demo-topup-121035.json`.
