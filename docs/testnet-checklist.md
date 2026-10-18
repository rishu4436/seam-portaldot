# Portaldot V3 testnet checklist

> **STATUS: PENDING. Nothing here has been run on Portaldot V3 testnet.** We do not yet have the V3 testnet RPC URL or faucet. Do not treat any step below as done. Items marked "unverified" are things we expect but have not confirmed.

## Local Portaldot dev node (spec 1002), not the hosted testnet

This is a **local Portaldot dev node, spec 1002**: the organizers' own `portaldot_dev` binary run on one machine with a throwaway chain (`--dev --tmp`, state deleted on exit). It is **not the hosted V3 testnet** and **not mainnet**. The only key used is the public `//Alice` dev account as a local test signer. Recordings: [`evidence/portaldot-local-node`](../evidence/portaldot-local-node/README.md).

**Runtime report** ([`runtime-report.json`](../evidence/portaldot-local-node/runtime-report.json), read-only):
- Runtime `portaldot` spec **1002**, transaction version **2**, metadata **V13**, ss58 prefix 42, 31 pallets, genesis `0xa07fa01c...b398a5` (a dev genesis, not mainnet's).
- Old rent-based `Contracts` pallet: `Contracts.call` takes a single `gas_limit: Compact<Weight>` and **no** `storage_deposit_limit`. **No `Revive`**, no `Nfts`. `Assets`, `Utility` and `Balances` are present.
- Fingerprint digest `0xfbc5239f...` was stable on refetch. It differs from the mainnet snapshot's digest (`0xfa84b636...`), so a plan prepared against the mainnet snapshot is blocked at the runtime-lock gate on this node. This is now a **recorded run, runtime lock only**: [`mainnet-plan-blocked.json`](../evidence/portaldot-local-node/mainnet-plan-blocked.json) (folder [README](../evidence/portaldot-local-node/README.md)). The gate blocked the mainnet-snapshot plan against the local Portaldot dev node (spec 1002, not the hosted V3 testnet, not mainnet) with exactly one reason code, `runtime_changed`. Planned digest `0xfa84b636…a896` vs local `0xfbc5239f…9310`; differing fields: `genesisHash` and `metadataHash`. Limits: only the runtime lock is demonstrated. The preflight and signing envelope are offline placeholders, `requireSignedDryRun` is `false`, and `signed_bytes_match` is fed the plan's own bytes, so it shows nothing real. The signed-bytes and signed-dry-run checks need a real signed run. Nothing was signed or sent and mainnet was never contacted. Bot 3's gate tests also cover this case.
- The node reports no token properties, so the run declared `--token POT:14` (the mainnet spec-1002 snapshot's values, not read from the node).

**Signed run with the public `//Alice` dev account** ([`testnet-summary.json`](../evidence/portaldot-local-node/testnet-summary.json), run files in [`evidence/portaldot-local-node/runs`](../evidence/portaldot-local-node/runs)). The gate's `sending` and `done` checks passed (`ok: true`) at every step of the sequential and atomic flows:

| Flow | Result | Tx hash(es) and blocks |
|------|--------|-----------------------|
| Sequential (3 txs, gated each step) | verified | pay `0x82c91cdd372a218fad14a5b60ece0bc038b5c8de7e2a8b2f4423bbcb4ef41966` (block 88); call `0xa732384a54946cda2a2652cbcfb5c40ace510575a6363533ee98e0d5be72578d` (block 91); mint `0x8d1494c2d8114c0e12a5fd74d486444ae930d01dbb4a623eba24279321db5aaa` (block 94) |
| Atomic (one `Utility.batch_all`) | verified, `atomic_verified` | all three steps share `0xb3ded1ac192b2012c2c106b5a0eb1cc231ef9e8791a967513672ca604ad45ec8` (block 100) |
| Rollback | verified | direct tx `0x96e4dee879da27b20ebe9493152a9b28d1fd46672c05d81b4110838fcdac4eaf`: gate **blocked** it (`signed_dry_run_failed`); sent anyway as a test-only bypass it failed with `assets.BalanceLow`; balances unchanged, no inner effects |
| Contract deploy (setup) | ok, finalized | tx `0xa635cbebe1acfcc49a75db37ed44299b3ab5dc1bfffca1aa4d6905b1c92b1554` (block 79), contract `0x92b212c616d2a0e9cf03e8ce5323d4d88358372b27e1fb52d5759e9e14bb5822` |

**Limits (state these):**
- The ink! 5 demo contract (`seam_demo`) **cannot run on this old pallet**: it imports `seal0.input`, `seal2.set_storage` and so on, while this runtime exposes the old `seal_*` API. Its deploy fails the signed dry run (`dispatch failed: Other`, nothing sent).
- So the contract step is a **raw-data call** (`0x6c337222...`, shaped like `settle(7, 2500)`) to a small hand-written Wasm emitter (`seam_emitter_seal`). It is **not contract-by-message**. The emitted event data is `"SEAM"` plus that input.
- The contract deploy remains an **unchecked setup step**: it goes through the dry-run and gate path, but policy does not evaluate it and the compiler has no instantiate action.
- A mainnet-built plan is blocked at the gate on this node (fingerprint differs, see above).
- The old pallet needed an endowment above the subsistence threshold (`--endowment 2e15`); recipients were funded with 2x the existential deposit (1e14).
- Still **PENDING**: the hosted V3 testnet (no RPC or faucet yet) and a run signed in a real polkadot.js wallet.

Everything below is still **PENDING** for the hosted V3 testnet; the local node run above ticks no box below.

## Needed from Portaldot (blockers)
- [ ] V3 testnet WebSocket RPC URL (`wss://...`).
- [ ] Faucet (to fund the signer and pay fees).
- [ ] Token symbol and decimals, if the node does not report them in `system_properties`.
- [ ] Whether Revive and Nfts are live on V3 (the compiler also supports `revive.call` and `nfts.mint`).
- [ ] Whether V3 still uses the old `Contracts` pallet (unverified; mainnet spec 1002 does) or Revive.

## 1. Read the runtime (read-only)
```bash
npx seam snapshot <WS_RPC_URL> evidence/testnet-v3/snapshot
```
Record: spec version, metadata version, genesis hash, block number. Compare with the dev chain (spec 100, V14) and mainnet (spec 1002, V13).

## 2. Compile the demo Manifest against it
```bash
npx seam compile docs/examples/demo-manifest.json --snapshot evidence/testnet-v3/snapshot --token SYMBOL:DECIMALS
# or read the live node directly:
npx seam compile docs/examples/demo-manifest.json --endpoint <WS_RPC_URL> --token SYMBOL:DECIMALS
```
- `--token SYMBOL:DECIMALS` only if the node does not report its token (SEAM stops if the node reports a different one).
- For contract calls by name, add `--abi demo=contracts/seam-demo/artifacts/metadata.json` and use `abiRef: "demo"`. A raw-`data` call needs no ABI.
- On the dev chain, the same demo Manifest said `Contracts.call ... takes argument(s) SEAM cannot fill: storageDepositLimit`. Expect to set `storageDepositLimit` explicitly if V3 has the same call shape (unverified).
- Fix the Manifest's accounts, asset ids and contract address for the testnet (the example uses placeholders from the mainnet snapshot).

## 3. Runtime lock re-check
- [ ] Take the fingerprint digest from the snapshot; confirm the plan's runtime lock uses it.
- [ ] Re-run `seam compile` right before approval; the submit gate's `runtime_unchanged` check must pass at each step.
- [ ] Confirm compiler behaviour on V3 (call indexes from live metadata, ABI encoding, `Contracts.call` shape).
- [ ] Decide plan mode: atomic (`Utility.batch_all`) is only used when rollback is verified on that runtime. The dev chain's rollback proof does not carry over; run a rollback test on V3 first.

## 4. Fund and set up
- [ ] Fund the signer from the faucet.
- [ ] Create/mint the demo asset(s) and deploy the demo contract (`contracts/seam-demo`), recording the deploy tx.
- Setup on the dev chain was done by `packages/chain/scripts/devnode/setup.mjs` (refuses non-localhost endpoints).
- **Merged:** `scripts/testnet-run.mjs` is on main. Run it from the repo root after `npm run build`. Full docs: `packages/chain/docs/testnet-run.md`.
  - Read-only runtime report, signs nothing: `node scripts/testnet-run.mjs wss://<V3_RPC>`
  - Signer run with a local testnet key (never printed or saved): `SEAM_SIGNER=<seed|file|json> node scripts/testnet-run.mjs wss://<V3_RPC> --yes`
  - Run signed in the polkadot.js extension: `node scripts/testnet-run.mjs wss://<V3_RPC> --yes --external <SS58_ADDRESS>`
  - Output goes to `evidence/testnet-v3/`. It refuses mainnet by URL and genesis hash, and a signer without `--yes` sends nothing.
  - It does **not** run `seam snapshot` or `seam verify`, so steps 1 and 5 (snapshot, verify) stay manual.
  - The contract deploy is an **unchecked setup step**: it is signed through the dry-run and gate path, but policy does not evaluate it, and the compiler has no instantiate action.
- **PENDING:** the script has only been tested on the local dev node. Nothing has run on Portaldot V3. The real polkadot.js extension has not been exercised, only a stand-in wallet.

## 5. Run the flows
- [ ] Sequential: transfer, contract call, mint, one transaction per step, each gated.
- [ ] Rollback test, then atomic (only if rollback verified).
- [ ] At least one run **signed by a real external wallet** (browser extension), not a dev key. SEAM never holds keys; do not commit seeds or signatures.
- [ ] `npx seam verify <receipt.json>` on each receipt.

## 6. Record (the Oct 24 check-in needs these)
For each run, save under `evidence/testnet-v3/` (no signatures, seeds or keys):
- [ ] RPC endpoint (no secrets), genesis hash, spec version, block numbers.
- [ ] Signer address, contract address, asset ids.
- [ ] Every transaction hash and block hash, with the receipt JSON and its `seam verify` output.
- [ ] Gate check results per step (`passed` list) and the policy result.
- [ ] A short note stating exactly which network each file came from.

## 7. Update the docs
- [ ] README honesty section: replace "local dev chain only" with the real testnet facts, and keep the dev-chain section labelled as such.
- [ ] `docs/demo-script.md`: add the testnet run files and hashes.
- [ ] Do not claim testnet results until the files above exist.
