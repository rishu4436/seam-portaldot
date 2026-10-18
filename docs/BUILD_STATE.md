# SEAM build state

Factual status of the hardening work, tracked against the audit of `main` at `a3bc52b`. Statuses are one of
**OPEN** (not started), **IN PROGRESS** (owner named), **BLOCKED by V3 metadata** (cannot be finished honestly until the
hosted Portaldot V3 runtime metadata is read), or **DONE** (merged to `main` with tests; none are marked DONE here yet).
Update this file in the same commit that changes a status.

Baseline: `main` at `a3bc52b`. Recorded CI outcome at baseline: compiler 111, policy 68, SDK 63, chain 59 passing, 12 skipped.

## Issue table

| ID | Topic | Priority | Status | Owner |
|----|-------|----------|--------|-------|
| SEAM-001 | Signed tx not independently bound to the approved signing request at the SDK boundary | P0 | IN PROGRESS | Bot4 |
| SEAM-002 | Sequential flow can advance on unverified effect (flow) | P0 | IN PROGRESS | Bot4 (flow) |
| SEAM-002 | Sequential flow can advance on unverified effect (`canRunNextStep` policy) | P0 | IN PROGRESS | Bot3 (policy) |
| SEAM-003 | Offline `seam verify` proves only self-consistency | P0 | IN PROGRESS | Bot5 |
| SEAM-004 | Contract outcome verification overclaims the requested effect | P0 | IN PROGRESS | Bot5 |
| SEAM-005 | Approval use not durable; consumed before confirmed submission | P0 | IN PROGRESS | Bot3 |
| SEAM-006 | `revive.call` compiler encoder missing | P0 | BLOCKED by V3 metadata | Bot2 |
| SEAM-007 | `nfts.mint` encoder missing | P0 | BLOCKED by V3 metadata | Bot2 |
| SEAM-008 | Revive dry-run, address mapping, ABI and state APIs missing | P0 | BLOCKED by V3 metadata | Bot4 |
| SEAM-009 | V3 signer and account-domain model unproven | P0 | BLOCKED by V3 metadata | Bot4 |
| SEAM-010 | V3 verifiers for Revive and Nfts missing | P0 | BLOCKED by V3 metadata | Bot5 |
| SEAM-011 | V3 runtime discovery and fingerprint schema need extension | P0 | BLOCKED by V3 metadata | Bot2 |
| SEAM-012 | `atomic_verified` relies on caller-supplied evidence | P1 | IN PROGRESS | Bot2 |
| SEAM-013 | Atomic preference silently degrades to sequential | P1 | IN PROGRESS | Bot2 |
| SEAM-014 | Contract deploy is outside policy | P1 | IN PROGRESS | Bot6 (documented as a limitation; no behaviour change) |
| SEAM-015 | Event decode tied only to spec version at inclusion | P1 | IN PROGRESS | Bot4 |
| SEAM-016 | Signing checkpoint, nonce and expiry recovery | P1 | IN PROGRESS | Bot4 |
| SEAM-017 | Strict policy proof coverage across all action types | P1 | IN PROGRESS | Bot3 |
| SEAM-018 | Whole-plan simulation coverage must be reported honestly | P1 | IN PROGRESS | Bot4 |
| SEAM-019 | Live browser Console is not operational (recorded/synthetic adapters) | P1 | IN PROGRESS | Bot1 |
| SEAM-020 | Public SDK and CLI distribution | P1 | IN PROGRESS | Bot5 |
| SEAM-021 | RuntimeGuard is not a hosted product | P1 | IN PROGRESS | Bot6 (scope doc: `docs/runtimeguard.md`) |
| SEAM-022 | Stable developer error codes | P1 | IN PROGRESS | Bot5 |
| SEAM-023 | Solidity settlement demo contract for V3 | P1 | BLOCKED by V3 metadata | unassigned |
| SEAM-024 | Contradictory network/evidence copy in docs | P2 | IN PROGRESS | Bot5 |
| SEAM-025 | License and maintenance documents | P2 | IN PROGRESS | Bot6 (LICENSE, BUILD_STATE, SECURITY_GATES added; CHANGELOG and disclosure policy still OPEN) |
| SEAM-026 | CI quality and reproducibility | P2 | IN PROGRESS | Bot6 |
| SEAM-027 | Console usability and labels | P2 | IN PROGRESS | Bot1 |
| SEAM-028 | Adoption readiness: usage example, diagram, honest status | P2 | IN PROGRESS | Bot1 |

SEAM-023 had no owner in the assignment; it depends on SEAM-006/008 and a real V3 runtime.

## What has been observed

- A **local Portaldot spec-1002 node**: native assets, legacy `Contracts` pallet with a hand-written Wasm emitter, three-step
  sequential execution, `Utility.batch_all`, rollback, and a runtime-lock mismatch. Evidence is under `evidence/`.
- A **local `substrate-contracts-node`** (disposable): the end-to-end script `npm run test:e2e` runs against it.
- Unit and integration tests in the four library packages (counts above, as recorded by CI at baseline).

Neither chain is the hosted Portaldot V3 testnet, and neither is mainnet. Success on either says nothing about V3 Revive or Nfts.

## What is unimplemented

- `revive.call` and `nfts.mint` encoders (SEAM-006, 007), Revive dry-run/address mapping/ABI handling (SEAM-008),
  Revive and Nfts verifiers (SEAM-010).
- A `contracts.instantiate` / deploy action in the compiler and policy (deploy is a setup step, see SEAM-014).
- A Console path that drives the real SDK with an extension wallet (SEAM-019). The Console currently uses recorded or synthetic data.
- Chain-verified receipts: `seam verify` is integrity-only until SEAM-003 lands.
- Durable approval storage (SEAM-005) and a Solidity settlement contract (SEAM-023).
- Hosted RuntimeGuard monitoring, alerts or SaaS. These are roadmap only.

## What is unverified

- Everything about Portaldot V3: runtime metadata, call layouts, signer/account model, Revive and Nfts shapes,
  whether `Contracts` still exists. Nothing has been run against a hosted V3 node.
- The real polkadot.js browser extension (only a stand-in wallet has been used).
- Cross-VM atomicity. `Utility.batch_all` rollback was observed on a local node only; it is not a V3 proof.
- Any funded testnet or mainnet transaction. None has been made.
- Fixes in progress above are not verified until merged with tests; this table records intent and ownership, not results.
