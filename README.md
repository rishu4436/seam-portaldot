# @seam/policy

SEAM's safety gate between "compiled" and "signed": the policy engine, the runtime lock, approval binding and the submit-time checks.

## What it does

- **`evaluatePolicy({ policy, plan, facts, preflight, manifest })`** checks a compiled plan. Each rule reports pass, block or unknown with a plain reason. It is allowed only if nothing blocks and every unknown was explicitly allowed by the policy.
- **`createApproval(...)`** creates an approval only for an allowed plan. The approval hash covers the Manifest, plan, exact encoded calls, runtime fingerprint, policy, policy result, signing envelope and preflight. Its lifetime is capped by the policy.
- **`checkBeforeSubmit(...)`** is the last gate before broadcasting. It blocks a reused or expired approval, anything that differs from what was approved, a runtime change, and signed bytes that differ from the approved calls.
- **`checkRuntimeLock(prepared, current)`** names exactly which fingerprint fields changed. Portaldot's signed extensions don't include `CheckMetadataHash`, so this is the only guard against a metadata change that keeps the same spec version.
- **`canRunNextStep` / `overallResult`** stop a sequential run after a failed or unverified step and mark the receipt as partial or not verified.

Defaults: unknown capabilities are never allowed, other unknowns are blocked unless listed in `allowUnknown`, `atomic_unverified` is off, human approval is on, and approvals last at most 10 minutes.

SS58 prefix 42 is the generic Substrate prefix, so a correct prefix doesn't prove an address belongs to Portaldot. The recipient allowlist is the real guard.

## Attack cases

`test/attacks.test.ts` covers all 13 agreed cases, offline:

1. Recipient or amount changed after approval
2. Approval reused or expired
3. Runtime upgraded between compile and submit
4. Metadata changed, same spec version
5. Wrong address type, network prefix or checksum
6. Capability not observed or unknown
7. Asset or contract not allowed
8. Amount, weight or storage over the limit
9. Sequential run fails at step 2 (stop, partial receipt)
10. Wallet signed different bytes
11. Success reported but expected event missing
12. Atomic mode without a tested rollback
13. Pinned type file changed after compiling

Fixtures use the real fingerprint values from Bot 4's snapshot of `wss://mainnet.portaldot.io` (block 2,721,455). Calls, hashes and estimates in the fixtures are example data.

## Run

```
npm install
npm test
npm run build
```

Shared types in `src/types.ts` are copied from the console and will move to the shared package once the monorepo exists.
