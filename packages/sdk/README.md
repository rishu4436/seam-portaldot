# @seam/sdk

The developer-facing part of SEAM: Manifest helpers, execution receipts, plain-English explanations, the end-to-end flow, and the `seam` CLI. Built on `@seam/compiler` and `@seam/policy`. The chain side plugs in through `ChainAdapter`, which `@seam/chain` implements.

Install, quickstart, the generated API reference, the supported-runtimes matrix and the security limitations are in [`docs/sdk.md`](../../docs/sdk.md). Not published: every package stays `private: true`.

## Manifest

- `parseManifest(jsonOrObject)` checks the shape and returns `{ ok, manifest, digest }` or a list of `{ path, message }` issues.
- `defineManifest({ signer, actions })` plus `action.transfer`, `action.mint` and `action.contractCall` build one in code.
- Amounts are always base-unit strings. `toBaseUnits('2.5', 14)` converts without floating point.
- The digest is blake2b-256 of `seam/manifest/v1`, a 0x00 byte, then canonical JSON, matching the compiler.

## Receipt

`buildReceipt({ plan, outcomes, policyDigest, approvalHash })` checks each step's events against the plan:

- `assets.transfer` needs `Assets.Transferred(asset, signer, recipient, amount)`, and `assets.mint` needs `Assets.Issued(asset, recipient, amount)`. Both must be finalized.
- `contracts.call` needs a `Contracts.ContractEmitted` event from that contract. Success alone is reported as unknown.
- `nfts.mint` is checked by default against `Nfts.Issued(collection, item, owner)` with the planned collection, item and recipient. It can be `verified` only when you pass `runtime` (a `RuntimeFingerprint` fits) for `portaldot-v3` spec 3002, the one runtime where that event shape was observed ([`evidence/testnet-v3`](../../evidence/testnet-v3/README.md)). Without `runtime`, or on any other runtime, a match is capped at `contract_emitted` ("not verified on V3"). An explicit `verdicts` entry wins over the default.
- `revive.call` on `portaldot-v3` spec 3002 is checked by default with `verifyReviveCallV3Outcome`: the outcome's `callHex` (the extrinsic's call bytes) must decode to exactly the planned dest, value, weight, deposit limit and data, and the call must succeed. That alone is `unknown` with `basis: "call_args_and_success"` (V3 has no per-call event); it is `verified` only if `effects[actionId].emittedData` (and optional `emittedTopics`) is given and a matching `Revive.ContractEmitted` from `dest` is in the step's events. Without `callHex` it is `unknown`; on other runtimes it stays `unsupported_runtime`.
- A failed step makes the rest `not_run` and the result `partial`. A success with the wrong or missing event is `not_verified`.
- `checkReceipt(r)` recomputes `receiptDigest` (`seam/receipt/v1`) to detect edits.

## Status on Portaldot V3

One funded run on the hosted V3 testnet (spec 3002, ss58 42, `tPOT`, 14 decimals) verified the SEAM signing path, dry runs and fees, Assets, `Nfts.create`/`mint`, sequential and `atomic_verified` plans with `assets.*` and `nfts.mint`, and `Utility.batch_all` rollback for those calls. A 13-byte EVM contract was deployed and called through a SEAM `revive.call` plan (it ran and emitted `Revive.ContractEmitted`). Not verified on V3: a per-call Revive event (there is none), a fresh account mapping, ink!/PolkaVM, cross-VM atomicity, and browser-extension signing. Details and tx hashes: [README](../../README.md#portaldot-v3-testnet-spec-3002-what-is-and-isnt-verified), [`evidence/testnet-v3`](../../evidence/testnet-v3/README.md).

## Flow

`new Seam(chainAdapter)` covers `prepare(manifest, facts, policy, compileOptions?)` (compile, preflight and policy), `approve`, and `execute`. SEAM never holds keys: the user's `WalletSigner` signs.

- **Atomic plans** are one `batch_all` transaction. SEAM dry-runs it, runs the submit gate once, then sends it.
- **Sequential plans** are sent one step at a time. Before each step, SEAM re-reads the runtime fingerprint, dry-runs that step's signed transaction (later steps can't be dry-run yet because their nonce is in the future), and runs the gate for that step with `sendIndex` and the earlier receipt steps. The step goes out only after the previous one finalized and verified.
- A run stops at the first step that is blocked, fails, or doesn't verify. The receipt is then `partial`, the first step not run says why, and the result carries `stoppedReason`.
- `onStep` reports `checking`, `sending`, `done` or `blocked` for each step, for progress screens.

