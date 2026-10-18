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

## Reporting a problem

No formal disclosure process exists yet. Until one is added, open a GitHub issue without exploit details and contact the
maintainer through the repository.
