# Action templates (P1-04): examples

Seven parameterised Manifests from `@seam/compiler` (`packages/compiler/src/templates.ts`, also in
`@seam/compiler/browser`): `listTemplates()`, `instantiateTemplate(id, params, facts?, options?)`,
`templateSkeleton(id)` and `PLACEHOLDER`. A template has **no default addresses**: every account, asset and amount is a
required parameter, and a missing, empty or `{{placeholder}}` value is rejected. `instantiateTemplate` goes through
`serializeManifest` → `parseManifest` (and the full compile check when facts are given), so a template never skips the
normal import path.

Each template has a runnable **offline** example in [`examples/templates/`](../examples/templates). Every example:

1. rejects an unfilled `PLACEHOLDER` (shows the code),
2. fills the template with labelled **dev/test accounts** (the public Substrate `//Alice`, `//Bob`, `//Charlie`,
   `//Dave` keys, a made-up H160 contract, test asset `806707`),
3. compiles against the **committed V3 spec 3002 metadata** (`evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex`),
4. runs the pre-sign gate (`gatePolicy` with `manifest`, `liveFacts` and `requirePlanVerified: true`) under a
   deny-by-default policy that allows only that action, then `verifyPlan(manifest, plan, liveFacts)` and
   `createApproval(... requirePlanVerified: true)`,
5. prints the plan digest and a plain summary,
6. shows one policy block and one edited plan (calls from another Manifest spliced in, digest recomputed), with the
   exact codes returned.

Nothing signs, submits or touches the network. The preflight and signing envelope are synthetic example data.

## Run

```bash
npm run build                                   # once
npm run examples:templates                      # all seven, human-readable
node examples/templates/index.mjs --json        # all seven, one JSON array (used by the test)
node examples/templates/asset-transfer.mjs      # one template
```

`packages/sdk/tests/template-examples.test.ts` runs the JSON form and checks every result below.

## The templates

| Template               | Kind (call)                                    | Required parameters                                                          | Requested mode → compiled mode      | Example file                                  | Policy block shown                             |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| `asset-transfer`       | `assets.transfer` (Assets.transfer_keep_alive) | signer, recipient, assetId, amount                                           | single → `sequential` (1 step)      | `examples/templates/asset-transfer.mjs`       | Dave not allow-listed: `RECIPIENT_NOT_ALLOWED` |
| `nft-mint`             | `nfts.mint` (Nfts.mint)                        | signer, recipient, collection, item                                          | single → `sequential` (1 step)      | `examples/templates/nft-mint.mjs`             | Dave not allow-listed: `RECIPIENT_NOT_ALLOWED` |
| `asset-mint`           | `assets.mint` (Assets.mint)                    | signer, recipient, assetId, amount                                           | single → `sequential` (1 step)      | `examples/templates/asset-mint.mjs`           | 1001 over the 1000 cap: `AMOUNT_OVER_LIMIT`    |
| `sequential-transfers` | 2 × `assets.transfer`                          | signer, assetId, recipient1, amount1, recipient2, amount2                    | sequential → `sequential` (2 steps) | `examples/templates/sequential-transfers.mjs` | step-2 recipient Dave: `RECIPIENT_NOT_ALLOWED` |
| `atomic-batch`         | 2 × `assets.transfer` in Utility.batch_all     | signer, assetId, recipient1, amount1, recipient2, amount2                    | atomic → **`atomic_unverified`**    | `examples/templates/atomic-batch.mjs`         | mode not accepted: `PLAN_MODE_NOT_ALLOWED`     |
| `revive-call`          | `revive.call` (Revive.call)                    | signer, contract, data, value, gasLimit, proofSize, storageDepositLimit      | single → `sequential` (1 step)      | `examples/templates/revive-call.mjs`          | other contract: `CONTRACT_NOT_ALLOWED`         |
| `restricted-deploy`    | `revive.instantiate_with_code`                 | signer, code, data, gasLimit, proofSize, storageDepositLimit (salt optional) | single → `sequential` (1 step)      | `examples/templates/restricted-deploy.mjs`    | other code: `DEPLOY_CODE_HASH_NOT_ALLOWED`     |

`templateSkeleton(id)` prints the Manifest with `{{name}}` markers so you can see the shape; it is not a usable Manifest.

Notes per template:

