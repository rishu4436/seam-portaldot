# Portaldot V3 testnet: first funded SEAM run

Chain: `wss://test-node-v3.portaldot.dev` ("PortaldotV3 Test", `portaldot-v3` spec 3002, transaction version 2, ss58 42, token `tPOT` with 14 decimals, genesis `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd`). It is a test network, not mainnet.
The run took place on 2026-10-19 between 16:48 and 17:32 IST, at blocks #102233 to #102671.

- **Signer:** `5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1`. This is a disposable test wallet. Its keystore stays outside the repo, and no seed, signature or password is recorded here.
- **Derived Revive H160:** `0x81ed1dfbec067703fdca3daa7efcbeff4ba101ec`.

Reproduce with `SEAM_SIGNER=<keystore> SEAM_SIGNER_PASSWORD=... node scripts/v3-funded-run.mjs --step map|nfts|assets|plans|revive [--submit]`. The implementation is in `packages/chain/scripts/v3-funded-run.mjs`. Without `--submit`, every transaction is signed and dry-run only.

Every transaction below went through SEAM's signing path: signing request, then signer closure, then `assembleSignedExtrinsic`, which verifies the signature. Before sending, each one passed a free signed `system_dryRun`, a `payment_queryInfo` fee estimate and the spending-cap check. `submitAndWatch` then waited for finality.

## Spending

The hard cap was **10 tPOT**, counting fees, held deposits and transfers out. Spend is measured as the drop in free balance from the baseline in `budget.json`.

| | tPOT |
|---|---|
| Free balance at start | 1000.0 |
| Free balance at end | 996.95965697887353 |
| **Total spent** | **3.04034302112647** |
| Of which held deposits (reserved, refundable): NFT collection 1.0, asset class 1.0, 4 NFT items 4 x 0.1 | 2.4 |
| Of which sent to two fresh recipient addresses (2 x ED, so they can hold the asset) | 0.4 |
| Of which transaction fees (15 transactions) | about 0.24 |

## Transactions

All are finalized. In the explorer column, a link opens the block in the Portaldot Node Console using the polkadot-js Apps `#/explorer/query/<block hash>` pattern. That pattern is assumed from the UI, not documented, and the console may need to be pointed at the V3 node first.

