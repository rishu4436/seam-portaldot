# Control-room upgrade — 3 November 2026

This records the initial control-room release. The subsequent [product audit](product-audit-2026-11-03.md) supersedes its frontend asset count and describes additional fixes, tests and deployments. The hosted build manifest now refers to that newer release.

## Implemented

- **Wallet readiness:** native free/frozen/reserved balances, existential deposit and selected asset balances at one finalized block. Integer precision is preserved. Unreadable balances stay unavailable; runtime changes require another discovery read. Amounts are explicitly shown in base units.
- **Recovery:** persistent non-secret run history, per-run read-only reconciliation and exports. Canonical finality is separate from inclusion and effect verification. Corrupt or unavailable storage blocks signing. Web Locks serialize send claims across tabs, and dedicated append-only guards survive stale journal overwrites. No automatic resend was introduced.
- **Receipt inspector:** local JSON import, portable secret-free bundles, offline integrity checks, independent browser verification against finalized V3 blocks, manifest recompilation and downloadable results. SDK and console receipt formats are supported. Missing observations remain unknown.
- **Team workspace:** Railway-hosted tenant-isolated evidence, individually scoped/revocable access keys, separate server verification, audit history and workspace exports. Browser keys remain in memory. Uploading requires an explicit disclosure acknowledgement.
- **Runtime watch:** persistent server-side scheduling with fixed live baselines, changed/unchanged/unknown outcomes, benign metadata-default drift reporting, manual checks, pause/resume and check history. A 15-minute watch is configured for the SEAM workspace. No external alerts are sent.
- **Developer integration:** public browser-safe verification exports, a reusable receipt reader that decodes each block using its parent runtime, refreshed SDK reference and a standalone protected-payment integration using public packages.
- **UI:** dedicated activity, verification, team and developer views; retained transaction drafts across navigation; execution-time editing/navigation protection; responsive navigation; accessible status messages and reduced-motion support.

## Hosted resources

Frontend: `https://seam-portaldot.vercel.app/console.html`.

Backend: `https://control-plane-production-3a6b.up.railway.app`; health at `/healthz`.

Railway project: `dff818c7-9d85-45ae-80e6-5ebcf1d8f6f3`; service: `59a67ffa-5043-44f8-a9f0-df53e2c5f6a4`. One replica uses a persistent 500 MB volume mounted at `/data`. Credentials are saved only under the ignored local `secrets/` directory, with Windows ACLs restricted to the current user, SYSTEM and Administrators. No keys appear in deployment artifacts or this report.

At the user's explicit request, Railway accepted deletion of the old `kickr` and `VYTRIX` projects, including their PostgreSQL services. Railway scheduled permanent removal for **5 November 2026 at approximately 14:00 IST**. Capacity became available immediately and the new project was created successfully.

## Verification evidence

- [Independent public-node verification](independent-verification-2026-11-03.json): a real historical V3 sequential receipt returned `chain_verified`, with both effects independently observed and the manifest recompiled against historical facts. This was a read-only check, not a new transaction.
- [Hosted backend checks](control-plane-smoke-2026-11-03.json): healthy service, allowed-origin CORS, evidence upload, independent server verification, denied reader writes, rejected revoked keys, and a scheduled `unchanged` runtime check.
- Browser QA exercised historical receipt import and independent live verification. Responsive QA found and corrected inaccessible mobile navigation for the newly added views.
- Security regression tests cover corrupt/unavailable/non-persistent journals, concurrent send claims, stale-tab journal overwrites, inclusion versus finality, plan tampering, secret-bearing evidence, tenant isolation, credential scopes/revocation and oversized upstream responses.

The final deployment manifest records the exact hosted frontend assets and the completed check totals. Previous devnode and contract checks remain recorded in [the earlier deployment report](deployment-2026-11-03.md); no new Rust contract behavior was introduced here.

Final checks: **1,984 passing tests** across compiler (359), policy (452), SDK (477), chain (395, including the added runtime-drift regression) and console (293), plus the backend (8). The main chain suite retains 13 opt-in skips. **All 3 disposable-chain end-to-end checks passed again on Linux**, including strict sequential execution and batch rollback. Linux build, package-consumer smoke and all 20 runnable quickstart commands passed (9 documented setup/network skips). Lint has zero errors/warnings, formatting passes, and npm audit reports zero findings. The protected-payment example also passes JavaScript type checking.

The initial build had 42 matching files; the [hosted build manifest](control-room-build-2026-11-03.json) now records the subsequent audit release. The [persistence check](control-plane-persistence-2026-11-03.json) confirms that evidence, credentials and runtime watches survived the backend redeployment. Live browser checks confirmed authenticated team access and displayed the stored chain-verified receipt and scheduled runtime result, with no browser errors.

## Validation scope

This report describes the initial release and its historical validation. Subsequent wallet-signed runs and their independently checked V3 executions are documented in [live QA](live-qa-2026-11-06.md). Historical receipts, automated tests and read-only checks remain distinct from newly authorized wallet transactions. Mainnet support, a formal security audit and high availability are outside this testnet release.
