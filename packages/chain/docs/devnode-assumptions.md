# Spec-1002 / metadata-V13 assumptions found by running SEAM on substrate-contracts-node v0.42.0 (metadata V14)

Teammates' packages were NOT edited (main 241ac8c). Workarounds live in packages/chain (bot4/devnode).

## @seam/compiler (Bot 2)
UPDATE (bot4/ink-contract): item 1 is resolved. The compiler now binds Weight V2 `proofSize` and `storageDepositLimit` (null = none) and encodes ink! messages from an ABI; the run scripts no longer patch Contracts.call.
1. `compile.ts` ARG_BINDINGS / ARG_SCHEMA `contracts.call` = {dest, value, gasLimit, data}. On V14,
   Contracts.call is `call(dest, value, gas_limit: Weight{ref_time, proof_size}, storage_deposit_limit: Option<Compact<u128>>, data)`.
   Result: step `unavailable` ("takes argument(s) SEAM cannot fill: storageDepositLimit"), so the whole plan is unavailable.
   Even with the binding, a scalar gasLimit can't encode Weight V2.
   Needed: optional `storageDepositLimit` (None when absent) and `gasProofSize` (or gasLimit as {refTime, proofSize})
   for contracts.call, bound by type (Option<...>, SpWeightsWeightV2Weight).
   Workaround: scripts/devnode/flow.mjs `shimContractsCall` (marks decodedArgs.shim, recomputes planDigest with computePlanDigest).
2. `readPinnedTypes()` / `PORTALDOT_SPEC1002_TYPES_PATH` is the default types file everywhere. Its overrides
   (Weight u64, AssetId u32, TAssetBalance u64, Address/LookupSource MultiAddress) are V13/spec-1002 only. They happened
   not to break V14 (lookup types win), but they change typesBundleHash. Needed: choose the types file per chain (a V14+ file is `{"types":{}}`).
   Workaround: fixtures/devnode-types.json.
3. `facts.ts` argConfidence: every V14 arg using MultiAddress / SpWeightsWeightV2Weight is `partial` because `verified`
   only lists spec-1002 names. Informational; nothing gates on it today.
4. `compile.ts` range check regex `(Balance|Weight|AssetId)` name-based; on V14 types are `Compact<u128>`, `Compact<u32>`
   so it still works via `u\d+`. OK.
5. `withoutLookupWarning` comment: V13-specific, harmless on V14.

## @seam/policy (Bot 3)
6. `maxWeight` is a single number; on Weight V2 chains only ref_time is limited (proof_size not limited).
   @seam/chain reports ref_time as `weight`. Needed (later): optional `maxProofSize`.
7. `maxGasLimit` compares the scalar gasLimit (ref_time); proof_size of a contract call isn't limited.
8. `maxNativeValue` doc says "POT base units": token-agnostic in code, fine.
Everything else (call_index check from encoded bytes, per-step gate, approval binding) worked unchanged on V14.

## @seam/sdk (Bot 5)
9. `offline.ts` factsFromSnapshot: hard-coded file names `portaldot-mainnet-*.json/hex`, default spec-1002 types,
   tokenSymbol/decimals straight from properties (devnode has none -> undefined). Needed: name/typesBundle/declaredToken params.
10. `Seam.prepare` takes no CompileOptions (allowAtomicUnverified) and no plan override, so atomic_unverified plans and the
    contracts.call shim need prepare's three steps done by hand (as flow.mjs does).
11. `receipt.ts` comment "spec 1002 uses metadata v13, which has no field names": on V14 events DO have names; @seam/chain
    still gives positional args, and expectedEvent's order (Transferred: asset, from, to, amount; Issued: asset, owner,
    amount) matches V14 too. Verified on chain.
12. `cli.ts` default snapshot is the bundled mainnet spec 1002.

## @seam/console (Bot 1)
13. Default endpoint wss://mainnet.portaldot.io and demo scenarios pinned to spec 1002 / POT / V13 metadata.

## Own (@seam/chain), fixed on bot4/devnode
- DECODE_TYPES (DispatchError Module {index u8, error u8}) now only for metadata <= V13.
- payment_queryInfo Weight V2 JSON is snake_case {ref_time, proof_size}: was read as refTime only -> "unknown".
- contracts_call RPC removed on newer nodes -> ContractsApi_call (v2) via state_call.
- tokenSymbol/decimals: system_properties is {} -> explicit `declaredToken` (recorded in the snapshot).
- Block time: no Babe; 2 x Timestamp.MinimumPeriod = 10 ms is not a block time -> blockTimeMs must be passed.
- Signing checkpoint: finalized == best (instant seal) made system_dryRun say AncientBirthBlock -> use its parent.
- BUG (all chains): asset-existence storage key carried polkadot.js's compact length prefix, so every asset looked
  missing (incl. the earlier mainnet "assets 1 and 2 don't exist" note). Fixed with storageKey(); re-checked mainnet
  read-only: Assets.Asset has no keys at all, so the conclusion still holds.