| # | step | call | tx hash | block | finalized | fee (tPOT) | outcome | explorer | record |
|---|---|---|---|---|---|---|---|---|---|
| 1 | revive.map_account | `Revive.map_account()` | `0x7577717d1dba2f0d4148e8a023e76e997d697b736a6f1f0817fa6b846b0b1812` | #102233 | yes | 0.010908 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0xd76f83f9390cd788e7e12778c81fee6bafe02c8d776e02ea1124dfd7f7859b4a) | `runs/map-account-1792408724499.json` |
| 2 | nfts.create | `Nfts.create(admin=5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1, config={"settings":0,"` | `0x390bc57994d562383ae3ffd3b7a0bfdcc07130d98c15751666ccfa38a92623af` | #102241 | yes | 0.016309 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0x89bbc8a4968c71aa9ca7cedd68672f04ced6d9e8f08ece873c71a7174a6b8a7b) | `runs/nfts-create-1792408936565.json` |
| 3 | nfts.mint | `Nfts.mint(collection=0, item=0, mint_to=5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1, ` | `0x9ea5ff6bfa593ae803a800b6806c80a7c068057f176e9355f098933917de8f75` | #102327 | yes | 0.015109 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0x01ad8cc29f5b80a9c165e1fe84b589ebf4f1e3a491c54fece3e4602358143af6) | `runs/nfts-mint-1792409706466.json` |
| 4 | assets.create | `Assets.create(id=806707, admin=5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1, min_balan` | `0xbc93ca2f4f3f2067f0ba35772d6a50dbf9372db98888ea4d84581278e6ff7194` | #102411 | yes | 0.016210 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0x76a8504af171fcebc1b82fe5516cfb92ccd89b3133a30a6d8d9eaee6e8cde858) | `runs/assets-create-1792409775476.json` |
| 5 | balances.transfer_keep_alive | `Balances.transfer_keep_alive(5EkVZovjHsUQ2YLa2CnaVND8259u5c9h8eBtmRVweBpBVHXB, 20000000000` | `0xcb5c06f8d0847099ecfcc1343f2b5872b1bc72c32ddabbc2981c10989a224ff6` | #102451 | yes | 0.014906 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0x234c2e17574d5c9444b654dfbc2f22a43b6fec45cc459205ae50f0f1a48d10a5) | `runs/fund-recipient-1792410012136.json` |
| 6 | balances.transfer_keep_alive | `Balances.transfer_keep_alive(5DFz6NsQPrHU61VWJJxaEjBKYd3ND4bDJzNMcKrLcqCihi3v, 20000000000` | `0x18f8a01153581e611a3753bf3c54160b99b97cff82dac5437d191a33e97dda70` | #102456 | yes | 0.014906 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0x732604870d73fe39738a84ec396f1bbc31276bea8cc8dc90d13101bc76375890) | `runs/fund-recipient-1792410042910.json` |
| 7 | assets.mint | `Assets.mint(id=806707, beneficiary=5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1, amoun` | `0x8b84f63e44abd99a7c9561f4e80e087a32e013ec965e8bb70160c6fad73182be` | #102493 | yes | 0.015007 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0xa8d9713bd5607e7f1031c619a192d3c1436268cc472fe2053441351e803971ec) | `runs/assets-mint-1792410268239.json` |
| 8 | assets.transfer_keep_alive | `Assets.transfer_keep_alive(id=806707, target=5EkVZovjHsUQ2YLa2CnaVND8259u5c9h8eBtmRVweBpBV` | `0x5a3fcfe808b02e5dbeb704bddcdb4092526d015856fffb151230e06b9f440ea4` | #102529 | yes | 0.014809 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0x5f3b25f2f353f9249c0fb186b854904e8310699e27ec487b0a3a6b88bdf50b3e) | `runs/assets-transfer-1792410479921.json` |
| 9 | seam-plan-sequential attempt 1 (nonce 8) | `assets.transferKeepAlive([806707,{"id":"5EkVZovjHsUQ2YLa2CnaVND8259u5c9h8eBtmRVweBpBVHXB"}` | `0x86daea7ed7f5346e248376d78f4756adf16f6988f67b1a1cad8bd1d775c446b6` | #102612 | yes | 0.014809 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0xaa123631c32a5b319d694338118570eaebc7dcaf18ea93e46619544d37f25ded) | `runs/plan-sequential-attempt1-1792411101481.json` |
| 10 | seam-plan-sequential attempt 1 (nonce 9) | `nfts.mint([0,1,{"id":"5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1"},null])` | `0xdcdb39b5302d0d4296ea731ed4ed8761ee57f81734697d0baedbb34d603005cf` | #102616 | yes | 0.015109 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0x24f4a1f92d1c93426eab972396dda10c564bf8082e06fc8c90ad8f7404b8db61) | `runs/plan-sequential-attempt1-1792411122983.json` |
| 11 | seam-plan-sequential attempt 2, step pay (SEAM marked it uncertain: HTTP retry got 1013 Already Imported) | `assets.transferKeepAlive([806707,{"id":"5EkVZovjHsUQ2YLa2CnaVND8259u5c9h8eBtmRVweBpBVHXB"}` | `0x5c6f24c920fb94dbe80a912f349bba2bec3277e25873c81b1ec700cb191c71be` | #102639 | yes | 0.014809 | success | [block](https://node-console.portaldot.dev/#/explorer/query/0x0c58416c2a5fa36a77812fd77fccc3a52bf542d7ef4888576dce7d6fc22e4b26) | `runs/plan-sequential-attempt2-pay-1792411204466.json` |
| 12 | SEAM plan, sequential [pay] | `assets.transfer (plan mode sequential)` | `0x67015f593a98a1ef1da9d07062a305d0b19c68371870edb864da3cb87a72971a` | #102653 | yes | see file | SEAM receipt step: finalized/verified | [block](https://node-console.portaldot.dev/#/explorer/query/0x152847f0eb2d96d186b8c036c741c2c5dc1adb521546762e1a83400ecdd60873) | `runs/plan-sequential-1792411270138.json` |
| 13 | SEAM plan, sequential [nft] | `nfts.mint (plan mode sequential)` | `0x5adae6e98e2b3d823680a5c35bd0ee5ebb3e0bc924516c185c299c2a571744da` | #102657 | yes | see file | SEAM receipt step: finalized/unknown | [block](https://node-console.portaldot.dev/#/explorer/query/0xb1e0903fdbee1930c0f09f0999d1eacf0649dcb45e13a18ee57874ee0838b3a0) | `runs/plan-sequential-1792411270138.json` |
| 14 | SEAM plan, failing batch_all (gate blocked; test-only direct send) | `Utility.batch_all[assets.transfer, assets.mint, nfts.mint, assets.transfer(overdraw)]` | `0xd16622312a942d519e3d246ef46d2c677050c09e787883f7c7c1ffc6595bda80` | #102665 | yes | see file | ExtrinsicFailed assets.BalanceLow: Account balance must be greater than or equal to the transfer amount.; rollback verified | [block](https://node-console.portaldot.dev/#/explorer/query/0xd1aab7bba1eabe4822b7af169a62ba7e364eb4ccbdb587d6f8dfed68c3cdb753) | `runs/plan-rollback-1792411297498.json` |
| 15 | SEAM plan, atomic [mint,nft] | `assets.mint + nfts.mint (plan mode atomic_verified)` | `0x6be1232e17cee41f0376d91b5638ae3f2f9909f4d0f2d15cd633422a339cf355` | #102671 | yes | see file | SEAM receipt step: finalized/verified | [block](https://node-console.portaldot.dev/#/explorer/query/0xaa5658730de4e827bc4224ce481e8f391348cbf12ad2e5811e55005a71a1396b) | `runs/plan-atomic-1792411355057.json` |

