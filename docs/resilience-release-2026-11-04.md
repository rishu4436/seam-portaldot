# Resilience release — 4 November 2026

Implemented and deployed the three remaining infrastructure improvements.

- **RPC fallback:** a shared browser/Node read transport with bounded retries, response-ID and size checks, operation deadlines and per-provider network/runtime validation. Wrong networks are excluded; runtime version disagreement stops the reader. Submission bypasses the retry pool and remains a single primary-transport attempt. Default HTTPS and WSS use the same official host, so they provide transport/path fallback, not independent-node availability. Additional trusted backend providers can be configured explicitly.
- **Receipt recovery:** single and multi-step wallet receipts are automatically saved in a separate IndexedDB archive with strict write durability. Portable records include plan, manifest and runtime context. Activity can reopen/export/restore them; imports validate every receipt before a single write transaction, deduplicate runs and preserve newer local revisions. Invalid/secret-bearing input is refused. Storage failure is visible, with a direct-download fallback. The archive allows 100 receipts/32 MiB; users can export and remove a local copy. No archive operation changes the execution journal or send guards.
- **Backups and restore:** a consistent online SQLite snapshot, compressed and authenticated/encrypted with AES-256-GCM, uploaded to a private bucket separate from the database volume. Startup and six-hour backups retain 28 successful snapshots. Each remote object is downloaded and restored in isolation before pruning. Full workspace data, hashed credentials/revocations, evidence, monitors/checks and audit records are preserved. Restore only creates a new file and refuses existing destinations. Operator-only endpoints expose health/manual backup; workspace keys cannot access service backups.

## Live evidence

The [forced-fallback check](rpc-failover-live-2026-11-04.json) disabled the primary HTTPS transport and independently verified a genuine historical two-action V3 receipt over WSS. No signing or submission occurred.

The [encrypted backup drill](resilience-live-2026-11-04.json) downloaded a real hosted snapshot, restored it to an isolated local SQLite database and tested it through an isolated HTTP API. Login worked, evidence and monitor history were present, revoked keys stayed revoked, and workspace access to the operator backup route returned 403. The live database was never replaced. Encryption keys, bucket credentials, encrypted downloads and restored databases remain under ignored, access-restricted `secrets/` files.

Production browser QA restored an archive, refreshed, reopened its receipt with intact plan/manifest binding, exported the archive and independently verified the receipt against live V3 blocks. This used public historical evidence, not a fresh wallet transaction. [Frontend asset hashes](resilience-build-2026-11-04.json) match all 34 hosted files. Recovery layout at 390 × 844 had no horizontal overflow. See [recovery UI proof](receipt-recovery-live-2026-11-04.png), [verification proof](receipt-recovery-verified-2026-11-04.png), and [the wallet acceptance checklist](live-wallet-test-2026-11-04.md).

Local checks passed: **400 chain tests**, **313 console tests**, **13 control-plane tests**, root build, zero-warning lint and formatting. The chain suite retains 13 opt-in skips. The remaining compiler/policy/SDK suites are unchanged and run again in release CI. New regressions cover failover identity/runtime/deadlines, forbidden submission retries, receipt archive reopening/atomic imports/secret rejection, current-versus-old revisions, missing storage, encrypted remote read-back, tampering/wrong keys, retention, existing-target refusal, full restored data/authentication and operator-only backup access.

Frontend: `dpl_EA4RfTXrsNQ9BdHLLQCiSWFKLu27`.

Backend: `4dfeaf09-9eda-4974-9d0e-1ed6bd0aa272`.

Backup bucket: `seam-encrypted-backups` in the existing Railway project, provisioned in Singapore. The schedule is six hours; retention is a count of 28 verified snapshots, not an immutable seven-day retention guarantee. Protect the independent recovery copy of the encryption key. A snapshot restore can roll back revocations made after that snapshot, so credential review/rotation before public promotion is part of the [restore runbook](../services/control-plane/README.md#restore-runbook).

The implementation follows the [Node SQLite online backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsourceDB-path-options) and [Railway's private S3-compatible bucket guidance](https://docs.railway.com/storage-buckets). It does not claim independent security audit status, multiple independent RPC operators, or a new wallet-authorized transaction.
