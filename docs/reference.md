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


## Outcome verdicts: `execute({ verdicts })`

`seam.execute({ ..., verdicts })` takes an optional `Record<actionId, OutcomeVerdict>` (from `verifyReviveCallOutcome` / `verifyNftsMintOutcome`, computed by the caller from the events it observed). `execute` passes it to every receipt it builds, the same way as `effects`, including the per-step receipts that decide whether the next step may run. It never computes a verdict itself. A verdict wins over the receipt's default check. Without `verdicts`, `nfts.mint` and `revive.call` steps get the receipt's default checks (below). `execute` today builds receipts without `runtime` (and its outcomes carry no `callHex`), so an `nfts.mint` step it returns is capped at `contract_emitted` (`v3_shape_unobserved`) and a `revive.call` step stays `unsupported_runtime` until `execute` passes the runtime fingerprint and the call bytes. A verdict is `effect_proven` only under the verifier's own rules (observed event shape).

## CLI

| Command | What it does | Exit code |
|---|---|---|
| `seam digest <manifest>` | Checks the Manifest and prints its digest. | 0 valid, 2 invalid |
| `seam compile <manifest>` | Compiles against a runtime and explains the plan. | 0 ok, 2 can't compile, 3 unavailable |
| `seam check <manifest> --policy <file>` | Checks the policy file, compiles, then runs every policy rule that doesn't need a node. | 0 passed, 2 bad policy file, 4 blocked |
| `seam verify <receipt>` | Offline: **integrity only, not on-chain proof** (status `integrity_checked`), then explains the receipt. | 0 integrity_checked and the run was verified; 5 edited; 6 run was `uncertain`; 7 run was partial or not verified; 8 a tx failed |
| `seam verify --endpoint <ws> [--plan <plan.json>] [--runtime <run.json>] <receipt or run record>` | Live: re-reads the chain. `--runtime` pins the runtime the plan ran on (see below). Status `chain_verified`, `unknown` or `failed`. `chain_verified` needs the plan (without `--plan` the status is `unknown`), the on-chain call bytes equal to the planned call (for an atomic plan, the planned `Utility.batch_all` call), every planned step present and finalized, and each step re-derived as `verified` with coverage `effect_proven`. For an atomic plan the on-chain batch call must equal the planned batch call, and each step is re-checked against its own slice of it (`perStepOfBatch`); if the batch is not exactly the planned steps, no step gets call bytes and the run is `failed`. A step whose receipt says `not_verified`, or whose re-check gives `not_verified`, is `failed` with a problem listed, never `unknown`. The inner calls are decoded: `perStepOfBatch` splits the batch into each step's own call bytes, and a `revive.call` step on spec 3002 has its call bytes decoded with `decodeV3ReviveCall` and compared field by field with the plan. | 5 chain contradicts the receipt, 6 `unknown` (also: no plan, uncomparable input, effect not proven); if the chain matches, the exit code is the run's own outcome (0 only if verified) |
| `seam drift <snapA> <snapB> [--plan <plan.json>]` | Compares two saved runtimes: changed fingerprint fields and calls; says if a plan is stale for B. Offline. | 0 no drift, 10 `runtime_drift` |
| `seam explain <file>` | Explains a plan, policy result or receipt in plain English. | 0 |
| `seam snapshot <ws-endpoint> <out-dir>` | Saves a node's runtime, read-only, for offline use. | 0 |

**Exit codes and `code`.** Every failure and every non-fully-verified outcome has a stable `code` (see `SeamCode` in `packages/sdk/src/codes.ts`; `--json` output includes it) and a nonzero exit code: 1 usage/internal, 2 invalid input or compile failure, 3 plan unavailable / unsupported runtime, 4 blocked by policy, approval or the submit gate, 5 integrity or chain verification failed, 6 unknown or `uncertain` (a broadcast that may or may not have happened: never retry, look it up on chain), 7 partial or not verified, 8 transaction failed on chain, 9 node unreachable, 10 runtime drift found between two snapshots. There is no `success` boolean: a partial, uncertain or unproven run is never reported as success. A policy that passes with fee, weight or dry-run unknown is allowed only as **weaker proof**, and says so.