Rows 9 to 11 are earlier attempts of the sequential plan. They landed on chain, but their SEAM recordings were lost or marked uncertain because of problems in the run tooling, not in SEAM:
- **Attempt 1:** the evidence script crashed after the run, before it saved the receipt.
- **Attempt 2:** an HTTP retry of `author_submitExtrinsic` came back `1013 Already Imported`, so SEAM correctly reported the step as `uncertain` and stopped.

Both attempts were rebuilt from the chain by signer and nonce (`--step find`). The clean run is rows 12 and 13.

## SEAM plans (compile -> preflight -> policy -> approve -> sign -> submit gate -> submit -> receipt)

- **Sequential plan** (`runs/plan-sequential-1792411270138.json`): `assets.transfer` then `nfts.mint`.
  - Policy allowed it. The gate's signed dry run passed for each step, and both steps finalized.
  - SEAM's own receipt: `pay` is **verified** (the `Assets.Transferred` arguments match the plan). `nft` is `unknown` / `unsupported_runtime`, because `Seam.execute` gets no nfts verdict by default. So the overall result is `not_verified`.
  - A second receipt was built with `verifyNftsMintOutcome` (`nftVerdictReceipt`). It uses the `Nfts.Issued` field order read from the real V3 metadata (`collection, item, owner`), passes `observedShape: true`, and runs on the step's own finalized events. It reports `Nfts.Issued(0, 2, 0x8027…8467)`, which is **verified**, for an overall result of **verified**. `checkReceipt` reports it intact.
- **Rollback probe** (`runs/plan-rollback-1792411297498.json`): an `atomic_unverified` plan of `assets.transfer(5)`, `assets.mint(3)`, `nfts.mint(item 3)` and `assets.transfer(9e14, overdraw)`.
  - **SEAM's submit gate blocked it**: "the dry run of the signed transaction failed". Nothing was sent; the signer nonce was unchanged.
  - The same signed bytes were then sent directly, as a test-only bypass, to observe the chain's own behaviour. The tx `0xd166…da80` in #102665 failed with `assets.BalanceLow`.
  - Before vs after: the asset balances of the signer and both recipients, the asset supply, and the absence of NFT item 3 were all identical. There were no inner `Assets.Transferred`, `Assets.Issued` or `Nfts.Issued` events.
  - **Result: `Utility.batch_all` rollback verified on V3 spec 3002 for this composition.** Only the fee was charged.
- **Atomic plan** (`runs/plan-atomic-1792411355057.json`): `assets.mint(7)` + `nfts.mint(item 3)`.
  - The compiler accepted the rollback proof built from the probe above and chose **`atomic_verified`**: one `Utility.batch_all`, tx `0x6be1…f355` in #102671.
  - SEAM's receipt: `mint` is verified and `nft` is unknown. With the nfts verdict, the result is **verified**, and the receipt is intact.

## What is now V3-verified (observed on the hosted V3 testnet, spec 3002)

