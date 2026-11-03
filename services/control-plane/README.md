# SEAM team control plane

An authenticated, read-only-chain backend for shared evidence and scheduled Portaldot V3 runtime checks. It does not hold wallet keys, sign transactions or expose a general RPC proxy.

## Run locally

Use **Node 24.14 or later**. From the repository root, run `npm ci`, `npm run build`, and `npm run test:control-plane`. Set a randomly generated `SEAM_BOOTSTRAP_TOKEN` of at least 32 characters in the process environment, then run `node services/control-plane/src/main.mjs`.

| Variable               | Purpose                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `SEAM_BOOTSTRAP_TOKEN` | Operator credential. Keep out of browsers, source control, logs and shell history. |
| `SEAM_DATA_DIR`        | Persistent SQLite directory; `/data` on Railway.                                   |
| `SEAM_ALLOWED_ORIGINS` | Comma-separated exact browser origins. Default: the production SEAM Vercel origin. |
| `PORT`                 | Listening port, default `8080`.                                                    |

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

The volume survives service deployments. `node scripts/control-plane-admin.mjs export` saves a private logical snapshot for inspection and portability. This export is **not a complete disaster-recovery backup**: it omits key hashes, older audit entries and SQLite operational state. For full recovery, use Railway volume snapshots or an online SQLite backup and test restoring the database on an isolated service. Do not copy a live WAL database file alone. Protect backups like the original evidence. There is no implemented automatic restore/import endpoint.

Rotate an operator key by replacing `SEAM_BOOTSTRAP_TOKEN` in Railway and redeploying. Rotate a workspace owner key by issuing a new key with the same scopes, validating it, then revoking the old key. Keep the current operator credential in your password manager. Do not clear a browser execution journal to retry an uncertain transaction.

This is a hardened testnet release with automated tests and live verification evidence. Independent security review, tested infrastructure backup recovery, high availability, production incident response and mainnet approval are separate release requirements.
