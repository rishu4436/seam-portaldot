# SEAM team control plane

An authenticated, read-only-chain backend for shared evidence and scheduled Portaldot V3 runtime checks. It does not hold wallet keys, sign transactions or expose a general RPC proxy.

## Run locally

Use **Node 24.14 or later**. From the repository root, run `npm ci`, `npm run build`, and `npm run test:control-plane`. Set a randomly generated `SEAM_BOOTSTRAP_TOKEN` of at least 32 characters in the process environment, then run `node services/control-plane/src/main.mjs`.

| Variable                                                                    | Purpose                                                                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `SEAM_BOOTSTRAP_TOKEN`                                                      | Operator credential. Keep out of browsers, source control, logs and shell history.                                    |
| `SEAM_DATA_DIR`                                                             | Persistent SQLite directory; `/data` on Railway.                                                                      |
| `SEAM_ALLOWED_ORIGINS`                                                      | Comma-separated exact browser origins. Default: the production SEAM Vercel origin.                                    |
| `PORT`                                                                      | Listening port, default `8080`.                                                                                       |
| `SEAM_RPC_ENDPOINTS`                                                        | Optional comma-separated trusted HTTPS/WSS read endpoints (maximum four). Defaults to the observed V3 HTTPS/WSS URLs. |
| `SEAM_BACKUP_ENCRYPTION_KEY`                                                | Random 32-byte key encoded as 64 hexadecimal characters. Store a recovery copy outside the hosting account.           |
| `SEAM_BACKUP_S3_ENDPOINT`, `SEAM_BACKUP_S3_BUCKET`, `SEAM_BACKUP_S3_REGION` | Private S3-compatible backup destination.                                                                             |
| `SEAM_BACKUP_S3_ACCESS_KEY_ID`, `SEAM_BACKUP_S3_SECRET_ACCESS_KEY`          | Server-only bucket credentials; use Railway bucket references.                                                        |
| `SEAM_BACKUP_S3_PATH_STYLE`                                                 | Set `true` only for a bucket requiring path-style URLs.                                                               |
| `SEAM_BACKUP_INTERVAL_SECONDS`, `SEAM_BACKUP_KEEP`                          | Default six hours and the latest 28 verified backups.                                                                 |

The Railway service uses `services/control-plane/Dockerfile`, one replica, a persistent `/data` volume, `/healthz` health checks and disabled application sleeping. `RAILWAY_DOCKERFILE_PATH` explicitly selects the Dockerfile. The process drops root privileges before opening the database. Do not scale this SQLite service to multiple replicas or attach the volume to a second writer. The configured Railway volume is 500 MB.

## Access and privacy

Create workspaces with the operator credential through `POST /v1/workspaces`. The response contains a workspace owner key once. `node scripts/control-plane-admin.mjs setup` performs this initial setup and creates a 15-minute runtime watch, writing credentials to ignored local files. Set `SEAM_CONTROL_URL` to use a different deployment. The script refuses to overwrite an existing team access file.

The console accepts workspace keys only and keeps them in memory. Each key belongs to one workspace. Keys are stored as SHA-256 hashes, can be individually revoked, and carry explicit scopes. Issue reader or contributor keys to teammates instead of distributing the owner key. TLS, possession of the key and the hosting account are the trust boundary; there is no SSO, password recovery, browser-persisted login or public anonymous evidence library.

Uploading evidence is an explicit action. Bundles contain public wallet addresses, transaction references, compiled call data, manifests and optional ABI data. Do not include private business data in a receipt intended for teammates. Signed bytes, signatures, raw metadata, seed phrases and recognized secret fields are rejected. Storage does not establish verification: newly uploaded records are labelled unverified until a separate server check finishes.

## API

All routes except `GET /healthz` require `Authorization: Bearer <key>`. Responses include a request ID and are not cached. Workspace routes begin with `/v1/workspaces/:workspaceId`.

