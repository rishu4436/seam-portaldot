# Local Portaldot dev node recordings (NOT the V3 testnet, NOT mainnet)

Everything in this folder came from the organizers' own dev node binary running **on this machine**, with a throwaway
chain (`--dev --tmp`, state deleted on exit). It is **not** the V3 testnet and **not** Portaldot mainnet. The only key
used is the public `//Alice` dev account, as a local test signer. No seeds, keys or signatures are recorded.

- Binary: `portaldot-testnet-ubuntu.tar.gz` from github.com/portaldotVolunteer/Portaldot-node (raw/main),
  sha256 `9df4d6332e84ab81707b5d2e3376c572f058eac4212bd99ba6f1908b75a6327c`; `portaldot_dev` sha256
  `2a4126a64d870883ef8aa0dc82846992a8cfc9ca30ab741dec6f652734dd3da5` (`portaldot_dev 2.0.0-unknown-x86_64-linux-gnu`).
- Started as a normal user with an empty environment, localhost only: `portaldot_dev --dev --alice --tmp --ws-port 9966 --rpc-port 9967 --port 30966 --no-telemetry --no-prometheus --no-mdns`.
- Runtime: `portaldot` spec 1002, tx version 2, metadata **V13**, genesis `0xa07fa01c4ab1987110674eee824b17f6699ee1d576b8c948006ef04672b398a5` (a dev genesis, not mainnet's), BABE with 6 s blocks.
- The node reports **no** token properties, so the run declares `--token POT:14` (the values in the mainnet spec-1002 snapshot in this repo). Not read from the node.
- `Contracts` pallet (old, rent-based, `Compact<Weight>` single gas limit, no `storage_deposit_limit`): yes. `Revive`: no.

Command:
`SEAM_SIGNER=<//Alice> node scripts/testnet-run.mjs ws://127.0.0.1:9966 --token POT:14 --http-url http://127.0.0.1:9967 --yes --out evidence/portaldot-local-node --wasm packages/chain/fixtures/portaldot-local/seam_emitter_seal.wasm --endowment 2000000000000000`

## What differs from the substrate-contracts-node runs
- The ink! 5 `seam_demo` contract **cannot run here**: it imports `seal0.input`, `seal2.set_storage` and so on, while this runtime's
  pallet-contracts exposes the old `seal_*` API (`seal_input`, `seal_deposit_event`...). The deploy of the ink! contract fails
  its signed dry run (`dispatch failed: Other`, nothing sent), and the contract-by-message path is not exercised here.
- So the run deploys a tiny old-API Wasm contract (`fixtures/portaldot-local/seam_emitter_seal.wat`) and calls it by **raw data**
  (`0x6c337222...`, shaped like `settle(7, 2500)`); the `ContractEmitted` data is `"SEAM"` + that input.
- The old pallet needs an endowment above the subsistence threshold (existential deposit + tombstone deposit), hence `--endowment 2e15`.
- New accounts need native balance for non-sufficient assets: the existential deposit here is 1e14, so recipients are funded with 2x that.
- The runtime has no `storage_deposit_limit`, so the Manifest omits it (the compiler uses the single gas limit shape).
- The shape check (`shapeCheck` in `runtime-report.json`) ran over HTTP on the node's separate RPC port (`--http-url`).

## Files
- `runtime-report.json`: read-only report. `testnet-summary.json`: addresses, deploy tx, per-flow results.
- `runs/deploy-*.json`, `runs/sequential-*.json`, `runs/rollback-*.json`, `runs/atomic-*.json` (the file names have timestamps).

## mainnet-plan-blocked.json (read-only gate demonstration)
Label: local Portaldot dev node, spec 1002, not V3 testnet, not mainnet. A plan (the demo Manifest) is prepared against the
committed **mainnet** snapshot/lock, then `checkBeforeSubmit` is run against this local node. The gate blocks it with
`runtime_changed`: the mainnet-locked fingerprint digest is `0xfa84b636…a896`, the local node's is `0xfbc5239f…9310`
(the genesis hash and the metadata hash differ; both runtimes say spec 1002). Nothing is signed or sent, mainnet is not contacted, and
no keys or signatures appear. The preflight and signing envelope are offline placeholders and the policy has the signed dry
run turned off, so that the runtime lock is the only thing shown. Regenerate: `node scripts/gate-mainnet-plan.mjs`.
