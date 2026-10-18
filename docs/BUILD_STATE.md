# SEAM build state

Factual completion matrix for SEAM-001..028, tracked against the audit of `main` at `a3bc52b`.
Each status was checked against the code and tests on `main` at `62d9688` (plus the release-hygiene branch), not taken from branch reports.

Statuses:

- **Fixed**: merged on `main`, with the test evidence named in the row.
- **Blocked**: cannot be finished honestly until the hosted Portaldot V3 runtime metadata/RPC is read. Only the honest-blocker part is merged.
- **Open**: not done, or only partly done. The row says what is missing.

Update this file in the same commit that changes a status.

## Verdict

**DEVELOPMENT CODE COMPLETE — V3 LIVE CAPABILITY PENDING** for everything that does not need a hosted Portaldot V3 runtime, with the open items listed below still to land.

Not `READY FOR FUNDED V3 TESTING`: no V3 runtime metadata has been read, no funded V3 write may happen, and the items under "New open items" (Revive/Nfts bindings, LIVE Console binding, verify-live hardening) must be closed first.
SEAM-006..011 and 023 stay Blocked on a V3 RPC URL and a funded test account.

## Test counts on `main` (`62d9688`)

| Package | Passing | Skipped |
|---------|---------|---------|
| compiler | 150 | 0 |
| policy | 187 | 0 |
| sdk | 141 | 0 |
| chain | 118 | 12 |
| console | 49 | 0 |

At the audit baseline (`a3bc52b`, CI run 39106951312): compiler 111, policy 68, SDK 63, chain 59, 12 skipped. Console tests were not in the baseline count.
The local-node E2E (`npm run test:e2e`) is not part of routine CI (manual/weekly `e2e.yml`).

## Completion matrix