**Which runtime.** By default the commands use the bundled Portaldot mainnet snapshot (spec 1002). To use another:
- `--snapshot <dir or file>` uses a saved snapshot, for example the test chain's or a V3 testnet snapshot. Add `--name` if the folder holds several.
- `--endpoint <ws-url>` reads the live runtime from a node, read-only.

**Token.** Some chains don't report their token in `system_properties`. Pass `--token SYMBOL:DECIMALS`, for example `--token UNIT:12`, with `--snapshot` or `--endpoint`. SEAM never guesses: if the node does report a token and it differs, the command stops. A bad format is a usage error (exit 1). In code, the same value is `declaredToken: { tokenSymbol, tokenDecimals }`.

**ABIs.** `--abi NAME=<file>` (repeatable) loads an ink! `metadata.json` so Manifests with `"abiRef": "NAME"` compile.

The same Manifest compiles against each runtime using that runtime's own call indexes. Anything a runtime lacks comes out as unavailable with a reason.

Every command takes `--json` for raw output. Exit code 1 means a usage error.

## Outcome verifiers for `revive.call` and `nfts.mint`

The compiler encodes these two actions only when the target runtime's metadata really has the call with the expected argument shape; otherwise the step is unavailable with `NO_OBSERVED_V3_METADATA` or `V3_ARG_SHAPE_MISMATCH` (the bundled mainnet snapshot, spec 1002, has neither). On the hosted Portaldot V3 testnet (`portaldot-v3` spec 3002), both were compiled, sent and finalized as SEAM plan steps (`revive.call` against a 13-byte EVM test contract) ([evidence](../evidence/testnet-v3/README.md)). The verifiers fail closed:

- `verifyNftsMintOutcome({ status, events, shape, observedShape?, ss58Prefix? }, { collection, item, mintTo })` and
  `verifyReviveCallOutcome({ status, events, shape, observedShape? }, { dest, value, data })` return an `OutcomeVerdict`
  (`verification`, `coverage`, `reason`, `code?`, `matchedEvent?`). Pass it to `buildReceipt({ plan, outcomes, verdicts: { [actionId]: verdict } })`.