| Route                       | Required scope                     | Behavior                                                                                         |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /v1/session`           | Any valid key                      | Current workspace and scopes.                                                                    |
| `GET/POST /evidence`        | `evidence:read` / `evidence:write` | List or store a portable bundle.                                                                 |
| `GET /evidence/:id`         | `evidence:read`                    | Download a stored bundle and its separate verification result.                                   |
| `POST /evidence/:id/verify` | `evidence:write`                   | Independently read V3 finality, canonical blocks, extrinsics and events; recompile the manifest. |
| `GET/POST /monitors`        | `monitor:read` / `monitor:write`   | List watches or establish a baseline from the live node.                                         |
| `GET /monitors/:id`         | `monitor:read`                     | Baseline and latest 100 checks.                                                                  |
| `POST /monitors/:id/check`  | `monitor:write`                    | Run a read-only check now.                                                                       |
| `PATCH /monitors/:id`       | `monitor:write`                    | Set `{ "enabled": false }` to pause, or `true` to resume.                                        |
| `GET/POST /keys`            | `keys:write`                       | List key metadata or issue a scoped key.                                                         |
| `POST /keys/:id/revoke`     | `keys:write`                       | Revoke a key immediately.                                                                        |
| `GET /audit`                | `keys:write`                       | Latest 200 audit entries.                                                                        |
| `GET /export`               | `keys:write`                       | Workspace evidence, monitor checks and recent audit entries, without access keys.                |

Payloads are limited to 512 KiB, 16 actions, 24 nesting levels and 20,000 values. Each workspace allows 500 evidence records, 64 MiB of evidence, 50 monitors and 50 active keys. The operator can create at most 10 workspaces. Requests are rate limited; independent verification allows 10 requests per workspace per minute and one active verification across the instance. The fixed upstream permits read methods only, validates JSON-RPC response IDs, limits responses to 8 MiB and applies deadlines. It cannot submit a transaction or fetch an arbitrary URL supplied in evidence.

## Monitoring and recovery

The worker wakes every 15 seconds and processes at most two due watches. Allowed watch intervals are 5 minutes to 24 hours. A lease prevents overlapping checks. Changes in genesis, spec name/version, transaction version or metadata layout produce `changed`. Raw metadata-only drift is recorded separately. Node failures produce `unknown`; they never produce a healthy result. The baseline stays fixed so drift remains visible. Checks run when the service is running even if no browser is open. This release displays results in the console; it does not send email, chat, SMS or push alerts.

The volume survives service deployments. `node scripts/control-plane-admin.mjs export` saves a logical workspace snapshot; it is not a complete service backup. The implemented backup worker uses Node's online SQLite backup API, preserving consistent WAL state, all workspaces, key hashes/revocations, evidence, monitors and audit records. It encrypts snapshots with AES-256-GCM before upload to a separate private Railway bucket. Every successful backup is downloaded, authenticated, checksum checked and restored into an isolated temporary database for SQLite integrity and foreign-key checks before old objects are pruned. The default is startup plus every six hours, retaining the latest 28 verified copies (normally about seven days; extra deployments create extra copies). Failures preserve the last success time and do not prune known-good backups.

Operator-only `GET /v1/operations/backups` returns schedule, last success/failure, object key and isolated restore proof. `POST` triggers a single-flight backup. Workspace keys receive 403. There is deliberately no HTTP route that can replace the live database. Database snapshots above 90 MiB fail the configured backup memory/disk budget; monitor this operator endpoint and adjust infrastructure/budgets before reaching that size.

### Restore runbook

1. Keep the backup encryption key in a secure recovery location outside Railway. The local deployment copy is in the ignored, access-restricted `secrets/control-plane-backup-key.txt`. Losing every copy of this key makes the encrypted backups unrecoverable.
2. Use the operator environment with the bucket variables above. `node services/control-plane/src/backup-cli.mjs list` lists encrypted object keys. `download <object-key> <new-local-file>` saves one without overwriting an existing file. Keys are read only from environment variables, never command arguments.
3. Run `node services/control-plane/src/backup-cli.mjs verify --file <encrypted-file>` to authenticate/decrypt and check an isolated database. Run `restore --file <encrypted-file> --to <new-database-path>` to create a new SQLite file. Both commands also accept `--object <object-key>` instead of `--file`. Restore refuses every existing destination, including the live database.
4. Validate the restored file through an isolated API with monitor workers disabled: check workspace login, evidence, monitor history, audit history and revoked keys. `scripts/verify-resilience-release.mjs` performs this drill using the deployed backup and ignored local operator inputs, without replacing production. Its public report contains counts/checksums only; restored databases and encrypted downloads stay under `secrets/`.
5. Promote only during a controlled maintenance window after stopping the original writer and preserving its current volume/snapshot. Review changes made since the backup, especially **keys revoked after the snapshot**: rotate/revoke workspace credentials before exposing a restored service. Keep the operator credential external to the database. Validate access, health and backup scheduling before reopening traffic. Never point two writers at the same SQLite file or clear browser send guards to replay uncertain transactions.

RPC failover permits read methods only and validates genesis, spec name, spec version and transaction version on candidates. A runtime-version disagreement stops the reader and requires discovery again. Transport attempts and verification deadlines are bounded. The default HTTPS and WebSocket URLs share a Portaldot host/operator; this does not provide independent-node redundancy. Operators can configure additional trusted providers through `SEAM_RPC_ENDPOINTS`. Signed submissions are not exposed by this backend.

Rotate an operator key by replacing `SEAM_BOOTSTRAP_TOKEN` in Railway and redeploying. Rotate a workspace owner key by issuing a new key with the same scopes, validating it, then revoking the old key. Keep the current operator credential in your password manager. Do not clear a browser execution journal to retry an uncertain transaction.

This testnet release includes automated checks and an actual encrypted backup/isolated restore drill. Independent security review, independent-provider redundancy, high availability, production incident response and mainnet approval remain separate requirements.