| ID | P | Status | Evidence on `main` / what remains |
|----|---|--------|-----------------------------------|
| SEAM-001 | P0 | **Fixed** | `adapter.verifySigned`, `verifySignedAgainstRequest`, `signedExtrinsicDecoder`; `Seam.execute` decodes signed bytes and never trusts wallet `signedCall`. Tests: `chain/tests/signed-binding.test.ts` (different call under valid signature, other signer, fewer/extra/reordered, replay, no prepared request), `chain/tests/sdk-signed-binding.test.ts`, `sdk/tests/signed-binding.test.ts` (wallet reports expected `signedCall`, `signedTx` differs: blocked, zero submits). |
| SEAM-002 | P0 | **Fixed** | `canRunNextStep` requires finalized + verified; flow stops and marks later steps `not_run`. Tests: `policy/test/seam-audit.test.ts` (SEAM-002 block), `sdk/tests/flow-lifecycle.test.ts`. |
| SEAM-003 | P0 | **Fixed** | `receiptIntegrity` returns only `integrity_checked`/`failed`; `seam verify --endpoint` re-reads the chain for `chain_verified`/`unknown`/`failed`. Tests: `sdk/tests/verify-live.test.ts` (fabricated self-consistent receipt, wrong block, non-canonical block, wrong signer/call, forged events, throwing reader), `sdk/tests/cli-verify.test.ts`. |
| SEAM-004 | P0 | **Fixed** | Verifier coverage levels; generic `ContractEmitted` is not verified; exact event data / state readback decides; `execute` takes `effects` (actionId to `ContractEffect`). Tests: `sdk/tests/verifier-coverage.test.ts`, `chain/tests/sdk.test.ts`. Applies to legacy `Contracts` only; Revive effects are SEAM-010. |
| SEAM-005 | P0 | **Fixed** | Lifecycle (reserve/commit/release/uncertain, `Seam.reconcile`, `lookupExtrinsic`) plus durable `FileApprovalStore(path, {lockTimeoutMs?})`: atomic writes (temp file, fsync, rename), lock file, corruption fails closed (`ApprovalStoreError`); `new Seam(chain, store \| path)`. Restart/crash tests in policy and sdk. |
| SEAM-006 | P0 | **Blocked** | Compiler returns an honest "no observed V3 Revive metadata" blocker, no guessed layout (`compiler/tests/audit.test.ts`, `sdk` runtimes test). No `Revive.call` encoder: needs real V3 metadata. |
| SEAM-007 | P0 | **Blocked** | Same for `Nfts.mint`: honest blocker only, no encoder. |
| SEAM-008 | P0 | **Blocked** | No Revive dry-run API, H160/AccountId32 mapping or ABI handling in `chain/src/preflight.ts`, `compiler/src/address.ts`; needs the V3 runtime API surface. |
| SEAM-009 | P0 | **Blocked** | Merged: compiler blocks an H160 signer on an AccountId32 runtime (and the reverse) with a precise message, no conversion (`compiler/tests/audit.test.ts`). The actual V3 signer/account model is unproven. |
| SEAM-010 | P0 | **Blocked** | Revive/Nfts verifiers report `unsupported_runtime`, never `verified` (`sdk/tests/verifier-coverage.test.ts`). No real V3 verifier. |
| SEAM-011 | P0 | **Blocked** | Merged: `stateVersion`, `metadataVersion` and declared-vs-observed token provenance in facts (`compiler/tests/audit.test.ts`); fingerprint schema V1 digest unchanged. Missing: V3 runtime API surface capture and a versioned fingerprint extension. |
| SEAM-012 | P1 | **Fixed** | `atomic_verified` needs a rollback proof matching genesis, metadata, spec and composition; a bare `'verified'` string or a proof from another genesis does not promote. Tests: `compiler/tests/audit.test.ts` (SEAM-012 block), `policy/test/compiler-sync.test.ts`. |
| SEAM-013 | P1 | **Fixed** | `atomicRequired` fails closed; preferred-atomic fallback sets `modeDowngrade` requiring acknowledgement; SDK manifest validator passes it through. Tests: `compiler/tests/audit.test.ts`, `sdk/tests/manifest-atomic.test.ts`. |
| SEAM-014 | P1 | **Fixed** (docs/labels) | Deploy is labelled an unchecked setup step outside Manifest/Policy (CLI help, `packages/chain/docs/testnet-run.md`, README). No behaviour change by design; there is no deploy action in the compiler or policy, so the execute route cannot bypass policy with one. |
| SEAM-015 | P1 | **Fixed** | Events are decoded only when the inclusion block's metadata hash equals the pinned one. Tests: `chain/tests/metadata-hash.test.ts` (same spec version, different metadata: not decoded; `readEvents` refuses directly). |
| SEAM-016 | P1 | **Fixed** | `checkSigningWindow` in `adapter.submit` before broadcast: `era_expired`, `nonce_stale`, `nonce_not_next`, `checkpoint_not_on_chain` (reorg), `window_unreadable`; nothing is sent. Tests: `chain/tests/signing-window.test.ts`; wallet cancellation: `console/src/lib/__tests__/live.test.ts`. A signed payload is never rewritten. |
| SEAM-017 | P1 | **Fixed** | Deny-by-default tests for every action kind, per-argument caps, unknown dry-run/fee/weight/storage as weaker proof, pre-sign vs signed dry-run, swapped or edited policy results. Tests: `policy/test/seam-audit.test.ts` (SEAM-017 block). It is example-based, not property-based testing. |
| SEAM-018 | P1 | **Fixed** (chain level) | Preflight reports per-step coverage; whole-plan only for a passing signed atomic dry-run; a failed dry run is never coverage. Tests: `chain/tests/coverage.test.ts`. Console shows a `CoverageBadge`. Real V3 API alignment is part of SEAM-008. |
| SEAM-019 | P1 | **Open** (partial) | Merged: three-mode switch, LIVE V3 panel, browser JSON-RPC discovery/transport and extension-signing adapters (`console/src/lib/chainclient.ts`, `extensionsigner.ts`), `live.ts` tests. Fail-closed by design: `LivePanel` still passes an empty request with no bound signature verifier or extrinsic assembler, and the browser chain client reports preflight unavailable / verification unknown. Not a finished wallet-to-receipt flow. |
| SEAM-020 | P1 | **Fixed** | Apache-2.0 `LICENSE`, `examples/consumer`, `scripts/pack-smoke.sh` (`npm run smoke:pack`: pack, clean install, run consumer + CLI). Packages stay `private` and unpublished; the smoke test is not part of `npm test` or CI. |
| SEAM-021 | P1 | **Fixed** | `seam drift <snapA> <snapB> [--plan plan.json]`: exit 0 no drift, exit 10 `runtime_drift`; reproducible A/B diff against fixture metadata. |
| SEAM-022 | P1 | **Fixed** | Stable `SeamCode` enum, CLI exit codes, next actions, `classifyReceipt`, `--json` codes. Tests: `sdk/tests/error-codes.test.ts` (golden scenarios). |
| SEAM-023 | P1 | **Blocked** | No Solidity settlement contract; depends on SEAM-006/008 and a real V3 Revive runtime. The local spec-1002 Wasm emitter is only labelled chain-engine evidence. |
| SEAM-024 | P2 | **Fixed** | README, `docs/architecture.md`, `docs/submission-checklist.md` state two local chains, neither V3 hosted nor mainnet; stale counts/SHAs removed. |
| SEAM-025 | P2 | **Fixed** (docs) | `LICENSE`, `SECURITY`, `CONTRIBUTING`, `CHANGELOG`, README, `docs/SECURITY_GATES.md`, `docs/quickstart.md`, `docs/runtimeguard.md`, this file. |
| SEAM-026 | P2 | **Fixed** (CI) | `ci.yml`: `npm ci`, lint (`--max-warnings 159`, cannot grow), `format:check` over all packages, build, test, and the package-consumer smoke (`npm run smoke:pack`). Manual/weekly `e2e.yml` on a disposable local node. Unverified: real CI run of the new steps, pinned E2E binary hash. Lint still has 159 warnings, 0 errors. |
| SEAM-027 | P2 | **Open** (partial) | Done: mode badge, coverage/provenance/tx-state badges, JSON copy/download, downgrade warning, focus styles, runtime fingerprint display. Remaining gaps are listed in `docs/audit-027-028.md` (wallet rejection and tx finality UI, keyboard/responsive audit). |
| SEAM-028 | P2 | **Open** (partial) | Architecture diagram, consumer example, landing copy with no V3 claim; claim audit partly done. Gaps listed in `docs/audit-027-028.md`. Hosted/V3 status cannot be shown until V3 testing. |

