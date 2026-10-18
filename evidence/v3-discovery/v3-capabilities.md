# V3 capabilities (read-only discovery)

Source: wss://test-node-v3.portaldot.dev, chain "PortaldotV3 Test", portaldot-v3 spec 3002, genesis 0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd, block 89087. Read 2026-10-18T13:18:55.325Z.

**This file only describes what that one node reported. V3 is NOT VERIFIED until this has been run against a real hosted V3 RPC and the output reviewed.**

Chain properties (system_properties): ss58Format 42, tokenSymbol "tPOT", tokenDecimals 14.

| item | kind | status | detail |
|---|---|---|---|
| Revive | pallet | observed |  |
| Contracts | pallet | observed |  |
| Nfts | pallet | observed |  |
| Assets | pallet | observed |  |
| Utility | pallet | observed |  |
| Revive.call | call | observed |  |
| Revive.instantiate | call | observed |  |
| Revive.instantiate_with_code | call | observed |  |
| Revive.upload_code | call | observed |  |
| Revive.map_account | call | observed |  |
| Contracts.call | call | observed |  |
| Contracts.instantiate | call | observed |  |
| Contracts.instantiate_with_code | call | observed |  |
| Contracts.upload_code | call | observed |  |
| Nfts.mint | call | observed |  |
| Assets.transfer_keep_alive | call | observed |  |
| Assets.mint | call | observed |  |
| Utility.batch_all | call | observed |  |
| ReviveApi | runtimeApi | observed | in runtime version apis (id 0x8c403e5c4a9fd442, v2) |
| ContractsApi | runtimeApi | observed | in runtime version apis (id 0x68b66ba122c93fa7, v2) |
| state_call | rpcMethod | observed |  |
| system_dryRun | rpcMethod | observed |  |
| payment_queryInfo | rpcMethod | observed |  |
| contracts_call | rpcMethod | absent |  |
| AuthorizeCall | signedExtension | observed |  |
| CheckNonZeroSender | signedExtension | observed |  |
| CheckSpecVersion | signedExtension | observed |  |
| CheckTxVersion | signedExtension | observed |  |
| CheckGenesis | signedExtension | observed |  |
| CheckMortality | signedExtension | observed |  |
| CheckNonce | signedExtension | observed |  |
| CheckWeight | signedExtension | observed |  |
| ChargeAssetTxPayment | signedExtension | observed |  |
| CheckMetadataHash | signedExtension | observed |  |
| EthSetOrigin | signedExtension | observed |  |
| WeightReclaim | signedExtension | observed |  |
