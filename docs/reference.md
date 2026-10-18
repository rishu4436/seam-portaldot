# Reference

## Manifest

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Always `1`. |
| `chain` | no | `{ genesisHash, specVersion }`. If set, compiling against any other chain or runtime fails. |
| `signer` | yes | `{ type, value, ss58Prefix? }`. `type` is `ss58`, `accountId32` or `h160`. |
| `actions` | yes | One or more actions, run in order. |

Each action has an `id` (1 to 32 letters, digits, `-` or `_`, unique), a `kind`, `args`, and an optional `preferredMode` (`atomic` or `sequential`).

| Kind | Args | Runtime call |
|---|---|---|
| `assets.transfer` | `assetId`, `amount`, `recipient` | `Assets.transfer_keep_alive` |
| `assets.mint` | `assetId`, `amount`, `recipient` | `Assets.mint` |
| `contracts.call` | `contract`, `value`, `gasLimit`, then either `data` (hex) or `message` + `args` + `abi`/`abiRef` (see below). Optional `proofSize`, `storageDepositLimit` | `Contracts.call` (ink!) |
| `revive.call` | `contract`, `value`, `data`, optional `gasLimit`, `storageDepositLimit` | `Revive.call` (Solidity) |
| `nfts.mint` | `collection`, `item`, `recipient` | `Nfts.mint` |

Rules: amounts are base-unit strings, never numbers. Unknown fields and argument names are rejected. Addresses are checked against the signer's type and the chain's SS58 prefix. Call and pallet indexes always come from the live metadata and are never hard-coded.

### contracts.call fields

| Field | Meaning |
|---|---|
| `contract`, `value`, `gasLimit` | Required. `gasLimit` is `refTime` on runtimes with two-part weights. |
| `proofSize` | Optional string. The proof-size part of the weight limit, on runtimes with two-part weights. |
| `storageDepositLimit` | Optional string, or `null`. `null` means you chose no limit on purpose. Leave it out and the runtime default applies. A policy with `maxStorageDeposit` blocks a call that sets `null`. |
| `data` | The encoded call as hex. Use this **or** `message`, never both. |
| `message` | An ink! message name, such as `"transfer"`. SEAM encodes the selector and arguments for you. |
| `args` | The message's arguments, as an object keyed by the ABI's argument names or as a list in order. Integers are strings (small ones may be numbers), accounts are SS58 or `0x` hex. Only allowed with `message`. |
| `abi` | The contract's `metadata.json` object, inline. Give **exactly one** of `abi` or `abiRef`. |
| `abiRef` | A name for an ABI you pass separately: `compile(manifest, facts, { abis: { erc20: abiJson } })`, `new Seam(chain, store, { abis })`, or `seam compile --abi erc20=./erc20.json`. Keeps the Manifest small. |
| `abiHash` | Optional pin. Compiling fails if the ABI doesn't hash to this value. |

The plan records `contractMessage` for these calls (`abiHash`, `abiRef`, `message`, `selector`, decoded `args`) and it is covered by the plan digest. In the SDK, `action.contractCall(id, args)` takes either form.

**ABI errors.** Compiling a `message` call can fail with these codes (each names the exact field in its path):

| Code | Meaning |
|---|---|
| `ABI_INVALID` | Neither or both of `abi`/`abiRef` were given, the `abiRef` isn't in `abis`, or the ABI isn't usable ink! metadata. |
| `ABI_HASH_MISMATCH` | The ABI's hash differs from the pinned `abiHash`. |
| `ABI_MESSAGE_UNKNOWN` | The ABI has no message with that name. |
| `ABI_ARGS_INVALID` | The arguments don't fit the message: missing, extra, or a value of the wrong type or size. |

**Digests** are blake2b-256 of a domain name (such as `seam/manifest/v1`), then one `0x00` byte, then canonical JSON (keys sorted, no spaces, integers only).

## Plan modes

| Mode | Meaning |
|---|---|
| `atomic_verified` | One `Utility.batch_all` transaction, and the chain has been shown to undo every step if one fails. |
| `atomic_unverified` | One `batch_all`, but the rollback hasn't been proven. Only used if the app asks for it, and the default policy refuses it. |
| `sequential` | The default. One transaction per step. Before each step SEAM re-reads the runtime, dry-runs that step and re-runs the submit gate. It stops at the first step that fails or doesn't verify. |
| `unavailable` | At least one step needs something the runtime doesn't have, or that couldn't be confirmed. Nothing can run. |

## Policy

Set by the app, in code or as a JSON file. A file is checked by `parsePolicy`, which rejects unknown or misspelled fields, number amounts, negative limits and bad modes. It also warns about loose settings, such as recipients set to `"any"`. Add `"base": "portaldot"` to start from the Portaldot preset. `portaldotPolicy()` is the preset for Portaldot spec 1002: it allows an unknown storage deposit (this runtime never reports one) and an unknown dry run before signing. Nothing else is relaxed.

