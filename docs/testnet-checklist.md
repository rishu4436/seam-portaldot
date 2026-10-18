# Portaldot V3 testnet checklist

> **STATUS: PENDING. Nothing here has been run on Portaldot V3 testnet.** We do not yet have the V3 testnet RPC URL or faucet. Do not treat any step below as done. Items marked "unverified" are things we expect but have not confirmed.

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
