# Product and correctness audit — 3 November 2026

This follow-up examined the live product after recording instructions were accidentally exposed in its developer page. Scope: customer copy and links, production assets, wallet selection, asynchronous form and receipt state, sharing consent, verification semantics, credentials, persisted server results, navigation and balance presentation. The confirmed findings below were fixed and deployed to Vercel and Railway.

This is a source review with regression tests and browser/live-node checks, not a formal security audit or proof that every possible defect has been eliminated. Priority reflects user impact in this testnet application. P1 does not imply unauthorized fund movement was demonstrated.

## Confirmed findings

| Priority | Trigger and problem | Deployed fix and validation |
| --- | --- | --- |
| P1 | A previous receipt verification finishes after the imported receipt changes, potentially showing a result beside the wrong receipt. | Bind results to the exact bundle and request generation. Deferred-result and out-of-order import tests discard old results. |
| P1 | Sharing consent stays checked after another receipt is imported. | Reset consent on bundle/workspace changes; display signer and plan digest beside upload. Regression and live browser checks confirmed unchecked consent and disabled upload for the new receipt. |
| P1 | The selected account belongs to a second wallet extension, but signing/watching opens the first. | Carry provider identity through selection, watching and signing; distinguish duplicate addresses and normalize SS58 keys. Reproduced the original failure. Five provider regressions cover these cases and prevent silent fallback from an explicitly chosen provider. No real signature was requested. |
| P2 | Runtime reads or compiles finish after the URL/account/transaction changes. | Invalidate pending generations and discard stale results. Runtime and compile race regressions passed. |
| P2 | A slow manifest import overwrites a newer import or a manually edited amount. | Discard stale file completions; catch file errors and enforce size limits. The regression covers newer files and manual edits. Export object URLs are revoked after use. |
| P2 | Revoking the current workspace key accidentally locks out the current browser. | Backend identifies the current key; UI disables its revoke button. Component and live browser checks passed. This is a UI guard; deliberate API self-revocation remains possible. |
| P2 | A stored successful receipt retains its old badge when a recheck throws. | Persist an incomplete result and fresh server timestamp; show last-checked time separately from upload time. Backend outage regression passed. A real RPC timeout displayed incomplete; a later recheck passed. |
| P2 | Partial chain-checked execution receives the same positive badge as fully verified execution. | Separate labels/tones for verified, partial, failed, incomplete and integrity-only results. Include the receipt claim in stored listings. Status tests passed. |
| P2 | SDK detects tampering, then a failed finalized-head RPC downgrades the outcome to unknown. | Preserve failed when integrity problems are already known. SDK regression combines a changed plan with an unavailable finalized head. |
| P2 | Sharing checkbox inherits a general input flex rule and collapses to zero width. | Explicit non-shrinking checkbox sizing and label spacing. Live DOM measured the original at 0 px and the final control at 18 × 18 px; ordinary check/uncheck now works. |
| P2 | Public navigation exposes recorded QA tools and static historical examples in the transaction product. | Legacy lab is development-only; remove public links and static evidence section. Explicit receipt import remains available. Recording instructions stay in repository docs. Production assets contain no legacy recording chunks or those navigation strings. |
| P2 | Source/docs target stale main, while integration copy leaves SDK distribution unclear. | Link to release source, document repository distribution/build steps and use actual verifier imports. Landing Developers opens the hub. GitHub API confirmed referenced README, SDK docs and example exist. |
| P3 | Refresh and Back/Forward lose the selected workspace view. | URL-based views, history handling and page titles; preserve execution-time guards. Regression plus browser direct-link, Back/Forward and mobile navigation checks passed. |
| P3 | Raw native balances and “existential deposit” are difficult to interpret. | Exact token-decimal formatting, visible raw base units and plain minimum-balance label. Asset amounts remain explicitly in base units. Large-integer and one-base-unit tests passed. |

## Validation

Final suites: **2,002 passing tests** — compiler 359, policy 452, SDK 478, chain 395, console 309, control plane 9. The chain suite retains 13 opt-in skips. Root build, zero-warning lint and formatting passed; dependency audit reported zero findings.

All **34 production frontend files** match the local build byte-for-byte; required response headers are present. See [asset manifest](control-room-build-2026-11-03.json). Total uncompressed artifact size fell from **2,188,881 to 1,605,544 bytes**, a **26.65%** reduction. This measures all deployed files, not initial-page transfer or time to interaction.

A genuine historical two-action V3 receipt passed offline integrity and independent live-chain verification in the browser. A deliberately changed call failed its plan digest locally and disabled live verification. Existing workspace login, evidence, keys and scheduled monitor survived redeployment. The final server recheck returned `chain_verified` with matching persisted timestamps: [backend result](product-audit-live-2026-11-03.json), [live UI proof](product-audit-live-2026-11-03.png). No new evidence or keys were created during this audit.

Responsive checks at 390 × 844 found no horizontal page overflow in the receipt inspector, transaction builder or final team workspace. Mobile navigation and missing-wallet feedback worked. The final sharing checkbox was checked and unchecked live. UI receipt-race unit tests partially mock SDK integrity checking; real hashing is separately covered by the SDK suite and actual browser receipt import. No production verifier is mocked.

One offline chain test timed out in the first broad run. Its complete nine-test file passed immediately without changes; the full suite was rerun without weakening the timeout or assertions.

Frontend deployment: `dpl_HM5Pm46qHnpSsx4DrgudP1hyQzAC`.

Backend deployment: `a146ffb1-bf0b-4c41-bbfa-897ae63ea660`.

## Remaining limits and next improvements

1. **Fresh funded-wallet validation:** mocked providers and historical evidence do not substitute for a new user-authorized testnet run. Test extension rejection/account switching, submission, refresh recovery and the resulting receipt with a funded wallet.
2. **RPC availability:** a real node timeout was observed. Add measured read-only retries and trusted endpoint failover with the same network/runtime checks. Never automatically retry submission. One public endpoint does not establish an availability guarantee.
3. **Receipt recovery:** the local journal preserves guards and reconciliation state, not a complete portable receipt. Add an explicitly disclosed local receipt archive with schema checks and export/import recovery, separate from duplicate-send guards.
4. **Disaster recovery:** persistence survived deployment, but the backend has one replica/volume. Add encrypted scheduled backups, retention, a restore drill and explicit recovery objectives. Workspace JSON export is not a full service backup.
5. **Team identity:** access is operator-provisioned scoped bearer keys, not SSO/account recovery or a mature organization lifecycle. Define ownership and credential rotation before adding those flows; keep the operator key out of browsers.
6. **Adoption:** observe first-time users completing funding, construction, policy review, verification and recovery. Measure failure causes before adding more dashboards. Publish a versioned SDK after someone independently reproduces the integration; current distribution is through this repository.

No new unauthorized-signing or fund-movement bypass was demonstrated. This is not a claim of mainnet readiness, formal audit status or absence of vulnerabilities. Rust contracts, devnode E2E and package-consumer smoke were unchanged and not newly rerun in this follow-up; their earlier results remain in the [initial release report](control-room-release-2026-11-03.md).