## CLI

```
seam digest  manifest.json
seam compile manifest.json [--json]
seam check   manifest.json --policy policy.json
seam verify  receipt.json                       # offline: integrity only, not on-chain proof
seam verify  --endpoint <ws> --plan plan.json receipt.json   # live chain re-read; without --plan the result is unknown;
                                                             # a not_verified step is failed, not unknown
seam verify  --endpoint <ws> --plan plan.json --runtime run.json receipt.json   # pin the plan's runtime (run record or fingerprint JSON)
seam verify  run.json --endpoint <ws> --runtime run.json   # a run record works as the receipt too (uses its receipt and plan)
seam explain plan.json | policy-result.json | receipt.json
```

Offline commands use the bundled Portaldot mainnet snapshot (spec 1002, block 2,721,455) by default. `--snapshot <dir|file> [--name n]` picks any snapshot saved by `seam snapshot` or `@seam/chain`'s `snapshotFromNode`, and `--endpoint <ws-url>` reads a live node. `seam check` validates the policy file with `parsePolicy` first.

## Browser receipt verifiers (`@seam/sdk/browser`)

`import { verifyStep, ... } from "@seam/sdk/browser"` gives the console the same receipt checks the CLI uses, with no node builtins (tests/browser-entry.test.ts bundles it with esbuild `platform: "browser"` and checks every export is `===` the node export). It re-exports `receipt.ts`, `outcomes.ts` and `deploy-outcomes.ts` and `batch-steps.ts`; nothing is copied. `perStepOfBatch(plan, outcomes, signedBatchCall)` (moved from `flow.ts`, which re-exports it) splits an atomic plan's one `batch` outcome into per-step outcomes. A step gets its call bytes only when the batch call is exactly the planned `batch_all` of the plan's calls, so `buildReceipt` can check an atomic receipt in the browser.

`verifyStep(step, signerAccountId, outcome, effect?, verdict?, runtime?)` is the one dispatcher. Pass `runtime` (the V3 fingerprint) and `outcome.callHex` (the signed call bytes), or the V3 checks stay `unknown`:

| kind                             | verified when                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `assets.transfer`, `assets.mint` | the exact `Assets.Transferred` / `Assets.Issued` is in a finalized block                                                 |
| `nfts.mint`                      | spec 3002, `Nfts.Issued` matches the planned collection, item and owner                                                  |
| `revive.call`                    | spec 3002, call bytes match, and `effect.emittedData` / `emittedTopics` match. With no expected event it stays `unknown` |
| `revive.instantiate_with_code`   | spec 3002, call bytes match and `Revive.Instantiated` from the signer's H160                                             |
| `revive.map_account`             | only with `effect.originalAccount` (a `Revive.OriginalAccount` read). Events alone stay `unknown`                        |
| `contracts.call`                 | exact `Contracts.ContractEmitted` data or a state read-back                                                              |

`perStepOfBatch` (atomic receipts) lives in `flow.ts`, which uses the file store, so it is not in the browser entry.

## Tests

`npm test` runs offline tests against the real snapshot metadata. They cover Manifest validation, receipt verification (attack cases 9 and 11), explanations, and the full flow with a fake chain and wallet (approval reuse, runtime change, a tampered signature, a failed or unknown signed dry run, stopping after a failure).
