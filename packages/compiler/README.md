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
`CHAIN_MISMATCH`, `FACTS_INVALID`, `ENCODE_FAILED`, and for the ink! ABI form `ABI_INVALID`, `ABI_HASH_MISMATCH`,
`ABI_MESSAGE_UNKNOWN`, `ABI_ARGS_INVALID`.

Options: `allowAtomicUnverified` (default `false`); `abis` (map of name → ink! metadata JSON, used by `abiRef`).

Other exports: `computePlanDigest(plan)`, `computeManifestDigest(manifest)`, `computeFingerprintDigest(fp)`,
`canonicalJson`, `digestJson`, `loadRuntime`, `readPinnedTypes`, `KIND_TO_CAPABILITY`,
`encodeInkMessage`, `decodeInkMessage(abi, data, ss58Prefix)`, `computeAbiHash(abi)`, `loadInkAbi`.

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
| `contracts.call` | `Contracts.call` | `contract`, `value`, `gasLimit`, and **either** `data` (hex: ink! selector + SCALE args) **or** `message` + `abi`/`abiRef` (+ `args`, optional `abiHash`), see below |
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

### contracts.call from an ink! ABI

Instead of hand-encoding `data`, name the message and give the contract's ink! metadata (`metadata.json`, or a whole
`.contract` bundle; ink! metadata V0 to V5, read offline by `@polkadot/api-contract`'s `Abi`):

```jsonc
{ "id": "settle", "kind": "contracts.call",
  "args": { "contract": "5FHn…94ty", "value": "0", "gasLimit": "5000000000",
            "message": "settle",
            "args": { "order_id": 7, "amount": "2500000000000000" },   // or positional: [7, "2500000000000000"]
            "abi": { /* metadata.json */ } } }                      // or "abiRef": "seam_demo" + options.abis
```

- **Exactly one** of `data` or `message`. `args`, `abi`, `abiRef`, `abiHash` are only allowed with `message`, and
  exactly one of `abi` / `abiRef` is required. `abiRef` names an entry of `compile(..., { abis })`; the manifest then
  stays small, and the plan still pins the ABI by hash. An optional `abiHash` in the manifest must match
  (`ABI_HASH_MISMATCH`).
- The compiler encodes `data = selector ‖ SCALE(args)` using the ABI's own type info, so **`data` still starts with the
  4-byte selector** (policy's `allowedSelectors` keeps working unchanged).
- Arguments are checked strictly against the ABI before encoding: integers as digit strings (or safe integers),
  range-checked to the type's bits; `AccountId` as SS58 **with the chain prefix** or `0x` + 64 hex; `bool`; `String`;
  `Vec<u8>` / `[u8; N]` / `Hash` as `0x` hex (exact length for fixed); structs as objects with exactly their fields;
  tuples/vectors as arrays; `Option` as `null` or the value; enums as `"Variant"` or `{ "Variant": value }`.
  Anything else is `ABI_ARGS_INVALID` with the exact path (e.g. `actions[1].args.args.amount`), as are a wrong count,
  unknown/missing names, and a non-zero `value` for a non-payable message. Unknown message names
  (`ABI_MESSAGE_UNKNOWN`) list the messages the ABI has; constructors are refused.
- The encoded bytes are decoded again with the ABI and must give back the same message and args (`ENCODE_FAILED` otherwise).
- **ABI hash:** `abiHash = blake2b-256("seam/abi/v1" || 0x00 || canonicalJSON(abi))`. Key order doesn't matter;
  any other change (even docs) changes it.

The plan step then carries:

```jsonc
"decodedArgs": { "contract": "…", "contractAccountId": "0x…", "value": "0", "gasLimit": "5000000000",
                 "data": "0x<selector><args>", "message": "settle", "selector": "0x<4 bytes>", "abiHash": "0x…" },
"contractMessage": { "abiHash": "0x…", "abiRef": "seam_demo" /* only with abiRef */, "message": "settle",
                     "selector": "0x…", "args": { "order_id": "7", "amount": "2500000000000000" } }
```

Both are inside `planDigest`, so an approval covers the ABI, the message and the decoded arguments. `contractMessage.args`
is the normalised form (integers as strings, accounts as SS58 with the chain prefix, bytes as lowercase hex).
The raw-`data` form is unchanged: no `message`/`selector`/`abiHash` keys and no `contractMessage`, so existing plan
digests are identical.

## Plan

```ts
{
  planVersion: 1,
  manifestDigest, fingerprintDigest,
  signer: { type, value, publicKey },          // publicKey = AccountId32 hex (or H160)
  mode: 'atomic_verified' | 'atomic_unverified' | 'sequential' | 'unavailable',
  modeReason: string,                          // plain-language why
  steps: [{ actionId, kind, capability, palletIndex, callIndex, decodedArgs, encodedCall, status: 'ok'|'unavailable', reason?,
           contractMessage? }],   // contractMessage only for the ink! ABI form of contracts.call
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

`fixtures/ink/` holds ink! metadata used by the ABI tests: `seam_demo.v5.json` (our demo contract, a copy of
`contracts/seam-demo/artifacts/metadata.json` from branch `bot2/demo-contract`), `erc20.v5.json` (ink! 5, metadata V5) and `flipper.v3.json`
(ink! 3.0.0-rc7, metadata V3), both from the polkadot-js/api test fixtures (Apache-2.0) with the wasm blob removed.

## Known limits

- The ink! ABI form supports the argument types listed above; `Result`, maps and sets as message *arguments* are refused
  with `ABI_ARGS_INVALID` rather than guessed. Return values and events are not decoded by the compiler.
- Spec 1002 has the old `pallet-contracts` (Weight v1 `gas_limit: Compact<u64>`, no `storage_deposit_limit`). Newer runtimes
  with extra args make the step `unavailable` with a reason until a binding is added.
- polkadot.js prints `Unable to map [u8; 32] to a lookup index` once while converting V13 metadata. It's harmless.
