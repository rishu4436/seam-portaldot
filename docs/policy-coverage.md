# Policy coverage (P0-02)

Audit of `@seam/policy` at `7a551e3` plus the `bot3/policy-hardening` changes. Browser path: the console calls
`gatePolicy` / `assertPolicyAllows` (`packages/policy/src/browser.ts`, which runs `evaluatePolicy`) before the wallet
opens, then `createApproval`, then `checkBeforeSubmit` on the signed bytes before broadcasting. All three are in the
browser-safe import graph.

## Rule matrix

| Spec rule                                             | Enforced by (file:function)                                                            | Block code(s)                                                                                                                                                                 | Tests                                              | Gap / change                                                                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset allow-list                                      | policy.ts:evaluatePolicy                                                               | ASSET_NOT_ALLOWED                                                                                                                                                             | attacks #7                                         | none                                                                                                                                                                                                             |
| Recipient allow-list                                  | policy.ts:evaluatePolicy (+ address_check)                                             | RECIPIENT_NOT_ALLOWED                                                                                                                                                         | attacks #1, browser-entry, hardening-p002, Demo C  | none                                                                                                                                                                                                             |
| Contract allow-list                                   | policy.ts:evaluatePolicy                                                               | CONTRACT_NOT_ALLOWED                                                                                                                                                          | attacks #7                                         | none                                                                                                                                                                                                             |
| Selector / message allow-list, ABI pin                | policy.ts:evaluatePolicy                                                               | SELECTOR_ALLOWED_BLOCKED, MESSAGE_NOT_ALLOWED_BLOCKED, ABI_HASH_*                                                                                                             | attacks #7, seam-audit                             | none                                                                                                                                                                                                             |
| Amount cap per asset                                  | policy.ts:evaluatePolicy                                                               | AMOUNT_OVER_LIMIT                                                                                                                                                             | attacks #8, hardening-p002, Demo C                 | none                                                                                                                                                                                                             |
| Native value cap                                      | policy.ts:evaluatePolicy capCheck                                                      | NATIVE_VALUE_OVER_LIMIT                                                                                                                                                       | attacks                                            | none                                                                                                                                                                                                             |
| Fee cap (total)                                       | policy.ts:evaluatePolicy est                                                           | FEE_OVER_LIMIT, FEE_LIMIT_UNKNOWN                                                                                                                                             | attacks, hardening-p002                            | none                                                                                                                                                                                                             |
| Gas / weight / proof size                             | policy.ts:evaluatePolicy                                                               | GAS_LIMIT_BLOCKED, WEIGHT_LIMIT__, PROOF_SIZE_LIMIT__                                                                                                                         | attacks #8                                         | none                                                                                                                                                                                                             |
| Max steps                                             | policy.ts:evaluatePolicy                                                               | MAX_STEPS_EXCEEDED                                                                                                                                                            | browser-entry, hardening-p002                      | **fixed**: negative limit now blocks; NaN/fraction already refused by the policy digest (POLICY_EVALUATION_ERROR)                                                                                                |
| Allowed modes                                         | policy.ts:evaluatePolicy, rollbackProofOk                                              | PLAN_MODE_NOT_ALLOWED                                                                                                                                                         | PolicyGate/SignFlow, attacks #12                   | **fixed**: `allowedModes` given as a string could substring-match a mode; now must be an array                                                                                                                   |
| Expiry (signing window)                               | browser.ts:gatePolicy (opts.envelope)                                                  | SIGNING_WINDOW_EXPIRED                                                                                                                                                        | browser-entry, hardening-p002                      | only checked when the caller passes `envelope` (the console does)                                                                                                                                                |
| Expiry (approval)                                     | approval.ts:createApproval (min of envelope and maxApprovalSeconds), checkBeforeSubmit | approval_expired, approval_tampered                                                                                                                                           | adversarial-gate, attacks #2, forged-and-stale     | none                                                                                                                                                                                                             |
| Single-use approval / duplicate send                  | approval.ts:checkBeforeSubmit + ApprovalStore / ReservableApprovalStore                | approval_reused, approval_reserved, approval_uncertain                                                                                                                        | attacks #2, adversarial-gate, hardening-p002       | in-memory store is per-process (console state is lost on refresh; P1-03)                                                                                                                                         |
| Pre-sign dry run (allowUnknown.dryRun)                | policy.ts:evaluatePolicy                                                               | DRY_RUN_FAILED, DRY_RUN_UNKNOWN                                                                                                                                               | attacks, hardening-p002                            | none                                                                                                                                                                                                             |
| Signed dry run (requireSignedDryRun)                  | approval.ts:checkBeforeSubmit                                                          | signed_dry_run_failed, signed_dry_run_missing                                                                                                                                 | attacks, adversarial-gate                          | none                                                                                                                                                                                                             |
| Code-hash allow-list, deploy value/gas/storage        | deploy.ts:checkDeployStep                                                              | DEPLOY_* codes                                                                                                                                                                | deploy-policy, deploy-proof-size                   | **fixed**: proof size limit `0` used to pass; now blocks `DEPLOY_PROOF_SIZE_UNKNOWN` (V3 dry runs report refTime with proof_size 0). A missing proof size already blocked `DEPLOY_GAS_LIMIT_MISSING` (unchanged) |
| Storage deposit limit                                 | policy.ts:evaluatePolicy                                                               | STORAGE_LIMIT_*                                                                                                                                                               | attacks #8                                         | none                                                                                                                                                                                                             |
| Unknown-data policy                                   | policy.ts:evaluatePolicy `unknown()`; browser.ts gate blocks every non-pass            | *_UNKNOWN                                                                                                                                                                     | attacks "unknown fee", Portaldot preset            | none                                                                                                                                                                                                             |
| Plan integrity / manifest / signer / runtime          | policy.ts:evaluatePolicy                                                               | PLAN_DIGEST_MISMATCH, MANIFEST_MISMATCH, SIGNER_MISMATCH, RUNTIME_MISMATCH                                                                                                    | attacks, hardening-p002                            | **added**: duplicate step ids block (DUPLICATE_STEP)                                                                                                                                                             |
| Runtime lock at submit (raw / layout)                 | runtimeLock.ts:checkRuntimeLock via checkBeforeSubmit                                  | runtime_changed                                                                                                                                                               | attacks #3/#4, runtime-lock-layout, hardening-p002 | none                                                                                                                                                                                                             |
| Signed bytes: signer, signature, nonce, genesis, call | approval.ts:checkBeforeSubmit (trusted decoder)                                        | signed_signer_mismatch, signed_signature_invalid, signed_nonce_mismatch, signed_chain_mismatch, signed_bytes_mismatch, signed_extrinsic_undecodable, trusted_decoder_required | seam-audit, hardening-p002                         | none                                                                                                                                                                                                             |
| Mortality window at submit                            | approval.ts:checkBeforeSubmit (`currentBlockNumber`)                                   | mortality_expired, mortality_invalid                                                                                                                                          | hardening-p002                                     | **added** (optional input; was not checked)                                                                                                                                                                      |
| Account nonce at submit                               | approval.ts:checkBeforeSubmit (`currentAccountNonce`)                                  | nonce_stale, nonce_gap                                                                                                                                                        | hardening-p002, forged-and-stale                   | **added** (optional input; was not checked)                                                                                                                                                                      |
| Genuine policy result                                 | policy.ts:isEvaluatedPolicyResult, approval.ts:createApproval / checkBeforeSubmit      | policy_result_forged, policy_result_unverified                                                                                                                                | forged-and-stale                                   | **added**, see below                                                                                                                                                                                             |
| requireHumanApproval                                  | not enforced in the engine                                                             | —                                                                                                                                                                             | —                                                  | the approval step is the human step in the console; the flag is not read anywhere (limitation)                                                                                                                   |

