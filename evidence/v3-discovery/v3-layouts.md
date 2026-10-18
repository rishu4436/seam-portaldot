# V3 testnet call layouts (REAL metadata, read-only)

Source: REAL metadata of `portaldot-v3` spec 3002 (metadata V14) read from `wss://test-node-v3.portaldot.dev` (chain "PortaldotV3 Test", genesis `0xd4f9acbc…5283bd`) on 2026-10-18. Decoded from `portaldot-v3-spec3002-metadata.hex`; machine-readable form in `packages/chain/tests/fixtures/v3-testnet-spec3002-layouts.json`.
Nothing was signed or sent. **Layouts are what the metadata declares. Execution behaviour is NOT VERIFIED.**

## Chain properties (system_properties, as returned)
ss58Format 42, tokenSymbol `tPOT`, tokenDecimals 14. (The stated config says `tPOTv3`; the node reports `tPOT`. Decimals match.)

## Layouts (pallet index, call index; args in order)
| call | idx | arguments |
|---|---|---|
| Revive.call | 80 / 1 | `dest: H160` ([u8;20]), `value: Compact<u128>`, `weight_limit: Weight{ref_time: Compact<u64>, proof_size: Compact<u64>}`, `storage_deposit_limit: Compact<u128>`, `data: Vec<u8>` |
| Revive.map_account | 80 / 7 | no arguments |
| Revive.instantiate_with_code | 80 / 3 | `value: Compact<u128>`, `weight_limit: Weight`, `storage_deposit_limit: Compact<u128>`, `code: Vec<u8>`, `data: Vec<u8>`, `salt: Option<[u8;32]>` |
| Revive.upload_code | 80 / 4 | `code: Vec<u8>`, `storage_deposit_limit: Compact<u128>` |
| Nfts.mint | 47 / 3 | `collection: u32`, `item: u32`, `mint_to: MultiAddress<AccountId32, …>` (Id/Index/Raw/Address32/Address20), `witness_data: Option<MintWitness{owned_item: Option<u32>, mint_price: Option<u128>}>` |

Revive storage entries listed: PristineCode, CodeInfoOf, AccountInfoOf, NativeDepositOf, ImmutableDataOf, DeletionQueue, DeletionQueueCounter, **OriginalAccount**, EthereumBlock, BlockHash, ReceiptInfoData, EthBlockBuilderIR, EthBlockBuilderFirstValues, DebugSettingsOf.

## Compared with what the compiler expects (`packages/compiler/src/v3-bindings.ts`; compiler not changed)
| item | compiler expects | real metadata | match |
|---|---|---|---|
| Revive.call dest | H160 / [u8;20] | `H160` | yes |
| Revive.call value | Compact u64/u128 | `Compact<u128>` | yes |
| Revive.call weight | arg named **`gasLimit`**, Weight v2 | arg named **`weight_limit`** (`weightLimit`), Weight v2 | **type yes, NAME NO** |
| Revive.call storage_deposit_limit | balance or Option<balance> | `Compact<u128>` (not Option) | yes |
| Revive.call data | Bytes | `Bytes` | yes |
| Nfts.mint collection / item | uN | u32 / u32 | yes |
| Nfts.mint mint_to | AccountId32 or MultiAddress.Id | `MultiAddress` (accepted via Id variant) | yes |
| Nfts.mint witness_data | Option (SEAM encodes None) | `Option<MintWitness>` | yes |

Net effect: the compiler matches argument names exactly, so the real `Revive.call` is refused with `V3_ARG_SHAPE_MISMATCH` solely because the weight argument is called `weight_limit`, not `gas_limit`. The types line up. Nfts.mint passes the shape check. Whether to accept `weightLimit` as an alias is a compiler decision for the owner (Forge); this branch changes nothing there.

## Preflight on this real metadata (offline FakeNode serving it; see `packages/chain/tests/v3-real-fixture.test.ts`)
- revive.call: compiler `unavailable`, `V3_ARG_SHAPE_MISMATCH`; coverage `basis: unobserved`, `proves: nothing`; simulation not attempted; accountMapping `unknown` (`map_account` present in metadata, no OriginalAccount entry read, so not known mapped).
- nfts.mint: compiler `ok` (encoded); coverage `basis: unobserved`, `proves: nothing`; wholePlan `none`.
- Preflight node answers in that test come from a fake node, not the real chain. Account-mapping derivation rule (keccak of AccountId32, last 20 bytes) is the generic pallet-revive rule, NOT VERIFIED on V3.