- **atomic-batch** only _requests_ atomic. With no matching rollback proof in the facts the compiler labels the plan
  `atomic_unverified`; it compiles only with `allowAtomicUnverified: true`, and the policy must list
  `atomic_unverified` in `allowedModes`. It is never silently downgraded to sequential.
- **sequential-transfers**: if step 2 fails, step 1 stays executed (partial execution).
- **restricted-deploy** additionally runs `checkDeployStep` (code-hash allow-list, value 0, storage-deposit, gas and
  proof-size caps; value 1 gives `DEPLOY_VALUE_NOT_ALLOWED`). **No deploy happens**: the code is an 8-byte test blob and
  there is no budget.
  **Known gap:** the team rule is that a `proof_size` of 0 (what every V3 dry run so far returned) counts as
  **unknown**, never as a passed limit. Today `checkDeployStep` does **not** enforce that: a proofSize of `"0"` passes
  its cap check (the example prints this). Sentinel's fix is pending; until it merges, no deploy may rely on it.

## Error codes

| Where                                 | Code                                                                                | Meaning                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `instantiateTemplate`                 | `MANIFEST_INVALID` (with `path: params.<name>`)                                     | Unknown template, unknown parameter, missing required parameter, or a value that is empty or still a `{{placeholder}}`.    |
| `gatePolicy` (`blockedBy[].code`)     | `RECIPIENT_NOT_ALLOWED`                                                             | A recipient is not in `allowedRecipients`.                                                                                 |
|                                       | `AMOUNT_OVER_LIMIT`                                                                 | An amount is over `maxAmountPerAsset`.                                                                                     |
|                                       | `CONTRACT_NOT_ALLOWED`                                                              | The contract is not in `allowedContracts`.                                                                                 |
|                                       | `PLAN_MODE_NOT_ALLOWED`                                                             | The plan's mode (e.g. `atomic_unverified`) is not in `allowedModes`.                                                       |
|                                       | `DEPLOY_CODE_HASH_NOT_ALLOWED` (and the other `DEPLOY_*`)                           | `checkDeployStep`: code hash not allow-listed, value not 0, or a cap missing / exceeded.                                   |
|                                       | `PLAN_BYTES_MISMATCH`                                                               | Pre-sign `verifyPlan`: the plan's call bytes are not what the Manifest compiles to on the live facts (Sentinel `b1a60a4`). |
| `verifyPlan(...).issues[].code`       | `STEP_BYTES_MISMATCH`, `STEP_BODY_MISMATCH`, `PLAN_BODY_MISMATCH`                   | An edited plan: step call bytes, step body or plan body differ from a fresh compile.                                       |
|                                       | `OUTER_CALL_MISMATCH`                                                               | Atomic only: the Utility.batch_all outer call differs.                                                                     |
| `createApproval(requirePlanVerified)` | `ok: false`, reason "the plan's call bytes are not what the Manifest compiles to …" | Approval is refused for an edited plan, even with a recomputed digest.                                                     |

`PLAN_BYTES_MISMATCH` comes from Sentinel's pre-sign check (on main as `b1a60a4`, originally `a74ad38`); every example
hits it for the edited plan. The test also tolerates an older `@seam/policy` build without the check, where the edited plan
is still refused by `verifyPlan` and `createApproval`.

## Honest limits

- **Offline only.** These examples compile against committed metadata; nothing is dry-run on a node, signed or sent.
  The preflight numbers and envelope are synthetic.
- **No template output has been sent live.** Comparable calls do have V3 testnet (spec 3002) evidence, recorded in
  [evidence-manifest.md](evidence-manifest.md): `assets.transfer_keep_alive` (#102529), `assets.mint` (#102493), a SEAM
  sequential plan with an asset transfer and `nfts.mint` (#102653, #102657), an `atomic_verified` batch of mint + nft
  (#102671), `revive.instantiate_with_code` (#102843) and a SEAM `revive.call` plan (#102853). None of those were built
  from these templates. There is no live run of two transfers in one batch, and the **revive-call and restricted-deploy
  templates are not live-run** by these examples (the contract address and code are made up).
- **Dev accounts** are public test keys. Never fund them on a real network.
- `checkDeployStep` passes proof_size 0 today (known gap, Sentinel's fix pending).
- The console's pre-sign `gatePolicy` call with `requirePlanVerified: true` is `bot1/gate-hardening` (Pixel); these
  examples call the same function from Node.