## Open or Blocked, grouped

- **Open, not V3-dependent:** SEAM-019 (bind Console LIVE to SDK/chain), SEAM-027, SEAM-028 (gaps in `docs/audit-027-028.md`).
- **Blocked by V3 metadata/RPC:** SEAM-006, 007, 008, 009, 010, 011, 023. Honest compiler/SDK blockers are merged; V3 behaviour is not built.

## New open items (from the latest audit)

1. **Revive.call and Nfts.mint executable support (P0).** No complete executable argument bindings in the compiler, nor runtime-specific simulations, account mapping and outcome verifiers (`compiler/src/compile.ts`, `chain/src/preflight.ts`, `sdk/src/receipt.ts`). Needs V3 metadata (SEAM-006..010).
2. **LIVE Console not genuinely executable (P0).** `LivePanel` passes an empty request without a signature verifier or extrinsic assembler; the browser chain client returns preflight unavailable and verification unknown (`Modes.tsx`, `chainclient.ts`, `extensionsigner.ts`). Fail-closed, partial.
3. **verify-live hardening (P1).** Full planned-call comparison is optional when no Plan is given, and the atomic path does not compare the outer batch call bytes (`sdk/src/verify-live.ts`). Require plan, call and state assertions before a receipt is described as proving intended effects.
4. **Hosted V3 compatibility unverified (P0).** No V3 metadata snapshot or live evidence. Read-only V3 discovery is a development task once an RPC URL exists; funded writes belong to the testing phase.
   Pending with Bot 5: once Bot 3's `bot3/verify-live-hardening` (82f18d9) merges, `seam verify --endpoint` without `--plan` returns `unknown`; the `seam verify` docs (`docs/reference.md`, `docs/quickstart.md`, CLI help) must be updated by Bot 5.
5. **Release hygiene (P2).** Addressed in this change: this file refreshed, lint capped, format check covers all packages, consumer smoke in CI.

## Remaining external needs

- **Portaldot V3 RPC URL** (hosted testnet): needed to read metadata and runtime APIs (Revive, Nfts, Assets, Utility, signed extensions, account mapping) and unblock SEAM-006..011 and 023.
- **Funded testnet account** (faucet) and explicit test-only sign-off with spending caps: needed for the funded phase, not for build.
- **A polkadot.js browser extension signed run:** only a stand-in wallet has been used; needed for wallet proof and the real Console LIVE path (SEAM-019).
- A V3 contract deployment permission for the Solidity settlement contract (SEAM-023).

## What has been observed

- A **local Portaldot spec-1002 node**: native assets, legacy `Contracts` pallet with a hand-written Wasm emitter, three-step sequential execution, `Utility.batch_all`, rollback, and a runtime-lock mismatch. Evidence is under `evidence/`.
- A **local `substrate-contracts-node`** (disposable): `npm run test:e2e` runs against it.
- Unit and integration tests in the library packages (counts above).

Neither chain is the hosted Portaldot V3 testnet, and neither is mainnet. Success on either says nothing about V3 Revive or Nfts.

## What is unverified

- Everything about Portaldot V3: runtime metadata, call layouts, signer/account model, Revive and Nfts shapes, whether `Contracts` still exists. Nothing has been run against a hosted V3 node.
- The real polkadot.js browser extension.
- Cross-VM atomicity. `Utility.batch_all` rollback was observed on a local node only; it is not a V3 proof.
- Any funded testnet or mainnet transaction. None has been made.
- A "Fixed" row means the audit's offline/local acceptance tests pass on `main`. It does not mean V3 behaviour is verified.
