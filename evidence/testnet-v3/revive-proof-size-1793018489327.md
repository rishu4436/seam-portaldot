# Revive proof_size on V3 (spec 3002) — DRY RUN ONLY

Nothing was signed, submitted or deployed. No signature bytes (real or dummy) were built. Read RPC only.
Script: `packages/chain/scripts/v3-revive-proof-size.mjs`. At finalized #203373 `0x226aec13813aca0f13edf2ae3f029b4341898b75c276b181ff178f49485a6176`. Raw RPC results in the JSON (blob params shortened to prefix + length + sha256).

## Root cause of proof_size 0
Not a decode bug. ContractResultV1.weight_required is Weight{ref_time: Compact<u64>, proof_size: Compact<u64>}; the polkadot.js metadata decode and an independent hand decode of the raw SCALE bytes agree (proof_size compact byte 0x00). On V3 spec 3002 Revive's contract-execution meter does not charge proof_size: weight_required.proof_size is 0 with gas_limit None, at the block max_extrinsic, and with an explicit proof_size LIMIT of 0 the instantiate still succeeds (only ref_time triggers OutOfGas, Module 80 error 0x03). System BlockWeights has max_block.proof_size = u64::MAX (standalone chain, PoV not bounded). The old escrow-*-dryrun 0s are therefore real readings, not a bug; those files are unchanged.

## Instantiate dry runs (ReviveApi_instantiate): ok | weight_required ref_time / proof_size | error
| Variant | gas_limit None | block max_extrinsic | ref_time exact, proof 0 | ref_time −10%, proof 0 |
|---|---|---|---|---|
| SeamEscrowOne-r1 (858 B) | True | 5342770 / 0 |  | True | 5342770 / 0 |  | True | 5342770 / 0 |  | False | 4808296 / 0 | {"Err": {"Module": {"index": "80", "error": "0x03000000"}}} |
| Floor-stop (13 B) | True | 663430 / 0 |  | True | 663430 / 0 |  | True | 663430 / 0 |  | False | 69714 / 0 | {"Err": {"Module": {"index": "80", "error": "0x03000000"}}} |

Minimum ref_time that passes (binary search, proof limit 0): SeamEscrowOne-r1 5342770, Floor-stop 663430. No proof_size search was possible: proof limit 0 already passes.

## Extrinsic-level weight (TransactionPaymentCallApi_query_call_info, call only)
- SeamEscrowOne-r1: limit {'refTime': '6411324', 'proofSize': '0'} → pre-dispatch {'refTime': 946505864, 'proofSize': 6823}, static proof overhead 6823, partialFee 9890677431283
- SeamEscrowOne-r1: limit {'refTime': '6411324', 'proofSize': '1000000'} → pre-dispatch {'refTime': 946505864, 'proofSize': 1006823}, static proof overhead 6823, partialFee 9920677431283
- SeamEscrowOne-r1: limit {'refTime': '6411324', 'proofSize': '15679732462653118873'} → pre-dispatch {'refTime': 946505864, 'proofSize': '0xd99999999999b440'}, static proof overhead 6823, partialFee 10992570161159
- Floor-stop: limit {'refTime': '796116', 'proofSize': '0'} → pre-dispatch {'refTime': 923667866, 'proofSize': 6823}, static proof overhead 6823, partialFee 1380663695410
- Floor-stop: limit {'refTime': '796116', 'proofSize': '1000000'} → pre-dispatch {'refTime': 923667866, 'proofSize': 1006823}, static proof overhead 6823, partialFee 1410663695410
- Floor-stop: limit {'refTime': '796116', 'proofSize': '15679732462653118873'} → pre-dispatch {'refTime': 923667866, 'proofSize': '0xd99999999999b440'}, static proof overhead 6823, partialFee 2482570161159

TransactionPaymentApi_query_info was not used: it takes a signed extrinsic.

## Eth side
- JSON-RPC `eth_chainId` / `eth_estimateGas` on `https://test-node-v3.portaldot.dev` and `/eth`: `-32601 Method not found` (no eth-rpc proxy on this URL). `rpc_methods` lists no eth_ methods.
- Runtime API `ReviveApi_eth_estimate_gas`: SeamEscrowOne-r1 {'Ok': '1,997,782,456,654,762'}, Floor-stop {'Ok': '445,821,661,489,077'}. `ReviveApi_eth_transact` also gives weight_required proof_size 0.
- Constants: gasScale 5, nativeToEthRatio 10000, maxEthExtrinsicWeight 900000000000000000. Eth gas here is fee-denominated (it includes the storage deposit), so it is not a proof-size bound.

## On-chain cross-check: deploy #102843 ext 1 (checkpoint #102840)
ExtrinsicSuccess dispatch_info.weight = {'refTime': 1524333644, 'proofSize': 19007} (limit sent: ref_time 50,000,000,000, proof_size 1,000,000). Pre-dispatch then was 1,019,007 proof, so the execution part was refunded to 0.

## Recommendation
weight_limit = { ref_time: weight_required.ref_time * 1.2 (dry run), proof_size: a stated non-zero cap, e.g. 1,000,000 as in #102840 (refunded; costs ~0.0003 tPOT extra pre-dispatch fee) }, and check the whole extrinsic with query_call_info: pre-dispatch proof_size must equal cap + measured static overhead. Do NOT relax Sentinel's rule to accept 0 from weight_required; the dry run's 0 means 'not metered', which still is not a measured bound.

## Old evidence
`escrow-dryrun-1792555095045` and `escrow-min-dryrun-1793017079627` are unchanged. Their proof_size 0 is a correct reading (not a decode bug): the execution meter does not charge proof size on this runtime.
