# Evidence

## evidence/devnode: real runs on a LOCAL dev chain, NOT Portaldot

Every transaction here ran on a local **substrate-contracts-node v0.42.0** started with `--dev`, at
ws://127.0.0.1:9944. It is a throwaway dev chain (genesis 0xe8cf5d7d…b208, spec `substrate-contracts-node` 100,
metadata V14, instant seal). It is **not** Portaldot mainnet or testnet, and nothing here was sent to Portaldot.
Signing used the public //Alice dev account. These files hold no signatures, signed extrinsics, seeds or keys:
the scripts refuse to write them, and the older runs had their signing-request signatures removed when copied here
(marked `redacted`).

| File | What |
|---|---|
| `substrate-contracts-node-spec100-snapshot.json`, `-metadata.hex` | Read-only snapshot of the node: runtime version, genesis, signed extensions, RPC methods, fingerprint digest. Token UNIT/12 is `declaredToken` (the node reports no properties). |
| `devnode-facts-summary.json` | Fingerprint and the capabilities SEAM uses. |
| `state.json`, `runs/setup-*.json` | Setup as //Alice: asset 1 created and minted, Bot 2's demo ink! contract (`contracts/seam-demo/artifacts/seam_demo.contract`) deployed; its address and deploy tx are in `state.json`. Older setup files used the hand-written `seam_emitter` stand-in. |
| `runs/sequential-*.json` | transfer, contract call (`settle` by message name + ABI; verified by its `ContractEmitted` event), mint, one transaction per step. Strict policy; each step gated just before sending (fresh fingerprint and that step's own dry run). |
| `runs/atomic-*.json` | The same three steps in one `Utility.batch_all` (`atomic_verified`, based on the rollback run it names). |
| `runs/rollback-*.json` | `batch_all` whose step 2 overdraws. SEAM's gate blocks it (`signed_dry_run_failed`). The same signed bytes, then sent directly as a test-only bypass, fail as a whole: no inner events, balances unchanged, only the fee charged. |
| `runs/failed-attempts/` | Two early runs that exposed bugs (storage key, signing checkpoint), kept for the record. |
| `ASSUMPTIONS.md` | Spec-1002 / metadata-V13 assumptions this chain exposed. |

Recordings since the gate-passed change use the tightened policy: `allowedSelectors`, `allowedMessages` (`settle`) and `pinnedAbiHashes` for the seam_demo contract, and no `maxStorageDeposit` (the step sets `storageDepositLimit: null`). The `message_allowed`, `abi_pinned` and `selector_allowed` results are policy rules, so they are in `policyResult.rules`; the gate's `passed` list holds the submit-time checks (`step_order`, `approval_*`, `runtime_unchanged`, `signed_bytes_match`, `signed_dry_run_ok`).

Runs recorded since the demo contract was deployed use the ABI form for the contract step (no raw hex, no script patching of `Contracts.call`); earlier ones used a raw `data` call through a script shim.

Runs with `recordingVersion: 2` contain the full Manifest, the runtime facts and fingerprint, the policy, the
rule-by-rule policy result, the preflight (with proof size), the signing envelope, the approval, the signing
requests (payload and exact sign bytes, no signature) and one `gateChecks[]` entry per SDK `onStep` event that carries a gate result (`check`: `ok`, `reasons`, and `passed`, the checks that passed with stable codes), with the dry run details. Nothing is recomputed: the gate result is the SDK's own. Older recordings recomputed it. They also hold the SDK step log,
node status history, decoded events per step, the receipt, and for rollback the direct submission and the
before/after balances. Older files (no `recordingVersion`) have the Manifest digest only.

Tx hashes and block hashes exist only on that local chain; restarting it with `--fresh` makes a new one.

### Reproduce

```sh
npm install && npm run build --workspaces
cd packages/chain
scripts/devnode.sh start --fresh            # downloads + sha256-checks the binary, ws://127.0.0.1:9944
node scripts/devnode/snapshot.mjs
node scripts/devnode/setup.mjs
node scripts/devnode/run-sequential.mjs
node scripts/devnode/run-rollback.mjs
node scripts/devnode/run-atomic.mjs <path of the rollback-*.json just written>
# or all of it as tests: npm run test:devnode
```

Scripts write to /workspace/seam-evidence/devnode and to this folder (`SEAM_EVIDENCE_DIR`, `SEAM_REPO_EVIDENCE_DIR`).
They refuse any endpoint other than localhost, and the Portaldot mainnet genesis.

## Portaldot mainnet

The read-only mainnet snapshot (spec 1002, metadata V13, block 2,721,455) is `fixtures/portaldot-mainnet-snapshot.json`
and `fixtures/portaldot-mainnet-metadata.hex` at the repo root. Nothing was ever submitted to mainnet.
