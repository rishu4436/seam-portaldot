# @seam/policy

SEAM's safety gate between "compiled" and "signed": the policy engine, the runtime lock, approval binding and the submit-time checks.

## What it does

- **`evaluatePolicy({ policy, plan, facts, preflight, manifest })`** checks a compiled plan. Each rule reports pass, block or unknown with a plain reason. It is allowed only if nothing blocks and every unknown was explicitly allowed by the policy.
- **`createApproval(...)`** creates an approval only for an allowed plan. The approval hash covers the Manifest, plan, exact encoded calls, runtime fingerprint, policy, policy result, signing envelope and preflight. Its lifetime is capped by the policy.
- **`checkBeforeSubmit(...)`** is the last gate before broadcasting. It blocks a reused or expired approval, anything that differs from what was approved, a runtime change, and signed bytes that differ from the approved calls.
- **`checkRuntimeLock(prepared, current)`** names exactly which fingerprint fields changed. Portaldot's signed extensions don't include `CheckMetadataHash`, so this is the only guard against a metadata change that keeps the same spec version.
- **`canRunNextStep` / `overallResult`** stop a sequential run after a failed or unverified step and mark the receipt as partial or not verified.

`portaldotPolicy()` is the starting point for today's Portaldot runtime. It allows an unknown storage deposit, which this runtime never reports, and an unknown dry run before signing. The submit gate then requires a successful `system_dryRun` of each signed transaction (`requireSignedDryRun`, on by default). The signing envelope must carry a `checkpoint` block, and the approval covers it.

Defaults: unknown capabilities are never allowed, other unknowns are blocked unless listed in `allowUnknown`, `atomic_unverified` is off, human approval is on, and approvals last at most 10 minutes.

SS58 prefix 42 is the generic Substrate prefix, so a correct prefix doesn't prove an address belongs to Portaldot. The recipient allowlist is the real guard.

## Attack cases

`test/attacks.test.ts` covers all 13 agreed cases, offline:

1. Recipient or amount changed after approval
2. Approval reused or expired
3. Runtime upgraded between compile and submit
4. Metadata changed, same spec version
5. Wrong address type or network prefix (compiler refuses; policy re-checks plan addresses)
6. Capability not observed or unknown
7. Asset, contract or contract message (selector) not allowed
8. Amount, gas limit, weight or storage over the limit
9. Sequential run fails at step 2 (stop, partial receipt)
10. Wallet signed different bytes
11. Success reported but expected event missing
12. Atomic mode without a tested rollback
13. Pinned type file changed after compiling

Tests run on real plans: Bot 2's compiler (`@seam/compiler`, linked from `../seam-compiler`) compiles the demo Manifest against Bot 4's snapshot of `wss://mainnet.portaldot.io` (block 2,721,455, spec 1002). Only the preflight estimates and the signing envelope are example data.

Hashing matches the compiler exactly: blake2b-256 of the domain, one 0x00 byte, then canonical JSON (safe integers only). A test checks the plan, fingerprint and generic digests against the compiler's own functions.

## Run

```
npm install
npm test
npm run build
```

Runtime facts, Manifest and Plan types are copied from the compiler into `src/compilerTypes.ts`; they become an import once the monorepo exists.

## Audit hardening (SEAM-001/002/005/017)

- **Sequential steps** (`canRunNextStep`): a dependent step starts only after every earlier step is `finalized` + `verified` with a tx hash and block and no failure event. Blocks return a `code` (`step_failed`, `step_not_finalized`, `verification_failed`, `verification_unknown`, `receipt_data_missing`, `contract_outcome_failed`). `markNotRun()` appends `not_run` steps for everything after the stop.
- **Approval store**: `ReservableApprovalStore` adds `reserve -> commit | release | markUncertain -> reconcile`, with idempotency key and tx hash. `InMemoryApprovalStore` is at-most-once within one process only; it forgets everything on restart. Hosted use needs a durable store with atomic reserve. `markUsed` still works (reserve+commit, final). Call the gate *before* `reserve`.
- **Weaker proof**: unknowns allowed by policy are flagged (`rule.weak`, `PolicyResult.weakProof`); a send with no signed dry run reports `signed_dry_run_not_checked`.
- **Signed bytes**: pass `signedExtrinsics` + `decodeSignedExtrinsic` (trusted decoder) so the gate compares the call decoded from the bytes, plus signer, nonce, signature, genesis. `signedCalls` is then ignored. `requireTrustedDecoder: true` fails closed without them.
