# RuntimeGuard: scope

RuntimeGuard is a **narrow MVP built from existing SEAM pieces**. It is not a hosted service.

## What it is

1. **Read-only inspect.** Read a node's runtime without signing or sending: `seam snapshot <ws-endpoint> <out-dir>`
   saves metadata and runtime facts; `node scripts/testnet-run.mjs RPC_URL` (without `--yes`) writes a read-only runtime report.
2. **Fingerprint compare.** Every plan pins a runtime fingerprint (genesis hash, spec version, metadata hash). The send gate
   compares it with the live node and blocks with `runtime_changed` when it differs.
3. **Human-readable drift report.** The block names the differing fields, and `seam explain` renders results in plain English.
   Recorded example: `node scripts/gate-mainnet-plan.mjs` and `evidence/portaldot-local-node/mainnet-plan-blocked.json`
   (differing fields: `genesisHash`, `metadataHash`).

`seam drift <snapA> <snapB> [--plan plan.json]` compares two **saved** runtimes (snapshots) offline: every changed fingerprint
field (genesis, spec name and version, metadata hash, ...), and every call that was added, removed, or changed status, call
index or argument shape. With `--plan` it also says whether that plan was prepared for a different runtime than B (stale,
and it would be blocked at the send gate). Exit code 0 means no drift; drift exits 10 (`runtime_drift` in `--json`).
Recorded A/B example: the bundled Portaldot mainnet snapshot (spec 1002) against the test chain snapshot in
`packages/sdk/tests/fixtures/devnode` (spec 100) shows the changed fields and, for instance, `Revive.call` observed only on the test chain.
This is a comparison of recordings, not a live check and not monitoring.

## What it is not (roadmap, not delivered)

Hosted monitoring, scheduled checks, alerts or team notifications, a SaaS dashboard, SLAs, and automatic handling of runtime
upgrades. Do not describe any of these as available.
