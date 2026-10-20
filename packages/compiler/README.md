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
import { readFileSync } from "node:fs";
import { compile, factsFromMetadata, readPinnedTypes } from "@seam/compiler";

const facts = factsFromMetadata({
  metadataHex: readFileSync("fixtures/portaldot-mainnet-metadata.hex", "utf8"), // state_getMetadata result
  typesBundle: readPinnedTypes(), // types/portaldot-spec1002.json, exact text
  genesisHash: "0x83b5212c69f85f3996f8696bb35bf913af51b176a5f53d0a74fd3a83dc0b8a54",
  tokenSymbol: "POT",
  tokenDecimals: 14,
  batchAllRollback: "unknown", // metadata cannot prove this; default 'unknown'
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
  "chain": { "genesisHash": "0x83b5…8a54", "specVersion": 1002 }, // optional; must match facts
  "signer": { "type": "ss58", "value": "5Grw…utQY", "ss58Prefix": 42 },
  "actions": [
    {
      "id": "pay",
      "kind": "assets.transfer",
      "args": { "assetId": "1", "amount": "2500000000000000", "recipient": "5FHn…94ty" },
    },
    {
      "id": "call",
      "kind": "contracts.call",
      "args": {
        "contract": "5FHn…94ty",
        "value": "0",
        "gasLimit": "5000000000",
        "data": "0x633aa551",
      },
    },
    {
      "id": "receipt",
      "kind": "assets.mint",
      "args": { "assetId": "2", "amount": "1", "recipient": "5FHn…94ty" },
    },
  ],
}
```

Args per kind (unknown arg names are rejected):

| kind              | capability                   | args                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets.transfer` | `Assets.transfer_keep_alive` | `assetId`, `amount`, `recipient`                                                                                                                                                                                                        |
| `assets.mint`     | `Assets.mint`                | `assetId`, `amount`, `recipient`                                                                                                                                                                                                        |
| `contracts.call`  | `Contracts.call`             | `contract`, `value`, `gasLimit`, and **either** `data` (hex: ink! selector + SCALE args) **or** `message` + `abi`/`abiRef` (+ `args`, optional `abiHash`); on Weight-v2 runtimes also `proofSize` and `storageDepositLimit` (see below) |
| `revive.call`     | `Revive.call`                | `contract` (H160), `value`, `data`, optional `gasLimit`, `proofSize`, `storageDepositLimit` (only compiles when metadata verifies, see below)                                                                                           |
| `nfts.mint`       | `Nfts.mint`                  | `collection`, `item`, `recipient`                                                                                                                                                                                                       |

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
{
  "id": "settle",
  "kind": "contracts.call",
  "args": {
    "contract": "5FHn…94ty",
    "value": "0",
    "gasLimit": "5000000000",
    "message": "settle",
    "args": { "order_id": 7, "amount": "2500000000000000" }, // or positional: [7, "2500000000000000"]
    "abi": {/* metadata.json */},
  },
} // or "abiRef": "seam_demo" + options.abis
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

### contracts.call on old and new pallet-contracts

The compiler reads `Contracts.call`'s argument list from the metadata and supports both shapes:

| runtime                                                       | Contracts.call args                                                                                              | Manifest                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Portaldot spec 1002 (metadata V13, Weight v1)                 | `dest, value, gas_limit: Compact<u64>, data`                                                                     | `gasLimit`; `proofSize` / `storageDepositLimit` are refused (`MANIFEST_INVALID`) |
| e.g. substrate-contracts-node v0.42 (metadata V14, Weight v2) | `dest, value, gas_limit: Weight { ref_time, proof_size }, storage_deposit_limit: Option<Compact<Balance>>, data` | `gasLimit` (= ref_time), **`proofSize`**, **`storageDepositLimit`**              |

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

**Only for metadata V13 runtimes.** `loadRuntime` / `factsFromMetadata` read the metadata version first:

- **V13 and older** (Portaldot spec 1002): a pinned types file is required. If it declares `metadataVersion` or
  `specVersion`, they must match the runtime, so the Portaldot file can't be applied to another V13 chain by mistake.
  `typesBundleHash` = blake2b-256 of the file (unchanged).
- **V14+** (self-describing): every type comes from the metadata's own registry. Any types file passed is ignored,
  `fingerprint.typesBundleHash` is **`null`**, `source.typesBundle` is the constant `NO_PINNED_TYPES` (`{"types":{}}`),
  and every capability's `argTypesConfidence` is `full`. `typesBundle` is optional in `factsFromMetadata`.

Portaldot spec 1002 serves **metadata V13**, which doesn't carry full type information, so polkadot.js needs type definitions.
The file pins them and records what was verified against chain data and what is assumed:

| type                            | value          | status                                                                                                                                            |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Address` / `LookupSource`      | `MultiAddress` | **verified**: a real signed mainnet extrinsic (block 2721116) decodes and re-encodes byte-identically (`fixtures/mainnet-extrinsic-2721116.json`) |
| `AccountId`                     | AccountId32    | **verified**: same extrinsic                                                                                                                      |
| `Balance`, `BalanceOf`          | `u128`         | **verified**: 16-byte `Balances.ExistentialDeposit` / `Contracts.*Deposit` constants                                                              |
| `Weight`                        | `u64`          | **verified**: 8-byte `Contracts.DeletionWeightLimit` constant                                                                                     |
| `AssetId`                       | `u32`          | **assumed**: no assets exist on mainnet to check. Compact-encoded, so bytes only differ above 2^32                                                |
| `TAssetBalance` (asset balance) | `u64`          | **assumed**: same reason                                                                                                                          |

Changing this file changes `typesBundleHash`, and with it the fingerprint and every plan digest.

## Fixtures

`fixtures/` holds copies of Bot 4's read-only captures of Portaldot mainnet (spec 1002, tx version 2, SS58 42, POT 14 decimals,
metadata blake2b `0x8b91f644…5150`), plus one real signed extrinsic used as type evidence. Tests make no network calls.

`fixtures/ink/` holds ink! metadata used by the ABI tests: `seam_demo.v5.json` (our demo contract, a copy of
`contracts/seam-demo/artifacts/metadata.json` from branch `bot2/demo-contract`), `erc20.v5.json` (ink! 5, metadata V5) and `flipper.v3.json`
(ink! 3.0.0-rc7, metadata V3), both from the polkadot-js/api test fixtures (Apache-2.0) with the wasm blob removed.

`fixtures/devnode-metadata.hex` + `devnode-snapshot.json` are a read-only capture of the local dev node
(substrate-contracts-node v0.42.0, spec 100, metadata V14, genesis `0xe8cf…b208`, metadata blake2b `0x9fd4…07b7`;
`state_getMetadata`, `state_getRuntimeVersion`, `chain_getBlockHash(0)`, `system_properties`). The node reports no token
properties; tests declare `UNIT` / 12 decimals.

## Runtime shape check (`scripts/v3-shape-check.mjs`)

Read-only report of what a runtime's metadata gives SEAM. Run `npm run build` first.

```bash
node scripts/v3-shape-check.mjs fixtures/devnode-metadata.hex        # file: hex, or JSON with metadataHex/metadata/result
node scripts/v3-shape-check.mjs wss://<rpc-endpoint> [--json]        # RPC: state_getMetadata, chain_getBlockHash(0), system_properties only
```

It runs `factsFromMetadata`, compiles a built-in sample (assets transfer + mint + a raw-`data` `contracts.call`) and prints the
pallet/call indices found, the `Contracts.call` shape (V13 single `gas_limit` vs V14 `Weight` + `storage_deposit_limit`), and every
step that is unavailable with its reason. It never signs or submits. (Submitting is `scripts/testnet-run.mjs`, a separate tool.)

## Metadata layout hash (`metadataLayoutHash`, `metadataLayout`, `blankStorageFallbacks`)

blake2b-256 over `utf8("seam/metadata-layout/v1") ++ metadata` with every storage entry's `fallback` blanked; the same
definition and value as `@seam/chain`'s `metadataLayoutHash`. Fail closed: if the metadata (V13-V15) does not
decode and rebuild unchanged byte for byte, the hash is taken over the raw bytes under
`seam/metadata-layout/v1/raw` (`normalized: false`), so it only ever matches identical bytes, and the compiler never
accepts a rollback proof on it. `factsFromMetadata({ ..., withLayoutHash: true })` records it as
`facts.metadataLayoutHash`; that field is outside the fingerprint and every digest, and if present must match the bytes
(`FACTS_INVALID` otherwise). Fingerprints and plan digests are unchanged: the runtime lock still binds the raw hash.

## Known limits

- The ink! ABI form supports the argument types listed above; `Result`, maps and sets as message _arguments_ are refused
  with `ABI_ARGS_INVALID` rather than guessed. Return values and events are not decoded by the compiler.
- `Contracts.call` shapes other than the two above (e.g. a future extra argument) make the step `unavailable` with a reason.
- polkadot.js prints `Unable to map [u8; 32] to a lookup index` once while converting V13 metadata. It's harmless.

## Audit notes (SEAM-006/007/009/011/012/013)

- `Manifest.atomicRequired` (boolean, optional; in the manifest digest only when present). Required atomic that cannot be met -> plan `mode: 'unavailable'`, every step `encodedCall: null`, `reasonCode: 'ATOMIC_REQUIRED_UNAVAILABLE'`. `preferredMode: 'atomic'` that falls back sets `Plan.modeDowngrade` (`requiresApproval: true`).
- `atomic_verified` needs `facts.behaviour.batchAllRollbackProof` matching genesis + metadataHash + specVersion and covering the plan's action kinds.
  - **Layout-hash match (opt-in, proof side).** A proof may also carry `metadataLayoutHash` and `specName`. When its raw
    `metadataHash` differs from the facts', it is accepted only if `specName`, `transactionVersion`, `ss58Prefix` and
    `batchAll { palletIndex, callIndex }` (Utility.batch_all on the tested runtime) are all present and equal to the
    facts' (a missing one rejects), `metadataLayoutHash`
    equals `metadataLayoutHash(facts.source.metadataHex)` (computed by the compiler from the bytes, never taken from the
    facts), and that metadata normalized (decode + rebuild round-trips byte for byte). Genesis, `specVersion` and
    composition are checked exactly as before; the proof's `fingerprintDigest` is only checked on a raw-hash match. The
    plan's `modeReason` then says "accepted on layout hash; raw metadata differs only in storage defaults". The plan also
    carries `rollbackProofBasis: "layout_hash"`, covered by `planDigest`; on the strict basis the field is absent, so
    raw-hash plans keep their exact digests. Anything that cannot be read or decoded rejects the proof (never atomic). A proof
    without `metadataLayoutHash` keeps the strict raw-hash rule.
  - Why: Portaldot V3 spec 3002 changes its raw metadata between blocks (the state-dependent default of
    `Revive.EthBlockBuilderIR`), so a proof bound to raw bytes goes stale within minutes. A bare `'verified'` string is the deprecated path: at best `atomic_unverified` (with `allowAtomicUnverified`), never `atomic_verified`.
- `SIGNER_DOMAIN_MISMATCH`: 20-byte H160 signer vs 32-byte AccountId32 signing account (`facts.signingAccountBytes`, default 32). No conversion.
- Facts now also carry `metadataVersion`, optional `stateVersion` and `tokenProvenance` (declared/observed). None of them feed the fingerprint; fingerprint schema is unchanged (V1), so `fingerprintDigest` is byte-identical.
- SEAM-006/007 (`revive.call`, `nfts.mint`): without facts that observe the capability, and metadata that really has that pallet/call at the stated indices, the step stays unavailable with `reasonCode: 'NO_OBSERVED_V3_METADATA'` (unchanged). When a supplied snapshot (`factsFromMetadata` output) does contain the call, SEAM reads its argument list from the metadata and compiles only if it matches the shape contract in `src/v3-bindings.ts` exactly (names, order, and type classes: `revive.call` = dest H160, value balance, gas_limit Weight/u64, storage_deposit_limit (Option) balance, data Bytes; `nfts.mint` = collection id, item id, mint_to account, witness_data Option, always encoded as None). Any other shape is unavailable with `reasonCode: 'V3_ARG_SHAPE_MISMATCH'` and a reason listing the observed arguments. No indices or layouts are hardcoded. The tests use **synthetic** metadata (`tests/synthetic-v3.ts`, hand-edited from the dev-node capture); no real Portaldot V3 metadata has been observed, so nothing here is V3-verified. The real dev-node `Revive.call` (older upstream layout, `dest: MultiAddress`) is refused by this check.

### `revive.call` argument names and `storage_deposit_limit` (real V3 spec 3002 layout)

- The weight argument is matched as `gas_limit` **or** `weight_limit` (camelCased `gasLimit` / `weightLimit`), both fed by the manifest's `gasLimit` (+ `proofSize` for Weight v2). Types are still checked strictly; any other name or a wrong type is `V3_ARG_SHAPE_MISMATCH`.
- `storage_deposit_limit` may be `Option<Compact<u128>>` (manifest value, or `null` = `None`) or a plain `Compact<u128>` as on the real V3 layout. For the plain form a value is encoded as given; `null` is refused (`MANIFEST_INVALID`, never coerced to 0 or "no limit") and omitting it is `unavailable`. SEAM never picks a default.
- `tests/fixtures/v3-testnet-spec3002-layouts.json` is a real V3 spec 3002 **layout** fixture (copied from `packages/chain`); tests compare the expected shape against it. Nothing about execution, account mapping or atomicity on V3 is verified by this.
