# SEAM security gates and trust boundaries

What each gate checks, and, just as important, what it does not prove. This is a description of the code at baseline
`a3bc52b` plus known gaps; it is not a formal audit. Gaps below are tracked in [BUILD_STATE.md](BUILD_STATE.md).

## Pipeline

Manifest → compile (against a runtime fingerprint) → policy check → preflight → approval → wallet signature →
send gate (per step) → submit → receipt. Each stage can refuse; none can be skipped by a later one.

## Gates

| Gate | Checks | Does not prove |
|------|--------|----------------|
| Manifest validation | Shape, digest of the Manifest, known action kinds | That the intent is wise, or that the signer owns the assets |
| Compiler | Encodes steps from runtime metadata; picks a plan mode with a stated reason; refuses unsupported kinds (`revive.call`, `nfts.mint` are unavailable) | That the pinned metadata matches the live chain now; compiler output is only as good as the snapshot it was given |
| Runtime lock | Plan's runtime fingerprint (genesis, spec, metadata hash) equals the node's at submit time | Behaviour of a runtime with the same fingerprint. Fingerprint omits state version and runtime API surface (SEAM-011). Caller-declared token properties are declared, not observed |
| Policy | Deny-by-default rules on the compiled plan (allowed assets, recipients, amounts, selectors, ABI hash, limits) | Anything the rules do not cover. Coverage across all action types is still being hardened (SEAM-017). Policy never sees contract deploy |
| Preflight / dry-run | Per-step estimates; a signed dry-run when available | Whole-plan outcome. Per-step estimates do not prove aggregate state transitions, and a pre-sign estimate is weaker than a signed dry-run (SEAM-018) |
| Approval | A human or caller approval is bound to a plan and used at most once per store | Durability: the default store is in memory, lost on restart, and marked used *before* submit, so a failed broadcast can burn an approval (SEAM-005) |
| Signing request / signature | Substrate payload built for the plan; signature verified on assembly | That the signed bytes equal the approved request on every path. A custom wallet adapter's own `signedCall` is not authoritative (SEAM-001) |
| Send gate | Per-step checks including signed-bytes match, signed dry-run and runtime lock | Chain inclusion or effect; it only authorizes sending |
| Sequential continuation | Stops before the next step if the previous one is not acceptable | At baseline an unverified or merely included step could let the flow continue (SEAM-002); treat dependent sequential runs as unsafe until fixed |
| Receipt | Records tx hash, block, events and per-step verification | See below |

## Browser policy flow

Added in Sentinel `3a425c6` (on `main` at `dbe8e3b`). `@seam/policy/browser` (`packages/policy/src/browser.ts`)
re-exports everything in `@seam/policy` (including `evaluatePolicy`) and adds a pre-sign gate. Its import graph has no
node built-ins (`policy/test/browser-entry.test.ts`, "has no node built-in imports anywhere in its graph").

```ts
gatePolicy(input: PolicyInput, opts?: GateOptions): GateResult
assertPolicyAllows(input: PolicyInput, opts?: GateOptions): GateResult   // throws PolicyBlockedError unless allowed
explainPolicy(result: PolicyResult): RuleExplanation[]                   // one line per rule, none dropped
class PolicyBlockedError extends Error { gate: GateResult; codes: string[] }
```

- `GateOptions`: `acknowledgedDowngrade?`, `envelope?: { expiresAt }`, `now?`.
- `GateResult`: `{ allowed, result?, explanations, blockedBy }`. `blockedBy` lists every rule that is not `pass`.
- `RuleExplanation`: `{ rule, status: "pass" | "fail" | "unknown", code, message, actionId?, weak? }`. Codes come from
  `codeFor`: the rule's own code, `OK` for a pass, `<RULE>_UNKNOWN` for an unknown, or a fail code such as
  `PLAN_MODE_NOT_ALLOWED`, `SIGNER_MISMATCH`, `AMOUNT_OVER_LIMIT`, `FEE_OVER_LIMIT`, `DRY_RUN_FAILED`.

Call `assertPolicyAllows` immediately before the wallet signer. It is fail-closed: `allowed` is true only if the engine
allows the plan **and** every explanation is `pass`. It blocks when:

- any rule is `fail` or `unknown` (an unknown is never treated as a pass, even if the engine result says allowed);
- `evaluatePolicy` throws (`POLICY_EVALUATION_ERROR`);
- a preferred-atomic plan fell back to sequential and the person did not acknowledge it (`MODE_DOWNGRADE_NOT_ACKNOWLEDGED`);
- an `envelope` is given and its `expiresAt` is past or invalid (`SIGNING_WINDOW_EXPIRED`);
- no preflight is given (`PREFLIGHT_UNKNOWN`), or a plan step has no preflight entry.

Tests in `policy/test/browser-entry.test.ts` use a spy signer: a violation never calls it, and the happy path calls it
exactly once.

**Wallet demo policy.** `packages/console/src/demo/v3-demo-transfer.json` allows only `atomic_verified`, but its plan is
`sequential`. It is left unchanged. The new `packages/console/src/demo/v3-demo-transfer-policy-sequential.json` is the same
policy with `allowedModes: ["sequential"]` (a test checks that nothing else differs). With it the demo plan passes the gate
(with the downgrade acknowledged); the original `atomic_verified`-only policy blocks with `PLAN_MODE_NOT_ALLOWED` before
the signer is called.

**At submit**, `checkBeforeSubmit` (`packages/policy/src/approval.ts`) still runs after signing. It enforces single use
(`approval_reused`, `approval_reserved`, `approval_uncertain`: one approval allows exactly one submission), and the signed
dry run: a failed one blocks (`signed_dry_run_failed`), and when the policy sets `requireSignedDryRun` a missing or unknown
one blocks (`signed_dry_run_missing`). Without `requireSignedDryRun`, a send with no signed dry run passes as
`signed_dry_run_not_checked` (weaker proof).