- **Signing:** SEAM's signing requests and extrinsic assembly produce extrinsics V3 accepts. The unknown `AuthorizeCall` and `EthSetOrigin` extensions carry no payload, and treating them as no-effect works. `CheckMetadataHash` (mode 0) and `ChargeAssetTxPayment` (tip 0, native asset) are encoded correctly.
- **Dry runs and fees:** signed `system_dryRun` works, and `payment_queryInfo` matches the fees actually paid exactly.
- **`Revive.map_account`:** the call dispatches successfully. The account was **already mapped before the call** (`Revive.OriginalAccount(0x81ed…01ec)` already held the signer; the runtime has `autoMap = true`). The call emitted no Revive event and held no deposit, so this proves the call path, not a fresh mapping.
- **`Nfts.create` and `Nfts.mint` layouts:** `Nfts.create` (collection 0) and `Nfts.mint` (items 0 to 3) work, with `mint_to: MultiAddress`, `witness_data: None`, and the `Nfts.Issued(collection, item, owner)` event shape.
- **Assets:** `Assets.create`, `mint` and `transfer_keep_alive` work, as do the plan kinds `assets.transfer` and `assets.mint`. Receipts are verified.
- **`nfts.mint` plan path:** `nfts.mint` as a SEAM plan step works through compile, policy, the gate and a finalized receipt. With `verifyNftsMintOutcome` and the shape read from metadata, the step is verified.
- **`Utility.batch_all`:** atomic execution and rollback on failure both hold for `assets.transfer`, `assets.mint` and `nfts.mint`. The `atomic_verified` mode was selected from real rollback evidence.

## What is still NOT verified

- **`Revive.call` and contract deploys.** No contract was deployed.
  - Even a 6-byte EVM contract (`0x60006000a000`, LOG0) needs a storage deposit between **13 and 14 tPOT**. Signed dry runs fail with `StorageDepositLimitExhausted` at a limit of 13 tPOT and pass at 14 (`runs/revive-deploy-dryrun-limit13.json` and `-limit14.json`).
  - That is above the 10 tPOT cap, so nothing was sent. The SEAM `revive.call` step and its verifier are still unverified on V3.
  - Unblocking this needs a cap of about 15 tPOT. That money is a held deposit, refundable if the contract is terminated.
- **A fresh account mapping**, meaning an account that was not already auto-mapped.
- **Contracts (ink!) on V3**, the PolkaVM path, and cross-VM atomicity.
- **The SEAM preflight `simulation coverage` for `nfts.mint`.** It still says `unobserved`, by design, because the code does not upgrade it from evidence yet.
- **A real browser-extension signature.** All signatures here came from a local keystore signer closure.

## V3 findings that need code changes (chain layer)

1. **The metadata bytes drift without a runtime upgrade.**
   - `state_getMetadata` on spec 3002 returns bytes that change between blocks: hashes 0x91e5…, 0x0e88…, 0xbacb… and more within an hour.
   - Exactly one storage *fallback* (default value) changes: `Revive.EthBlockBuilderIR`, which is state-dependent. Spec, transaction version and every type are unchanged.
   - SEAM pins the raw metadata hash, so:
     - `readEvents` refuses with `RUNTIME_CHANGED` when a tx lands after a drift;
     - plans and rollback proofs go stale every few minutes.
   - The run script works around it for reading events only (`eventsWithBlockMetadata`). It decodes with the block's own metadata, and only after checking that the two blobs are identical once all storage fallbacks are blanked.
   - **Fix needed in `@seam/chain`:** fingerprint a normalized metadata (storage fallbacks blanked).
2. **The WebSocket drops often.**
   - The node closes the WebSocket with code 1006 every few calls, often on the 1.1 MB metadata.
   - The run used `packages/chain/scripts/http-rpc-client.mjs`: an `RpcClient` over JSON-RPC HTTP at the same host, with polling in place of subscriptions.
   - SEAM still decodes every byte with the pinned runtime.

## Files

- `budget.json`: the spend baseline and cap.
- `state.json`: the run state (collection, asset id, recipients and run file names).
- `runs/*.json`: one record per transaction. Each holds:
  - the call and its hex;
  - nonce and checkpoint;
  - the signed dry-run result and the `payment_queryInfo` result;
  - status history, block, all decoded events and the actual fee;
  - balances before and after.
- `runs/plan-*.json`: the full SEAM run reports, including:
  - manifest, plan, preflight, policy result, approval;
  - signing requests (payloads only);
  - gate checks, step log, run and receipt.

  Large `metadataHex` values are replaced with their length and blake2-256 hash.
