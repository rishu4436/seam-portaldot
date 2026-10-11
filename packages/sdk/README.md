# @seam/sdk

The developer-facing part of SEAM: Manifest helpers, execution receipts, plain-English explanations, the end-to-end flow, and the `seam` CLI. Built on `@seam/compiler` and `@seam/policy`. The chain side plugs in through `ChainAdapter`, which `@seam/chain` implements.

## Manifest
- `parseManifest(jsonOrObject)` checks the shape and returns `{ ok, manifest, digest }` or a list of `{ path, message }` issues.
- `defineManifest({ signer, actions })` plus `action.transfer`, `action.mint` and `action.contractCall` build one in code.
- Amounts are always base-unit strings. `toBaseUnits('2.5', 14)` converts without floating point.
- The digest is blake2b-256 of `seam/manifest/v1`, a 0x00 byte, then canonical JSON, matching the compiler.

## Receipt
`buildReceipt({ plan, outcomes, policyDigest, approvalHash })` checks each step's events against the plan:
- `assets.transfer` needs `Assets.Transferred(asset, signer, recipient, amount)`, and `assets.mint` needs `Assets.Issued(asset, recipient, amount)`. Both must be finalized.
- `contracts.call` needs a `Contracts.ContractEmitted` event from that contract. Success alone is reported as unknown.
- A failed step makes the rest `not_run` and the result `partial`. A success with the wrong or missing event is `not_verified`.
- `checkReceipt(r)` recomputes `receiptDigest` (`seam/receipt/v1`) to detect edits.

## Flow
`new Seam(chainAdapter)` covers `prepare` (compile, preflight and policy), `approve`, and `execute`. `execute` signs through the user's `WalletSigner`, dry-runs the signed transactions through the adapter, runs the policy submit gate (approval reuse or expiry, runtime change, signed bytes, signed dry run), submits, stops at the first failed or unverified step, and returns a receipt. SEAM never holds keys.

## CLI
```
seam digest  manifest.json
seam compile manifest.json [--json]
seam check   manifest.json --policy policy.json
seam verify  receipt.json
seam explain plan.json | policy-result.json | receipt.json
```
Offline commands use the bundled Portaldot mainnet snapshot (spec 1002, block 2,721,455), or `--snapshot <dir>`.

## Tests
`npm test` runs 22 offline tests against the real snapshot metadata. They cover Manifest validation, receipt verification (attack cases 9 and 11), explanations, and the full flow with a fake chain and wallet (approval reuse, runtime change, a tampered signature, a failed or unknown signed dry run, stopping after a failure).
