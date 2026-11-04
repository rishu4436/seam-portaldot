# Wallet acceptance and follow-up — 4 November 2026

The user completed all ten wallet acceptance steps. A one-base-unit transfer of asset 806707 finalized in block **320764** with transaction hash `0x18ee9304902698921505fe7e1eb012e0a4cdc797d4c8c7514337d17c5f04fd52`. The reported recipient is `5CwFE91fBsdTSAAcnbn2cSu8iCmeQHYtB9wakzPCJv1QVr5G`.

The user reported correct approval invalidation, rejection without submission, finality/effect verification, refresh recovery, independent receipt verification (13 passing checks, two not checked), archive removal/restoration and deduplication. This is user-reported wallet acceptance. Separately, the [public-node read](acceptance-chain-2026-11-04.json) confirmed canonical finalized inclusion, decoded the `assets.transferKeepAlive` call for asset 806707/amount 1, and read matching `Assets.Transferred` and `System.ExtrinsicSuccess` events. That read is narrower than the full receipt verifier and does not repeat every wallet interaction.

The initial signed dry run rejected an unfunded recipient with a `Token` error. Asset 806707 is not self-sufficient; after the recipient received native tPOT, the transfer passed. The earlier checklist did not make this prerequisite explicit enough. [The acceptance guide](live-wallet-test-2026-11-04.md) now states it directly.

## Follow-up fixes

- The proof table now receives the same finalized effect-verifier result as the receipt. It updates to Verified when the effect is proven and clears on a new plan/run. It does not upgrade raw transaction provenance or stale/unfinalized results.
- Definitely-unsent rejected/blocked attempts are finalized in the journal immediately. Wallet rejection leaves the approval unused. Reload distinguishes an unsigned session ending from discarded signed bytes; closed unsent attempts stay in audit history with plain labels and are excluded from the reconciliation-needed panel. Same-tab journal changes refresh Activity immediately. Existing send claims and possible broadcasts cannot be rewritten as unsent.
- Archive restoration announces the number of checked/merged receipts, deduplication and that nothing was submitted. Invalid imports still fail atomically.
- Token dispatch errors preserve their runtime sub-error (for example `Token.CannotCreate`). User-facing hints explain possible sender balance and native recipient funding issues without asserting an unobserved cause. Asset balance observations include the runtime's self-sufficiency flag and display its funding prerequisite.
- Cold metadata reads receive a bounded 12-second allowance. Read-only builder discovery retries once after transient RPC failures, uses a fresh connection pool and displays the retry. Each default discovery pass has a 25-second budget. Declared network mismatches and compile/build failures are not automatically retried. Signing/submission are unaffected by discovery retries.

Regression coverage exercises effect-result propagation and stale callbacks, rejection journal updates and unused approvals, pending-session recovery, preserved send claims, multi-step rejection before broadcast, archive confirmation, transient discovery retry versus mismatch, token sub-error decoding and funding hints. This release cannot guarantee public-node availability; the observed timeout's exact cause was not established.

A separate workspace contributor credential was prepared in an ignored, access-restricted local file for Team acceptance. It permits evidence and monitor operations, and cannot manage keys or service backups. No wallet credentials, server keys or backup secrets appear in this report.

## Release validation

- Local build, lint with zero warnings and full formatting check passed. The console suite passed 322 tests, the chain suite passed 401 tests (13 opt-in tests skipped), and the backend suite passed 13 tests.
- The [deployed asset manifest](feedback-build-2026-11-04.json) matched all 34 files to the local build. The production alias is [the live console](https://seam-portaldot.vercel.app/console.html).
- Frontend deployment: `dpl_GbGSSjS9B7iLj96AgpngDWdzqwua`. Railway deployment: `37a65b03-0e8f-4d4d-9e5f-4b2afb1258fe`, online with one healthy replica and no pending work.
- [Live checks](feedback-live-2026-11-04.json) confirmed backend health, a healthy encrypted backup after deployment, contributor authentication and denial of key-management/operator-backup access. Browser checks confirmed archive restoration feedback and access to shared evidence and runtime monitors. The QA session was disconnected afterward.
- [Archive confirmation screenshot](wallet-feedback-live-2026-11-04.png) and [Team workspace screenshot](team-access-live-2026-11-04.png) record the deployed UI. No new transaction was signed during these follow-up checks; effect and journal changes were covered by component and store regressions.

For the remaining Team acceptance test, connect in Team workspace using the separate contributor credential, import the finalized receipt in Receipt inspector, explicitly consent to sharing its public transaction data, upload it, request server verification, then refresh and download it. Check the existing runtime watch and its history; avoid creating a duplicate watch. Refreshing the page should disconnect the session until the key is entered again.
