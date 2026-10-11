# @seam/compiler

The SEAM compiler turns a developer's **Manifest** into an exact, deterministic **Plan** of Portaldot calls,
using **RuntimeFacts** read from the chain's metadata. It runs fully offline: no network, no clock, no randomness.

```
Manifest ─┐
          ├─► compile() ─► Plan ─► preflight ─► policy ─► approve ─► sign ─► submit ─► verify ─► receipt
Facts ────┘
```

Standalone for now; it will move into the monorepo as `packages/compiler`.

## Quick start

```ts
import { readFileSync } from 'node:fs';
import { compile, factsFromMetadata, readPinnedTypes } from '@seam/compiler';

const facts = factsFromMetadata({
  metadataHex: readFileSync('fixtures/portaldot-mainnet-metadata.hex', 'utf8'), // state_getMetadata result
  typesBundle: readPinnedTypes(),            // types/portaldot-spec1002.json, exact text
  genesisHash: '0x83b5212c69f85f3996f8696bb35bf913af51b176a5f53d0a74fd3a83dc0b8a54',
  tokenSymbol: 'POT',
  tokenDecimals: 14,
  batchAllRollback: 'unknown'                // metadata cannot prove this; default 'unknown'
});

const plan = compile(manifest, facts, { allowAtomicUnverified: false });
```

```bash
npm install
npm run build   # tsc -> dist/
npm test        # vitest, offline, uses fixtures/
```

## API

### `factsFromMetadata(input): RuntimeFacts`

Builds facts from raw metadata bytes plus a pinned types file.

- `specName`, `specVersion`, `transactionVersion` and `ss58Prefix` are read **from the metadata**
  (`System.Version`, `System.SS58Prefix`). If you also pass them, they must match or it throws.
- `genesisHash`, `tokenSymbol`, `tokenDecimals` come from the caller (discovery reads them over RPC).
- `fingerprint.metadataHash` = blake2b-256 of the raw metadata bytes.
- `fingerprint.typesBundleHash` = blake2b-256 of the exact bytes of the pinned types file.
- `fingerprintDigest` = `blake2b-256( "seam/fingerprint/v1" || 0x00 || canonicalJSON(fingerprint) )` over exactly the
  nine fingerprint fields.
- `capabilities`: every call in the metadata as `'Pallet.call_name' -> { status: 'observed', palletIndex, callIndex, args, argTypesConfidence }`,
  plus `{ status: 'not_observed' }` for SEAM capabilities the metadata does not have
  (`Assets.transfer_keep_alive`, `Assets.mint`, `Contracts.call`, `Revive.call`, `Nfts.mint`, `Utility.batch_all`).
  `args[].name` is the runtime's own name (snake_case); `args[].type` is the polkadot.js type name.
  `argTypesConfidence` is `'full'` only when every arg type is a primitive or a type listed under `verified` in the pinned file.
- `behaviour.batchAllRollback`: whatever you pass (default `'unknown'`), forced to `'not_supported'` if `Utility.batch_all` is absent.
- `endpoint`, `blockNumber`: informational, not in the fingerprint, never in the plan.
- `source: { metadataHex, typesBundle }`: the raw material `compile()` needs to encode calls. Not in the fingerprint, but
  `compile()` re-hashes both and refuses facts where they don't match the fingerprint.

### `compile(manifest, facts, options?): Plan`

Throws `SeamCompileError` (with **all** problems found in `error.issues`, each `{ code, message, path }`) when the input is
wrong. Returns a Plan with `mode: 'unavailable'` when the input is fine but the runtime can't do it.

Error codes: `MANIFEST_INVALID`, `NOT_CANONICAL`, `AMOUNT_INVALID`, `ADDRESS_INVALID`, `ADDRESS_TYPE`, `SS58_PREFIX`,
`CHAIN_MISMATCH`, `FACTS_INVALID`, `ENCODE_FAILED`.

Options: `allowAtomicUnverified` (default `false`).

Other exports: `computePlanDigest(plan)`, `computeManifestDigest(manifest)`, `computeFingerprintDigest(fp)`,
`canonicalJson`, `digestJson`, `loadRuntime`, `readPinnedTypes`, `KIND_TO_CAPABILITY`.

## Manifest (draft v1, owned by Bot 5)