- `effect_proven` / `verified` only when the step is finalized and succeeded, an event of the given `shape` carries exactly the expected arguments, **and** you set `observedShape: true` because that shape was read from real runtime metadata. Otherwise the result is capped at `contract_emitted` and says "not verified on V3".
- A failed dispatch is `failed` (`not_verified`, code `tx_failed`). A matching event name with different collection, item, owner, destination, value or data is `not_verified` (`effect_mismatch`). No events: `extrinsic_finalized`, unknown. Not finalized: `call_dispatched`, unknown.
- The receipt re-checks a `verified` verdict against the step's own events (`matchedEvent`) and downgrades it if they do not back it.
- **Default for `nfts.mint`.** With no verdict, `buildReceipt` (and `verifyStep`) run `verifyNftsMintOutcome` themselves on the step's own events, against the planned `collection`, `item` and `recipientAccountId`, with `V3_SPEC3002_NFTS_SHAPE` = `Nfts.Issued(collection, item, owner)`. That shape counts as observed only when you pass `buildReceipt({ ..., runtime })` (a `RuntimeFingerprint` fits) with `specName: "portaldot-v3"` and `specVersion: 3002`: it was read from that runtime's metadata and decoded from real finalized mints (tx `0x9ea5ff6b…8f75` #102327, `0x5adae6e9…44da` #102657, `0x6be1232e…f355` #102671; `evidence/testnet-v3/runs/nfts-mint-1792409706466.json`, `plan-sequential-1792411270138.json`, `plan-atomic-1792411355057.json`). With no `runtime`, or any other runtime, a match is capped at `contract_emitted` (`v3_shape_unobserved`, "not verified on V3"). `nftsShapeFor(runtime)` returns the shape and whether it is observed. An SS58 owner in an event is compared as its AccountId when `ss58Prefix` is known.
- **`revive.call` on V3: `verifyReviveCallV3Outcome`, and the default.** V3 spec 3002 has no Revive event carrying a call's (dest, data, value): its Revive events are `ContractEmitted(contract, data, topics)`, `Instantiated` and `EthExtrinsicRevert`, and `ContractEmitted.data` is the contract's log data, not the call data. So `verifyReviveCallOutcome` cannot match a real V3 call. `verifyReviveCallV3Outcome({ status, events, callHex, runtime }, expectation)` instead requires all of:
  - the extrinsic's own call bytes (`callHex`, decoded by `decodeV3ReviveCall` with the observed layout `dest H160, value, weight_limit{ref_time, proof_size}, storage_deposit_limit, data`, all compact except dest and data) equal the plan's pallet/call index, `contract`, `value`, `gasLimit`, `proofSize`, `storageDepositLimit` and `data`;
  - `System.ExtrinsicSuccess` for that extrinsic (an `ExtrinsicFailed` or `Revive.EthExtrinsicRevert` is `tx_failed`);
  - when the caller expects an event (`effects[actionId].emittedData`, optional `emittedTopics`), a `Revive.ContractEmitted` from `dest` with exactly that data and topics.

  Its result carries `basis`. With no expected event it is `unknown` / `extrinsic_finalized` / `effect_unproven`, `basis: "call_args_and_success"`: it shows the planned call ran without reverting, not what the contract did, so it is never `effect_proven`. With a matching expected event it is `verified` / `effect_proven`, `basis: "call_args_success_and_emitted"`, which is only as strong as the event the caller chose to expect. A call-byte difference, an expected event that is missing from the finalized extrinsic's (complete) events, or one from another contract or with other data/topics is `not_verified` / `effect_mismatch`. Missing or undecodable call bytes, or a plan step without every argument, is `unknown`. On any runtime other than `portaldot-v3` spec 3002 there is no default and the step stays `unsupported_runtime`. `effect.stateReadback` is not used for `revive.call`. Tests replay the real records `plan-revive-call-1792412445848.json` (tx `0xec917338…7482`, #102853) and `plan-revive-terminate-1792412498767.json` (tx `0xc0ad1497…338f`, #102862), with the signed call bytes from `signingRequests[0].payload.method`.

- `verifyReceiptLive(receipt, reader, { plan?, effects?, runtime? })` re-derives each step with `verifyStep`, passing the on-chain call bytes and, when given, `runtime` (the `RuntimeFingerprint` the plan ran on), so it agrees with `Seam.execute`. `runtime` is used only if its digest equals the receipt's `fingerprintDigest` (otherwise `failed`, "fingerprint digest differs") **and** the reader's live `runtimeFingerprint()` has the same genesis hash, spec name, spec version, transaction version and ss58 prefix (otherwise `failed`); only the metadata hash may differ, which is listed as a note. If the node's runtime cannot be read, the pinned runtime is not used. Without `runtime`, `nfts.mint` and `revive.call` checks stay capped, and a step whose receipt says more than the capped re-check is `unknown`, never `chain_verified`. Atomic steps re-check against their own `perStepOfBatch` slice of the batch call. A receipt step that says `not_verified`, or a re-check that gives `not_verified` (for example wrong expected event data), is `failed` with a problem listed.
- From the CLI, pass the runtime with `--runtime <file>`: a recorded run (its `fingerprint` is used) or a bare `RuntimeFingerprint` JSON. A file that is neither is a usage error (exit 1), reported before any node is contacted. The receipt argument may also be a run record (see `seam verify` above). Real output: [demo script, segment 6](demo-script.md#6-replay-execute-and-live-verification-agree-040).
- `SYNTHETIC_NFTS_SHAPE` and `SYNTHETIC_REVIVE_SHAPE` are made-up shapes for tests. They are not V3 event layouts. `V3_SPEC3002_NFTS_SHAPE` is the only observed one.

Fixed wording for step reason codes is in `REASON_CODE_WORDING` and `explainReasonCode(code: string): string | undefined` (`NO_OBSERVED_V3_METADATA`, `V3_ARG_SHAPE_MISMATCH`, `ATOMIC_REQUIRED_UNAVAILABLE`); a code it does not know returns `undefined`, never invented wording. `V3_ARG_SHAPE_MISMATCH` reads: the target chain's call has different arguments than SEAM expected, so SEAM refused to build it rather than guess.
