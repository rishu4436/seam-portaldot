# @seam/sdk: install, quickstart, API, runtimes, limitations

Status: **pre-release, not published.** Every package keeps `"private": true`. Version `0.1.0`, license Apache-2.0
(`LICENSE` at the repo root and in `packages/sdk/LICENSE`). Requires Node.js 20 or newer (`engines.node: ">=20"`).

## Install

Nothing is on npm. Use one of these:

- **Workspace (inside this repo):** `npm ci && npm run build`. `@seam/sdk`, `@seam/compiler` and `@seam/policy` then
  resolve through the npm workspace.
- **Local tarballs (outside app):**

  ```sh
  npm run build
  for p in compiler policy sdk; do npm pack -w "@seam/$p" --pack-destination /tmp/seam-tgz; done
  cd my-app && npm install /tmp/seam-tgz/seam-compiler-0.1.0.tgz /tmp/seam-tgz/seam-policy-0.1.0.tgz /tmp/seam-tgz/seam-sdk-0.1.0.tgz
  ```

  `npm run smoke:pack` does exactly this in a temporary directory and runs the consumer example against the tarballs.

Package entry points (all ESM, types in `dist/*.d.ts`): `@seam/sdk` (node), `@seam/sdk/browser` (no node builtins),
`@seam/sdk/package.json`, and the `seam` CLI (`dist/cli.js`).

## Quickstart

[`examples/consumer/index.mjs`](../examples/consumer/index.mjs) runs fully offline (no node, keys or network):

```sh
npm run build && npm run example:consumer
```

It compiles a one-step transfer against the bundled mainnet snapshot, runs the policy (blocked, honestly, because no
preflight was given), builds an empty receipt (`partial`, never a success), then uses `@seam/sdk/browser` to check the
integrity of a recorded V3 receipt (copied from `evidence/testnet-v3/receipts-v2/plan-atomic-1792411355057.json`) and
shows that an edited copy fails. Integrity is not on-chain proof; use `seam verify --endpoint` for that.

```js
import {
  action,
  defineManifest,
  factsFromSnapshot,
  bundledSnapshotDir,
  explainPlan,
} from "@seam/sdk";
import { compile } from "@seam/compiler";
const facts = factsFromSnapshot(bundledSnapshotDir());
const manifest = defineManifest({
  signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
  actions: [action.transfer("pay", { assetId: "1", amount: "2500", recipient: BOB })],
});
console.log(explainPlan(compile(manifest, facts)));
```

`packages/sdk/tests/release-readiness.test.ts` runs the example and fails if its output changes meaning.
See [`packages/sdk/README.md`](../packages/sdk/README.md) for the flow, receipts and CLI.

## Supported runtimes

| target                                   | status                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                                  | 20+ (`engines`). CI runs Node 22; tested locally on 20.19.                                                                                                                    |
| Browser bundle                           | `@seam/sdk/browser` only (receipt verifiers). Bundled by esbuild `platform: "browser"` in `tests/browser-entry.test.ts`. `flow.ts`, the file store and the CLI are node only. |
| Portaldot V3 testnet, spec 3002          | Read-only verification against live V3 (`seam verify --endpoint`). Live runs only as recorded in [`evidence/testnet-v3`](../evidence/testnet-v3/README.md).                   |
| Portaldot mainnet, spec 1002             | Offline snapshot for compile and policy only. No live mainnet runs. V3-only checks fail closed (`unknown`/`unsupported_runtime`).                                             |
| Local devnode / substrate-contracts-node | Evidenced under `evidence/devnode` and `evidence/portaldot-local-node`. `npm run test:e2e` is manual/weekly, not routine CI.                                                  |

## Security limitations

- **Plan-bytes binding is CLOSED** (Forge's `verifyPlan`, `1021d28`, plus Sentinel's gate, `50d2911`). Given a
  Manifest and live facts, `createApproval` and `checkBeforeSubmit` recompile the Manifest on the live runtime and block
  on any byte difference in a step, the atomic outer call or the signed calls (`plan_bytes_mismatch`). Facts carried
  inside a plan are never used. Remaining limits:
  - The pre-sign `verifyPlan` check is in progress (Forge's fresh compiled fixture, then Sentinel's pre-sign gate).
  - In non-live mode without `manifest` and `liveFacts` (e.g. replaying a recorded JSON run), call bytes are not checked
    against a Manifest.
  - The console must pass `live: true` on every real submit.
  - In the SDK flow, `manifest`, `liveFacts` and `live` are optional. Callers that omit them get no byte binding.
- **Mortality and nonce checks run only when passed.** The submit gate checks them only if the caller gives
  `currentBlockNumber` and `currentAccountNonce`.
- **Strict policy mode is opt-in** (`requireEvaluatedPolicyResult: true`). By default a recorded policy result is accepted
  if it is self-consistent.
- **Receipt integrity is not proof.** `checkReceipt`/`receiptIntegrity` only detect edits. Only a live re-read proves a
  transaction exists.
- **No audit. Not production-ready. No mainnet support. No cross-VM atomicity.** Atomic mode covers `Utility.batch_all`
  within one runtime only.
- The approval store is in memory only. SEAM never holds keys; the user's wallet signs.

## Plan-bytes inputs in the SDK flow

`Seam.approve` and `Seam.execute` take optional inputs that turn on plan-bytes binding:

| method    | input                                                | effect                                                                                                                                                 |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `approve` | `manifest?: Manifest`                                | `createApproval` recompiles it with `verifyPlan` and refuses unless every call byte matches.                                                           |
| `approve` | `liveFacts?: RuntimeFacts`                           | Facts to recompile on. Default: the `facts` you pass (never facts carried in the plan).                                                                |
| `approve` | `requirePlanVerified?: true`                         | Refuse unless `manifest` is given and the bytes verify. Use for live flows.                                                                            |
| `execute` | `manifest?`, `liveFacts?`                            | Every submit check recompiles and blocks with `plan_bytes_mismatch`; `liveFacts` must be the runtime the lock reads, else `live_facts_mismatch`.       |
| `execute` | `live?: { currentBlockNumber, currentAccountNonce }` | Live mode: the Manifest, live facts, signed calls, block and nonce are all required (each missing one blocks). Both are read fresh before every check. |

## API reference

Generated from the built package. `node scripts/sdk-api-doc.mjs` rewrites it, and the release-readiness test fails if
it differs from the real exports. Only runtime values are listed; type exports are in `dist/*.d.ts`.

<!-- api:start (generated by scripts/sdk-api-doc.mjs, do not edit) -->

### `@seam/sdk` (67 runtime exports)

| export                                  | kind     |
| --------------------------------------- | -------- |
| `ACTION_KINDS`                          | object   |
| `ApprovalStoreError`                    | function |
| `CONSOLE_RECEIPT_KIND_PREFIX`           | string   |
| `EXIT`                                  | object   |
| `FileApprovalStore`                     | function |
| `GATE_CODES`                            | object   |
| `INTEGRITY_ONLY_NOTE`                   | string   |
| `NEXT_ACTION`                           | object   |
| `NOT_VERIFIED_ON_V3`                    | string   |
| `REASON_CODE_WORDING`                   | object   |
| `RUN_RECORD_RECEIPT_FIELDS`             | object   |
| `SYNTHETIC_NFTS_SHAPE`                  | object   |
| `SYNTHETIC_REVIVE_SHAPE`                | object   |
| `Seam`                                  | function |
| `SeamCode`                              | object   |
| `V3_SPEC3002_MAP_ACCOUNT_EVENTS`        | object   |
| `V3_SPEC3002_NFTS_SHAPE`                | object   |
| `V3_SPEC3002_REVIVE_INSTANTIATED_SHAPE` | object   |
| `action`                                | object   |
| `buildReceipt`                          | function |
| `bundledSnapshotDir`                    | function |
| `checkReceipt`                          | function |
| `classifyError`                         | function |
| `classifyReceipt`                       | function |
| `consoleSteps`                          | function |
| `createChainReader`                     | function |
| `decodeV3InstantiateWithCode`           | function |
| `decodeV3ReviveCall`                    | function |
| `defineManifest`                        | function |
| `diffRuntimes`                          | function |
| `expectedEvent`                         | function |
| `explainConsoleVerification`            | function |
| `explainDrift`                          | function |
| `explainManifestIssues`                 | function |
| `explainPlan`                           | function |
| `explainPolicy`                         | function |
| `explainReasonCode`                     | function |
| `explainReceipt`                        | function |
| `explainSubmitCheck`                    | function |
| `factsFromSnapshot`                     | function |
| `instantiateCodeHash`                   | function |
| `isConsoleReceipt`                      | function |
| `isObservedV3`                          | function |
| `locateSnapshot`                        | function |
| `manifestDigest`                        | function |
| `nftsShapeFor`                          | function |
| `outcome`                               | function |
| `parseAbiFlags`                         | function |
| `parseManifest`                         | function |
| `parseRuntimeFlag`                      | function |
| `parseTokenFlag`                        | function |
| `perStepOfBatch`                        | function |
| `pickReceipt`                           | function |
| `receiptDigest`                         | function |
| `receiptIntegrity`                      | function |
| `receiptShapeProblem`                   | function |
| `reviveAddressOf`                       | function |
| `toBaseUnits`                           | function |
| `verifyConsoleReceiptLive`              | function |
| `verifyConsoleReceiptOffline`           | function |
| `verifyMapAccountOutcome`               | function |
| `verifyNftsMintOutcome`                 | function |
| `verifyReceiptLive`                     | function |
| `verifyReviveCallOutcome`               | function |
| `verifyReviveCallV3Outcome`             | function |
| `verifyReviveInstantiateOutcome`        | function |
| `verifyStep`                            | function |

### `@seam/sdk/browser` (26 runtime exports, each `===` the same export of `@seam/sdk`)

| export                                  | kind     |
| --------------------------------------- | -------- |
| `INTEGRITY_ONLY_NOTE`                   | string   |
| `NOT_VERIFIED_ON_V3`                    | string   |
| `SYNTHETIC_NFTS_SHAPE`                  | object   |
| `SYNTHETIC_REVIVE_SHAPE`                | object   |
| `V3_SPEC3002_MAP_ACCOUNT_EVENTS`        | object   |
| `V3_SPEC3002_NFTS_SHAPE`                | object   |
| `V3_SPEC3002_REVIVE_INSTANTIATED_SHAPE` | object   |
| `buildReceipt`                          | function |
| `checkReceipt`                          | function |
| `decodeV3InstantiateWithCode`           | function |
| `decodeV3ReviveCall`                    | function |
| `expectedEvent`                         | function |
| `instantiateCodeHash`                   | function |
| `isObservedV3`                          | function |
| `nftsShapeFor`                          | function |
| `perStepOfBatch`                        | function |
| `receiptDigest`                         | function |
| `receiptIntegrity`                      | function |
| `receiptShapeProblem`                   | function |
| `reviveAddressOf`                       | function |
| `verifyMapAccountOutcome`               | function |
| `verifyNftsMintOutcome`                 | function |
| `verifyReviveCallOutcome`               | function |
| `verifyReviveCallV3Outcome`             | function |
| `verifyReviveInstantiateOutcome`        | function |
| `verifyStep`                            | function |

<!-- api:end -->