```jsonc
{
  "version": 1,
  "chain": { "genesisHash": "0x83b5…8a54", "specVersion": 1002 },   // optional; must match facts
  "signer": { "type": "ss58", "value": "5Grw…utQY", "ss58Prefix": 42 },
  "actions": [
    { "id": "pay", "kind": "assets.transfer",
      "args": { "assetId": "1", "amount": "2500000000000000", "recipient": "5FHn…94ty" } },
    { "id": "call", "kind": "contracts.call",
      "args": { "contract": "5FHn…94ty", "value": "0", "gasLimit": "5000000000", "data": "0x633aa551" } },
    { "id": "receipt", "kind": "assets.mint",
      "args": { "assetId": "2", "amount": "1", "recipient": "5FHn…94ty" } }
  ]
}
```

Args per kind (unknown arg names are rejected):

| kind | capability | args |
|---|---|---|
| `assets.transfer` | `Assets.transfer_keep_alive` | `assetId`, `amount`, `recipient` |
| `assets.mint` | `Assets.mint` | `assetId`, `amount`, `recipient` |
| `contracts.call` | `Contracts.call` | `contract`, `value`, `gasLimit`, `data` (hex: ink! selector + SCALE args); on Weight-v2 runtimes also `proofSize` and `storageDepositLimit` (see below) |
| `revive.call` | `Revive.call` | `contract` (H160), `value`, `data`, optional `gasLimit`, `storageDepositLimit` |
| `nfts.mint` | `Nfts.mint` | `collection`, `item`, `recipient` |

- **Amounts** (`amount`, `value`, `gasLimit`, `storageDepositLimit`) are base-unit **strings** of digits. Numbers, floats,
  decimals, signs, exponents and leading zeros are rejected. They're also range-checked against the runtime type
  (for example, the asset balance is u64 on spec 1002).
- **IDs** (`assetId`, `collection`, `item`) may be a digit string or a non-negative integer, normalised to a string.
- **Addresses**: native calls take an SS58 address **with the chain's prefix** (42 on Portaldot) or `0x` + 64 hex.
  H160 is only accepted for `revive.call` contracts, and as a signer only if every action is `revive.call`.
- **Manifest digest**: `blake2b-256("seam/manifest/v1" || 0x00 || canonicalJSON(manifest))`, where canonical JSON means
  sorted keys, no whitespace, integers only (any float anywhere → `NOT_CANONICAL`).

### contracts.call on old and new pallet-contracts

The compiler reads `Contracts.call`'s argument list from the metadata and supports both shapes:

| runtime | Contracts.call args | Manifest |
|---|---|---|
| Portaldot spec 1002 (metadata V13, Weight v1) | `dest, value, gas_limit: Compact<u64>, data` | `gasLimit`; `proofSize` / `storageDepositLimit` are refused (`MANIFEST_INVALID`) |
| e.g. substrate-contracts-node v0.42 (metadata V14, Weight v2) | `dest, value, gas_limit: Weight { ref_time, proof_size }, storage_deposit_limit: Option<Compact<Balance>>, data` | `gasLimit` (= ref_time), **`proofSize`**, **`storageDepositLimit`** |

- `proofSize` is a base-unit string (u64). Missing on a Weight-v2 runtime → the step is `unavailable`
  ("…takes gas_limit as Weight { ref_time, proof_size }; the manifest must give proofSize").
- `storageDepositLimit` is a base-unit string, or `null` meaning "no limit" (encoded as `None`). **Omitted** on a
  runtime that takes it → `unavailable` with "Contracts.call on this runtime takes argument(s) SEAM cannot fill:
  storageDepositLimit". SEAM never picks a default.
- Both land in the step's `decodedArgs` exactly as given (`proofSize: "262144"`, `storageDepositLimit: "…"` or `null`),
  so they are in `planDigest` and policy can check them. On Weight-v1 runtimes the keys are absent, so existing
  digests are unchanged.

## Plan

```ts
{
  planVersion: 1,
  manifestDigest, fingerprintDigest,
  signer: { type, value, publicKey },          // publicKey = AccountId32 hex (or H160)
  mode: 'atomic_verified' | 'atomic_unverified' | 'sequential' | 'unavailable',
  modeReason: string,                          // plain-language why
  steps: [{ actionId, kind, capability, palletIndex, callIndex, decodedArgs, encodedCall, status: 'ok'|'unavailable', reason? }],
  outerCall?: { capability: 'Utility.batch_all', palletIndex, callIndex, encodedCall },   // atomic modes only
  planDigest                                   // blake2b-256("seam/plan/v1" || 0x00 || canonicalJSON(plan without planDigest))
}
```

`encodedCall` is the SCALE-encoded call (pallet index, call index, args) with no length prefix.

The plan never contains a nonce, era/mortality, expiry, tip, fee or weight estimate. Those belong to the signing envelope
and preflight. (`gasLimit` for `contracts.call` is a call argument the developer declares, so it is in the call.)