**Console status on `dbe8e3b`.** The console does not import `@seam/policy/browser` yet; Pixel is wiring it in front of
the signer. The Risk limits view (`console/src/lib/limits.ts`) only displays the policy and never authorizes anything.
The wallet demo's Approve button is still enabled by the console's own `checkWalletDemoPolicy` pre-check
(`console/src/lib/walletdemo.ts`), which is not the policy engine and does not check the plan mode. The console does not
call `checkBeforeSubmit` either. Browser preflight is not exported yet, so once wired the gate will block with `PREFLIGHT_UNKNOWN`.

## LIVE multi-step signing (console, Pixel `fc91363` on `bot1/live-multistep`)

What `packages/console/src/lib/multistep.ts` does:

- **One approval binds the whole plan.** The pre-sign gate runs once and binds the approval. Every step is then signed up front, in order, with nonce `n + i`. All steps share the one short-mortality envelope from `buildSigningEnvelope`, so only the nonce differs. An atomic plan is a single `batch_all` request.
- **Expiry is checked twice per step.** The envelope's `expiresAt` is checked before each step's gates and again right before broadcast. An unreadable or past `expiresAt` stops the run with `SIGNING_WINDOW_EXPIRED`.
- **Per-step gates (sequential).** For every step after the first, the policy gate runs again on a fresh preflight. Each step then gets a re-preflight with the signed bytes, and `checkBeforeSubmit` runs with that step's `sendIndex` and the earlier receipts.
- **Signed bytes stay in memory.** A `SignedHolder` keeps them in memory only. They are never written to logs, storage, exports or receipts, and `redact()` removes them from any message. The holder is cleared on a block, a failure, a cancel, an unmount (an `AbortController` in `Modes.tsx`) and at the end of the run.
- **A block or failure stops the run.** A blocked or failed step stops all remaining steps.
- **Unverifiable steps stop the run.** The rule is `canRunNextStep` in `@seam/policy` (`packages/policy/src/approval.ts`): a step may start only when every earlier step is `finalized` and `verified`, with a tx hash and block and no failure event. The console does not call it directly. It passes the earlier receipts as `previousSteps` to `checkBeforeSubmit`, which runs `canRunNextStep` and blocks with `previous_step_failed` (plus the specific code, such as `verification_unknown`) or `previous_steps_missing`. Any step kind the console can't verify therefore stops the run after that step.

Accepted limits:

- (a) The signed bytes for every step are kept until the run ends, because `checkBeforeSubmit` needs the full set.
- (b) JavaScript can't securely wipe strings. `clear()` overwrites the slots and drops the references, but copies may stay in memory until garbage collection.
- (c) If step 1 dispatches but fails, it has still used nonce `n`. Step 2's signed bytes stay valid on chain until their mortality runs out, and anyone holding them could submit them. The short mortality is what limits this.

No multi-step plan has been run on V3 with this code.

## Known limits, stated plainly

- **Receipt hash is integrity only.** `seam verify` recomputes an unkeyed digest of the receipt JSON. Anyone who edits a receipt
  can recompute it. A matching digest means the file is self-consistent, not that the transaction exists, is final,
  was signed by the stated account, or had the stated outcome. Independent chain verification is not built yet (SEAM-003).
- **Contract deploy is an unchecked setup step.** The demo contract deploy is signed and dry-run through SEAM's signing path,
  but it is outside the Manifest/Policy trust boundary: no Manifest describes it, policy does not evaluate it, and there is
  no receipt. Production-facing execute paths must not expose it.
- **`atomic_verified` depends on proof provenance.** Metadata shows `Utility.batch_all` exists, not that cross-surface effects
  roll back. At baseline a caller-set `'verified'` value can select `atomic_verified`, and an atomic preference can fall
  back to sequential with only a note (SEAM-012, 013). A local-chain rollback result is not evidence for V3.
- **Event verification coverage is narrow.** Verifiers exist for native assets and the legacy `Contracts` pallet only. A
  generic `ContractEmitted` event from the right address is counted as verified at baseline even if it is unrelated to the
  requested effect (SEAM-004). Revive and Nfts have no verifier (SEAM-010). Events are decoded by spec version at the
  inclusion block, not by metadata hash (SEAM-015).
- **Account domains.** The H160-only signer path and native AccountId32 signing are not reconciled for V3 (SEAM-009).
- **No V3 or mainnet evidence.** All recorded runs are from local nodes. Nothing here claims hosted V3 or mainnet behaviour.

## Dependency audit (2026-10-18)

- `npm audit --omit=dev`: **0 vulnerabilities** (no high or critical in production dependencies).
- Full `npm audit` (includes dev tooling): 6 findings, all dev-only: `vitest` (critical, <=4.1.10), `tinypool` (critical,
  <=2.1.1), `vite` (high, <=6.4.2, dev-server issues), plus moderate `esbuild`, `vite-node`, `@vitest/mocker`.
  They affect the test runner and dev server only, not shipped code. The fix is `vitest@4.1.12`, a semver-major bump,
  so it is **not applied** here to keep the suites green. Follow-up: upgrade vitest/vite in a dedicated PR; until then
  do not expose the Vite dev server to untrusted networks or sites and do not run tests on untrusted inputs.
- Review note: esbuild's postinstall script is not covered by `allowScripts` (npm warning); review before enabling.
- Vite config in `packages/console` is now ESM-safe (`fileURLToPath(import.meta.url)` instead of `__dirname`).

## Reporting a problem

No formal disclosure process exists yet. Until one is added, open a GitHub issue without exploit details and contact the
maintainer through the repository.