| Field | Default | Meaning |
|---|---|---|
| `allowedCapabilities` | `"any"` | Runtime calls the app may use. |
| `allowedAssets`, `allowedContracts`, `allowedRecipients` | `[]` (nothing) | Lists, or `"any"`. |
| `allowedSelectors` | none | Allowed 4-byte contract messages, per contract. |
| `allowedMessages` | none | Allowed ink! message names, per contract: a map from contract address to a list of message names, such as `{ "5F…": ["transfer"] }`. A call whose message isn't listed is blocked, and so is a raw-data call with no message name. |
| `pinnedAbiHashes` | none | A map from contract address to the interface (ABI) hash the call must use. A call with no hash, or a different one, is blocked. |
| `maxAmountPerAsset` | none | Base-unit cap per asset id. `"*"` applies to any asset not listed. |
| `maxNativeValue`, `maxGasLimit`, `maxWeight`, `maxFee`, `maxStorageDeposit` | none | Base-unit caps. `maxStorageDeposit` also caps a contract call's own `storageDepositLimit`. A call that sets it to `null` (no limit) is blocked whenever this cap is set. |
| `maxProofSize` | none | Caps proof size on runtimes with two-part weights. Transfers and mints are checked against the preflight estimate. A contract call is checked against its own `proofSize` limit, because the node's estimate mostly repeats it. So size this cap to cover the proof size in the gas limit you choose, not the contract's real usage: on the test chain a call with a 1,000,000 limit used about 5,400. Portaldot spec 1002 has one-part weights, so proof size is unknown there. |
| `maxSteps` | `10` | |
| `allowedModes` | `sequential`, `atomic_verified` | |
| `requireHumanApproval` | `true` | |
| `maxApprovalSeconds` | `600` | An approval lasts at most this long. |
| `requireSignedDryRun` | `true` | Each signed transaction must pass a dry run right before it's sent. |
| `allowUnknown` | none | Which unknowns may pass: `fee`, `weight`, `storageDeposit`, `dryRun`, `proofSize`. Everything else unknown is blocked. |

Policy checks and what they look at: `plan_integrity`, `manifest_match`, `signer_match`, `runtime_match`, `plan_available`, `step_available`, `mode_allowed`, `max_steps`, `capability`, `call_index`, `address_check`, `asset_allowed`, `recipient_allowed`, `contract_allowed`, `selector_allowed`, `amount_limit`, `native_value_limit`, `gas_limit`, `preflight`, `dry_run`, `weight_limit`, `fee_limit`, `storage_limit`. Each one reports pass, block or unknown, with a plain reason.

## Approval

An approval is a hash over the Manifest, the plan, the exact call bytes, the runtime fingerprint, the policy and its result, the signing envelope (signer, nonce, mortality, checkpoint block, expiry) and the preflight. Changing any of them invalidates the approval.

## Submit gate block reasons

These are checked at the last moment, before anything is sent.

| Code | Meaning |
|---|---|
| `approval_reused` | This approval, or this step of it, was already sent. |
| `approval_expired` | The approval is past its expiry. Approve again. |
| `approval_tampered` | The approval's contents don't match its hash. |
| `approval_mismatch` | Something about to be sent differs from what was approved. The message names the field. |
| `runtime_changed` | The chain's runtime changed after the plan was prepared. The message names what changed. |
| `signed_bytes_mismatch` | The wallet signed different call data from the approved plan. |
| `signed_dry_run_failed` | The signed transaction failed its dry run, so it would fail on chain. |
| `signed_dry_run_missing` | The policy needs a successful dry run and it's missing or unknown. |
| `out_of_order` | A sequential step was sent before the one before it. |
| `message_not_allowed` | The contract message isn't in the policy's `allowedMessages` for that contract, or the call is raw data with no message name. |
| `abi_hash_missing` | The policy pins an interface hash (`pinnedAbiHashes`) for this contract, but the call carries none. |
| `abi_hash_mismatch` | The call's interface hash differs from the one pinned for this contract. |
| `previous_steps_missing`, `previous_step_failed` | A sequential step can only go after every earlier step finalized and verified. |
| `send_index_invalid` | The step number is wrong for this plan. |

## Receipt

| Field | Meaning |
|---|---|
| `manifestDigest`, `planDigest`, `fingerprintDigest`, `policyDigest`, `approvalHash` | Trace the run back to exactly what was asked, compiled, checked and approved. |
| `mode` | The plan mode that ran. |
| `steps[]` | `actionId`, `status`, `txHash`, `block`, `events`, `verification`, `reason`. |
| `result` | `verified`, `partial` or `not_verified`. |
| `coverage` | `{ verified, expected }`: how many steps were confirmed on chain. |
| `receiptDigest` | Lets anyone detect edits (`seam verify`, integrity only: anyone can recompute it, so it is not proof of anything on chain). |

Step status: `finalized`, `included` (in a block, not final yet), `submitted`, `failed`, `not_run`.