**Determinism:** the same Manifest and the same RuntimeFacts give a byte-identical plan and `planDigest`, whatever the key order.
`endpoint` and `blockNumber` don't affect the plan.

### Rules

1. Each kind maps to a capability (table above). Pallet and call indexes are **never hard-coded**: they come from the
   facts, and `compile()` cross-checks them against the metadata (pallet name at that index, call name at that index).
2. A capability that is `not_observed` gives a step with `status: 'unavailable'` and a reason such as
   `"Nfts.mint is not on this runtime (spec 1002)"`. A capability that is `unknown` is also unavailable and is never assumed.
3. Runtime call arguments are bound by name. If a runtime's call has an argument SEAM doesn't know how to fill, the step is
   unavailable instead of guessed.
4. Mode:
   - any step unavailable → `unavailable` (no `outerCall`)
   - any action with `preferredMode: 'sequential'` → `sequential`
   - `Utility.batch_all` observed and `batchAllRollback: 'verified'` → `atomic_verified`
   - `Utility.batch_all` observed and rollback `'unknown'` → `atomic_unverified` **only** with `allowAtomicUnverified`, otherwise `sequential`
   - otherwise → `sequential`. If an action asked for `'atomic'`, `modeReason` says it could not be honoured.
   - a single step is never wrapped in `batch_all` (it's atomic on its own)
5. Manifest `chain` must match the fingerprint (genesis and spec version), otherwise `CHAIN_MISMATCH`.

## Pinned types (`types/portaldot-spec1002.json`)

**Only for metadata V13 runtimes.** `loadRuntime` / `factsFromMetadata` read the metadata version first:

- **V13 and older** (Portaldot spec 1002): a pinned types file is required. If it declares `metadataVersion` or
  `specVersion`, they must match the runtime, so the Portaldot file can't be applied to another V13 chain by mistake.
  `typesBundleHash` = blake2b-256 of the file (unchanged).
- **V14+** (self-describing): every type comes from the metadata's own registry. Any types file passed is ignored,
  `fingerprint.typesBundleHash` is **`null`**, `source.typesBundle` is the constant `NO_PINNED_TYPES` (`{"types":{}}`),
  and every capability's `argTypesConfidence` is `full`. `typesBundle` is optional in `factsFromMetadata`.

Portaldot spec 1002 serves **metadata V13**, which doesn't carry full type information, so polkadot.js needs type definitions.
The file pins them and records what was verified against chain data and what is assumed:

| type | value | status |
|---|---|---|
| `Address` / `LookupSource` | `MultiAddress` | **verified**: a real signed mainnet extrinsic (block 2721116) decodes and re-encodes byte-identically (`fixtures/mainnet-extrinsic-2721116.json`) |
| `AccountId` | AccountId32 | **verified**: same extrinsic |
| `Balance`, `BalanceOf` | `u128` | **verified**: 16-byte `Balances.ExistentialDeposit` / `Contracts.*Deposit` constants |
| `Weight` | `u64` | **verified**: 8-byte `Contracts.DeletionWeightLimit` constant |
| `AssetId` | `u32` | **assumed**: no assets exist on mainnet to check. Compact-encoded, so bytes only differ above 2^32 |
| `TAssetBalance` (asset balance) | `u64` | **assumed**: same reason |

Changing this file changes `typesBundleHash`, and with it the fingerprint and every plan digest.

## Fixtures

`fixtures/` holds copies of Bot 4's read-only captures of Portaldot mainnet (spec 1002, tx version 2, SS58 42, POT 14 decimals,
metadata blake2b `0x8b91f644…5150`), plus one real signed extrinsic used as type evidence. Tests make no network calls.

`fixtures/devnode-metadata.hex` + `devnode-snapshot.json` are a read-only capture of the local dev node
(substrate-contracts-node v0.42.0, spec 100, metadata V14, genesis `0xe8cf…b208`, metadata blake2b `0x9fd4…07b7`;
`state_getMetadata`, `state_getRuntimeVersion`, `chain_getBlockHash(0)`, `system_properties`). The node reports no token
properties; tests declare `UNIT` / 12 decimals.

## Known limits

- `contracts.call` takes `data` as raw hex. Encoding ink! messages from a contract ABI is not part of the compiler.
- `Contracts.call` shapes other than the two above (e.g. a future extra argument) make the step `unavailable` with a reason.
- polkadot.js prints `Unable to map [u8; 32] to a lookup index` once while converting V13 metadata. It's harmless.