## Forged policy results

`assertPolicyAllows` / `gatePolicy` never accept a decision: they always run the engine. The risk was downstream:
`createApproval` and `checkBeforeSubmit` take a `PolicyResult` from the caller.

- `createApproval` now refuses a result whose own rules don't all pass (e.g. a blocked result flipped to `allowed: true`) or that has no rules.
- `checkBeforeSubmit` always blocks an inconsistent result or one for a different policy (`policy_result_forged`).
- Every result `evaluatePolicy` returns is recorded in a non-enumerable, process-wide `WeakSet` (`isEvaluatedPolicyResult`). With
  `requireEvaluatedPolicyResult: true`, `checkBeforeSubmit` blocks any other result (`policy_result_unverified`) unless
  `policyEvaluation: { facts, manifest }` is passed, in which case it re-runs the policy and requires an identical
  allowed result (`policy_result_reproduced` / `policy_result_forged`). This is how a result restored from storage after
  a refresh gets accepted.
- Strict mode is opt-in so that existing replay callers (the SDK's `Seam.execute` replays recorded JSON results) keep
  working. The console and SDK should turn it on; that edit is in their files, not here.

## Demo C: policy violation blocked before the wallet opens

Fixture: `packages/policy/demo/demo-c.json`. It holds a normal policy file (Portaldot base, asset 1, recipient Bob only,
amount cap 1000000000000) and two valid manifests:

- `recipient_off_allowlist` pays Charlie, so the gate blocks with `RECIPIENT_NOT_ALLOWED`:
  "Recipient allowed (step pay): Fail. Blocked: recipient 5FLSig… is not on the allowed list."
- `amount_over_cap` pays Bob 1000000000001, so the gate blocks with `AMOUNT_OVER_LIMIT`:
  "Amount within limit (step pay): Fail. Blocked: amount 1000000000001 is over the limit of 1000000000000 for asset 1."

`packages/policy/test/hardening-p002.test.ts` ("Demo C") shows that, for each case, `gatePolicy` blocks with exactly
that one code and text, `assertPolicyAllows` throws `PolicyBlockedError` with that code, no signing request is made,
and `createApproval` refuses.

How to run it in the console (Pixel wires the UI; nothing is signed or sent):

1. Open the LIVE flow and load the policy object from `demo-c.json` (`policy`) into the policy panel.
2. Import one case's `manifest` (the console fills `chain` from the live runtime facts) and compile.
3. Press Sign. The policy gate panel shows the Fail line above, and the wallet extension never opens.
   The status reads "Blocked by policy before signing (RECIPIENT_NOT_ALLOWED). Nothing was signed."

Run the test with `npm test -w @seam/policy`.

## Known gaps not fixed here

- ~~decodedArgs vs encodedCall~~ **closed** by the plan-bytes gate (below) when `manifest` + `liveFacts` are given.
- Outside live mode, mortality and account-nonce checks only run when the caller passes `currentBlockNumber` / `currentAccountNonce`.
- Signature validity is the trusted decoder's job (`@seam/chain`). Here it is tested at the gate with a stub decoder.

## Plan-bytes gate and live mode (`bot3/plan-bytes-gate`)

The policy engine reads `decodedArgs`, but the wallet signs `encodedCall`. The old pre-sign check compared only the
pallet/call index prefix of `encodedCall`. It has been **removed**, because an edited plan keeps the right prefix. In its place:

- `createApproval({ ..., manifest, liveFacts })` recompiles the Manifest on the live facts (`verifyPlan` from
  `@seam/compiler/browser`) and refuses unless every step body and call byte matches, and the Manifest digest matches.
  `requirePlanVerified: true` refuses when either input is missing.
- `checkBeforeSubmit` does the same check, and also checks the signed calls, whenever `manifest` + `liveFacts` are given
  (`plan_bytes_mismatch`, with the compiler's `issues`). It also checks `manifest_digest_mismatch`, and `live_facts_mismatch`
  when `liveFacts` isn't the runtime that the lock compared (`currentFingerprint`). Facts carried inside a plan are never used.
- `live: true` makes `currentBlockNumber`, `currentAccountNonce`, `manifest`, `liveFacts` and `signedCalls` (one per
  `callsToSign(plan)` entry) required. Each missing one blocks: `live_block_missing`, `live_nonce_missing`,
  `live_manifest_missing`, `live_facts_missing`, `live_signed_calls_missing`.
- **Non-live mode (e.g. SDK replay) without manifest + liveFacts: call bytes are unchecked against the Manifest.** The
  signed calls are still compared with the plan's own `callsToSign`, but a plan edited with a recomputed digest passes that.
  Use live mode for real sends.
- **Pre-sign (`bot3/presign-verify-plan`):** `gatePolicy` / `assertPolicyAllows` / `evaluatePolicy` run `verifyPlan`
  (no signed calls) when the input carries `manifest` **and** `liveFacts`. A mismatch blocks rule `plan_bytes`, code
  `PLAN_BYTES_MISMATCH`. The rule result and `explainPolicy` line carry Forge's `issues`, and the line reads
  "Call bytes match the Manifest: Fail. Blocked: the plan's call bytes are not what the Manifest compiles to on the
  live runtime (STEP_BYTES_MISMATCH at step 1)." `liveFacts` must have the same fingerprint as `facts`.
  `requirePlanVerified: true` (a gate option, or on the engine input) blocks with the same code when either input is
  missing. This is off by default. Inputs without `liveFacts` behave as before, so the recorded
  `console/src/demo/v3-demo-transfer.json` (unchanged) keeps working in the layout-lock and downgrade tests.
  It no longer matches a fresh compile body-for-body, so it must not be used with `liveFacts`.

Tests: `packages/policy/test/plan-bytes-gate.test.ts`, `packages/policy/test/presign-verify-plan.test.ts` (fresh
compile from the committed spec 3002 metadata). The sequential case now uses Forge's fresh fixture
`packages/compiler/fixtures/v3-fresh-transfer.json` (a745260): it passes the strict gate, and a forged-Charlie variant
of it blocks `PLAN_BYTES_MISMATCH`. The single and atomic variants still compile in the test, because the fixture has none.