Step verification:
- `assets.transfer` needs `Assets.Transferred(asset, signer, recipient, amount)` in a finalized block.
- `assets.mint` needs `Assets.Issued(asset, recipient, amount)` in a finalized block.
- `contracts.call` needs a `Contracts.ContractEmitted` event from that contract. A successful call with no event is `unknown`, because success alone doesn't show what the contract did.
- A success with a missing or different event is `not_verified`. SEAM never reports success it can't see.

Result: `verified` only when every step finalized and verified. `partial` when SEAM stopped early, and the first step not run says why. `not_verified` otherwise.

### Checks that passed

The gate result is `{ ok, reasons, passed }`. `passed` is a list of `{ code, detail }`, in the order the checks ran, so a UI or recording can show what was verified. A check that failed is never listed as passed. Codes:

| Code | Meaning |
|---|---|
| `step_order` | The step is next in the approved order. |
| `previous_steps_ok` | Sequential plans, step 2 onward: the earlier steps completed and verified. |
| `approval_unused` | This step of the approval hasn't been sent before. |
| `approval_valid_time` | The approval hasn't expired. |
| `approval_intact` | The approval's contents match its hash. |
| `approval_matches` | What is about to be sent is exactly what was approved (plan, policy, runtime, envelope, preflight). |
| `runtime_unchanged` | The chain runtime is the one the plan was prepared for. |
| `signed_bytes_match` | The signed calls are byte-for-byte the approved calls. |
| `signed_dry_run_ok` | The dry run of the signed transaction succeeded. |

`message_allowed`, `abi_pinned` and `selector_allowed` are **policy rules**. They appear in `policyResult.rules` (and `explainPolicy`), not in the gate's `passed` list. The gate's `passed` holds only the submit-time checks above.

`explainSubmitCheck` lists these in fixed plain words under "Checks that passed:", as `- wording (code: detail)`. Any code in `reasons` is never listed as passed. A code it doesn't know is shown as `code: detail`, unchanged. Code that compares the whole gate result with exact equality should compare fields (or use `toMatchObject`), because `passed` is a new field.

## Progress callback: `onStep`

`seam.execute({ ..., onStep })` calls `onStep(event)` as it goes. The event is `{ index, actionId, phase, detail?, check? }`. `phase` is `checking`, `sending`, `done` or `blocked`. `check` is the submit-gate result (`SubmitCheck`) for that step: `{ ok: true, reasons: [], passed }` on `sending` and `done`, and `{ ok: false, reasons, passed }` on `blocked`; `passed` lists the checks that passed (see above), with the same reasons as `detail`. There is no `check` on `checking`, because the gate hasn't run yet. An atomic plan is one step with `actionId: "batch"`. Old callbacks that ignore `check` keep working.

## CLI

| Command | What it does | Exit code |
|---|---|---|
| `seam digest <manifest>` | Checks the Manifest and prints its digest. | 0 valid, 2 invalid |
| `seam compile <manifest>` | Compiles against a runtime and explains the plan. | 0 ok, 2 can't compile, 3 unavailable |
| `seam check <manifest> --policy <file>` | Checks the policy file, compiles, then runs every policy rule that doesn't need a node. | 0 passed, 2 bad policy file, 4 blocked |
| `seam verify <receipt>` | Offline: **integrity only, not on-chain proof** (status `integrity_checked`), then explains the receipt. | 0 integrity_checked, 5 edited |
| `seam verify --endpoint <ws> [--plan <plan.json>] <receipt>` | Live: re-reads the chain. Status `chain_verified`, `unknown` or `failed`. | 0 chain_verified, 5 failed, 6 unknown |
| `seam explain <file>` | Explains a plan, policy result or receipt in plain English. | 0 |
| `seam snapshot <ws-endpoint> <out-dir>` | Saves a node's runtime, read-only, for offline use. | 0 |

**Which runtime.** By default the commands use the bundled Portaldot mainnet snapshot (spec 1002). To use another:
- `--snapshot <dir or file>` uses a saved snapshot, for example the test chain's or, once it's public, the V3 testnet's. Add `--name` if the folder holds several.
- `--endpoint <ws-url>` reads the live runtime from a node, read-only.

**Token.** Some chains don't report their token in `system_properties`. Pass `--token SYMBOL:DECIMALS`, for example `--token UNIT:12`, with `--snapshot` or `--endpoint`. SEAM never guesses: if the node does report a token and it differs, the command stops. A bad format is a usage error (exit 1). In code, the same value is `declaredToken: { tokenSymbol, tokenDecimals }`.

**ABIs.** `--abi NAME=<file>` (repeatable) loads an ink! `metadata.json` so Manifests with `"abiRef": "NAME"` compile.

The same Manifest compiles against each runtime using that runtime's own call indexes. Anything a runtime lacks comes out as unavailable with a reason.

Every command takes `--json` for raw output. Exit code 1 means a usage error.
