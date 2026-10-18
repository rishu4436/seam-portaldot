# Running SEAM on the V3 testnet: `scripts/testnet-run.mjs`

Tested only against the local dev node (`scripts/devnode.sh start`). Nothing here has been run on Portaldot V3.
It refuses `mainnet.portaldot.io` by URL and the mainnet genesis hash after connecting.

## Commands (from the repo root, after `npm run build`)

```bash
# 1. Read-only. Signs nothing. Writes evidence/testnet-v3/runtime-report.json
node scripts/testnet-run.mjs wss://<V3_RPC> [--token SYMBOL:DECIMALS] [--block-time-ms N]

# 2. Everything, signing with a local key (testnet key only; never commit it). Needs --yes.
SEAM_SIGNER=<seed phrase | path to a file holding it | polkadot-js JSON keystore> \
  node scripts/testnet-run.mjs wss://<V3_RPC> --yes [--token SYMBOL:DECIMALS]

# 3. Everything, signing in a browser wallet (polkadot.js extension). Needs --yes.
node scripts/testnet-run.mjs wss://<V3_RPC> --yes --external <YOUR_SS58_ADDRESS>
```

Options: `--out DIR` (default `evidence/testnet-v3`, the folder `docs/testnet-checklist.md` uses), `--asset-id N`,
`--contract 0x..` (use a deployed seam_demo), `--no-deploy`, `--only sequential,rollback,atomic`, `--types FILE`,
`--port N` (external signer page). `SEAM_SIGNER_PASSWORD` for a keystore; `SEAM_SIGNER_SCHEME` (sr25519 default, ed25519, ecdsa).
`--token` has the same meaning as `seam compile --token`. The node's own token properties win; a different declared one stops the run.

## What it does

1. **Runtime report** (read-only): discover, refetch the fingerprint (must be stable), then spec, metadata version,
   pallets (Contracts, Revive, Assets, Utility, Nfts), token, whether `Contracts.call` is the V13 (one gas number) or V14
   (Weight V2) shape, RPC methods, and Bot 2's `v3-shape-check.mjs` output under `shapeCheck`.
2. Only with a signer **and** `--yes`: creates a free asset id and funds the signer (if needed), funds two fresh recipient
   accounts with a little native token (non-sufficient assets need it), **deploys `seam_demo` through SEAM's signing path (an unchecked setup step, outside the Manifest/Policy trust boundary)**,
   then runs **sequential**, **rollback** and **atomic** with the strict policy (`allowedMessages: settle`, pinned ABI hash,
   selector list, no storage-deposit cap), the per-step gate, and `storageDepositLimit: null`.
3. Writes sanitized files: `runtime-report.json`, `testnet-summary.json`, `runs/{deploy,sequential,rollback,atomic}-*.json`.
   Every file goes through a guard that refuses signature, signed-extrinsic, seed, key and password fields, dev derivation
   paths, and the signer secret's own text. Recipients are generated per run; only their addresses are recorded.

The rollback flow includes one test-only step: the failing signed `batch_all` that SEAM's gate refused is sent directly to
watch the chain roll it back (costs a fee). Atomic runs only if that rollback was verified on this runtime.

## Contract deployment: through SEAM, but not a plan step

> **Trust boundary:** contract deploy is an **unchecked setup step outside the Manifest/Policy trust boundary**. It is signed and
> signed-dry-run through SEAM's signing path, but no Manifest describes it, policy never evaluates it, and it produces no
> receipt. Treat it as authorized setup, not as part of verified execution. Only the plan steps that follow are policy-checked.

`deployThroughSeam` (`packages/chain/scripts/seam-run.mjs`) uses SEAM's own signing request, the signer (or wallet),
signature-verifying assemble, the **signed dry run (nothing is sent if it fails)**, then submit. The dev-chain
`devnode/setup.mjs` now uses the same helper. It is not a compiler plan step because `@seam/compiler` has no
`contracts.instantiate` action kind (only `contracts.call`), so there is nothing to compile, gate or put in a receipt.
Needed change (compiler/policy owners): an `instantiate` action with code hash/ABI pinning and a policy capability.
On a Revive-only runtime (no `Contracts.instantiate_with_code`) the script stops with that message.

## Browser wallet: exactly what to click

Requires the polkadot.js browser extension with the account for `<YOUR_SS58_ADDRESS>` (unlocked; the faucet must have
funded that address).

1. Run command 3. The terminal prints `http://127.0.0.1:<port>/?t=<token>`.
2. Open that URL in the browser that has the extension. (Local only; the token is random per run.)
3. Click **Connect extension and start**, and approve the extension's "authorize" popup once.
4. For every transaction the extension opens a **Sign transaction** popup: check it, click **Sign**.
   A full run is about 11 signatures (asset create/mint if needed, 2 recipient funding, deploy, 3 sequential, rollback batch, atomic batch);
   use `--only sequential --contract 0x.. --asset-id N` for 5.
5. Closing a popup (Cancel) stops the run with "the wallet declined"; nothing further is sent.
6. When the terminal prints the summary, the run is done. Close the tab.

How it works: `external-signer/bridge-server.mjs` (127.0.0.1 only, random token) hands each SEAM signing payload to the
page; `bridge-client.js` calls `injectedWeb3['polkadot-js'].signer.signPayload(payload)` (never `signRaw`) and posts the
signature back; SEAM verifies it against the payload before assembling. SEAM never sees the key.
`external-signer/software-wallet.mjs` is the stand-in used by `tests/testnet-run.test.ts`; the real extension has not been
exercised yet. Unknown-chain caveat: the extension may warn that it has no metadata for this chain; that is expected.

## Differences from docs/testnet-checklist.md

- Checklist step 4 says the testnet script is pending; this is it (the entry point is `scripts/testnet-run.mjs`, a thin wrapper).
- Output folder `evidence/testnet-v3/` (the checklist's) rather than `evidence/testnet/`.
- It does not run `seam verify` on receipts or `seam snapshot`; do those separately (checklist steps 1 and 5).
