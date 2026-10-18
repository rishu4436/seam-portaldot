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

There is no dedicated drift-report command yet; the pieces above are what exists. A runtime A/B diff against fixture metadata
(SEAM-021 acceptance) has not been delivered.

## What it is not (roadmap, not delivered)

Hosted monitoring, scheduled checks, alerts or team notifications, a SaaS dashboard, SLAs, and automatic handling of runtime
upgrades. Do not describe any of these as available.
