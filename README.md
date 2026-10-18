# SEAM

**SEAM is the developer execution layer for Portaldot.** A developer (or an AI agent) writes one **Manifest** that says what should happen. SEAM then reads the live runtime (discovery, fingerprint, lock), compiles the exact calls from the chain's own metadata, runs a preflight, checks the result against a **policy**, asks for **approval**, hands the transaction to the user's **external wallet for signing** (SEAM never holds keys), re-checks everything at a **per-step submit gate**, tracks **finalization**, and ends with a **verified Receipt** that anyone can check.

Built for Portaldot Hacker House 2026 (Modular Cloud & Middleware track).

> ## Honesty first
> **Two kinds of local evidence exist:** (1) a `substrate-contracts-node` dev chain and (2) a **local Portaldot dev node (spec 1002)**, see [the section below](#local-portaldot-dev-node-spec-1002-not-the-hosted-testnet). Neither is the hosted V3 testnet.
>
> **All on-chain evidence so far comes from a local `substrate-contracts-node` v0.42.0 dev chain (`--dev`, spec 100, metadata V14). It is NOT Portaldot V3 testnet and NOT Portaldot mainnet.** Nothing was ever submitted to Portaldot. Portaldot mainnet is only read (a read-only snapshot, spec 1002, metadata V13, block 2,721,455). The V3 testnet RPC and faucet are still pending, so no testnet addresses or transaction hashes exist yet. See [Next step: Portaldot V3 testnet](#next-step-portaldot-v3-testnet) and [docs/testnet-checklist.md](docs/testnet-checklist.md).

## What is built

- **Manifest** format with a digest that is the same on any machine for the same Manifest.
- **Compiler**: turns a Manifest into exact runtime calls using live (or snapshotted) metadata. Handles Assets transfer/mint, ink! `Contracts.call` (by raw data or by message name + ABI, with V13 and V14 call shapes), and says plainly when a runtime lacks something.
- **Plan modes**: sequential (one transaction per step) or atomic (`Utility.batch_all`, only when rollback is verified on that runtime).
- **Policy**: allow-lists and limits (assets, recipients, contracts, selectors, message names, pinned ABI hashes, amounts, ...), runtime lock, approval binding, and the per-step submit gate. Anything not allowed, and anything that cannot be confirmed, is blocked.
- **Chain layer**: live discovery, runtime re-check, preflight and signed dry run, external-wallet signing handoff, submit, finalization tracking.
- **SDK + `seam` CLI**: Manifest helpers, receipts with event checks, plain-English explanations of plans, policy results, gate blocks and receipts.
- **Console**: a web UI that walks through the flow.
- **Recorded runs** on the local dev chain: sequential, atomic and rollback, in [`evidence/devnode`](evidence/README.md); and on a local Portaldot dev node (spec 1002) in [`evidence/portaldot-local-node`](evidence/portaldot-local-node/README.md).
- **Automated tests** (see below) and an end-to-end test (`npm run test:e2e`) that starts a fresh local chain.

## Quickstart (about 5 minutes)

Needs Node 22 or later (the commands below were run with `npm`, from the repo root).

```bash
npm install
npm run build
npm test            # compiler 111, policy 66, sdk 61, chain 55 (+11 skipped)
```

Try the CLI offline, against the bundled Portaldot mainnet snapshot (read-only, no node or wallet needed):

```bash
npx seam digest docs/examples/demo-manifest.json
npx seam compile docs/examples/demo-manifest.json
npx seam check docs/examples/demo-manifest.json --policy docs/examples/strict-policy.json   # blocked: amount over limit
npx seam compile docs/examples/missing-pallet-manifest.json                                 # "Nfts.mint is not on this runtime"
```

Run the whole flow for real on a **throwaway local dev chain** (not Portaldot):

```bash
npm run test:e2e
```

This starts a fresh local `substrate-contracts-node` on port 9955, runs setup (asset + demo ink! contract), the sequential run, the rollback run and the atomic run, then always stops and cleans up the node. Expected: `Tests  3 passed (3)` in roughly 15 seconds. The first run downloads the node binary (sha256-checked) unless one is already present; it needs `curl` and network access for that.

Check a recorded receipt from the repo, no chain needed:

```bash
node -e 'const r=require("./evidence/devnode/runs/sequential-1792301010881.json");require("fs").writeFileSync("/tmp/receipt.json",JSON.stringify(r.run.receipt))'
npx seam verify /tmp/receipt.json
```

Open the console:

```bash
npm run dev -w @seam/console     # Vite on http://localhost:5173
```

More: [docs/quickstart.md](docs/quickstart.md) (Manifest to plan to policy to receipt, plus the SDK code path) and [evidence/README.md](evidence/README.md) (how to re-record the dev-chain runs by hand).

## Architecture

```
Manifest ──► discover runtime ──► fingerprint + lock ──► compile ──► preflight ──► policy
 (JSON)      (live or snapshot)   (runtime must not       (exact      (fees, weight,  (allow-lists,
                                   change)               calls)      dry run)        limits)
                                                                                         │
 verified Receipt ◄── finalization ◄── per-step submit gate ◄── external wallet ◄── approval
 (digest + events      (in block,       (fresh fingerprint,      signs (SEAM          (bound to plan,
  match the plan)       finalized)       signed bytes == approved, never sees keys)    policy, runtime)
                                         signed dry run ok)
```

Execution is either **sequential** (each step is gated just before it is sent; the run stops at the first failure) or **atomic** (all steps in one `Utility.batch_all`; if one fails, all roll back). The submit gate can refuse to send, and says why in plain English.

## Package map

| Package | What it does |
| --- | --- |
| [`packages/compiler`](packages/compiler) | Reads runtime metadata, turns a Manifest into exact Portaldot calls and a deterministic plan; ink! ABI encoding |
| [`packages/policy`](packages/policy) | Policy rules, approval binding, runtime lock, per-step submit gate |
| [`packages/chain`](packages/chain/README.md) | Live discovery, preflight and dry run, signing handoff, submit and track; dev-chain scripts (`scripts/devnode.sh`) |
| [`packages/sdk`](packages/sdk) | Manifest helpers, receipts with event checks, plain explanations, the `seam` CLI |
| [`packages/console`](packages/console) | Web console (React + Vite) that walks through the whole flow |
| [`contracts/seam-demo`](contracts/seam-demo) | Demo ink! contract (`settle`) used by the dev-chain runs |
| [`fixtures/`](fixtures) | Read-only snapshot of public Portaldot mainnet (spec 1002, block 2,721,455) used by offline tests |

## Docs and evidence

- [docs/architecture.md](docs/architecture.md): architecture diagram (pipeline and per-step gate).
- [docs/quickstart.md](docs/quickstart.md): clone to a compiled, policy-checked plan, offline.
- [docs/reference.md](docs/reference.md): every Manifest field, plan mode, policy rule, block reason and receipt status.
- [docs/demo-script.md](docs/demo-script.md): the ~3 minute judge walkthrough.
- [docs/testnet-checklist.md](docs/testnet-checklist.md): steps for Portaldot V3 testnet (**pending**).
- [docs/submission-checklist.md](docs/submission-checklist.md): dates, rules, submission items.
- [evidence/README.md](evidence/README.md): what each recorded run holds. Latest recordings: [sequential](evidence/devnode/runs/sequential-1792301010881.json), [rollback](evidence/devnode/runs/rollback-1792301012980.json), [atomic](evidence/devnode/runs/atomic-1792301015006.json).

## What the evidence does and does not show

Shows (local dev chain only): a three-step Manifest (transfer, ink! contract call `settle` by name, mint) runs sequentially with a gate check before each step; the same steps run atomically in one `batch_all`; a `batch_all` whose step 2 overdraws is **blocked by the gate** (`signed_dry_run_failed`) and, when the same signed bytes are sent anyway as a test-only bypass, fails as a whole with no inner events and unchanged balances (only the fee is charged); receipts verify.

Also shows (local Portaldot dev node, spec 1002): the same three flows signed with `//Alice`, with a raw-data call to a hand-written Wasm emitter instead of contract-by-message (see the section below).

Does not show: anything on Portaldot V3 testnet or mainnet; behavior of Portaldot's runtime for contract calls (mainnet is the older spec 1002 / metadata V13 runtime, so the V3 runtime still needs to be re-checked); a run signed in a real browser wallet. Dev-chain runs signed with the public `//Alice` dev account.

## Local Portaldot dev node (spec 1002), not the hosted testnet

This is a **local Portaldot dev node, spec 1002**: the organizers' own `portaldot_dev` binary run on one machine with a throwaway chain (`--dev --tmp`, state deleted on exit). It is **not the hosted V3 testnet** and **not mainnet**. The only key used is the public `//Alice` dev account as a local test signer. Recordings: [`evidence/portaldot-local-node`](evidence/portaldot-local-node/README.md).

**Runtime report** ([`runtime-report.json`](evidence/portaldot-local-node/runtime-report.json), read-only):
- Runtime `portaldot` spec **1002**, transaction version **2**, metadata **V13**, ss58 prefix 42, 31 pallets, genesis `0xa07fa01c...b398a5` (a dev genesis, not mainnet's).
- Old rent-based `Contracts` pallet: `Contracts.call` takes a single `gas_limit: Compact<Weight>` and **no** `storage_deposit_limit`. **No `Revive`**, no `Nfts`. `Assets`, `Utility` and `Balances` are present.
- Fingerprint digest `0xfbc5239f...` was stable on refetch. It differs from the mainnet snapshot's digest (`0xfa84b636...`), so a plan prepared against the mainnet snapshot is blocked at the runtime-lock gate on this node. This is now a **recorded run, runtime lock only**: [`mainnet-plan-blocked.json`](evidence/portaldot-local-node/mainnet-plan-blocked.json) (folder [README](evidence/portaldot-local-node/README.md)). The gate blocked the mainnet-snapshot plan against the local Portaldot dev node (spec 1002, not the hosted V3 testnet, not mainnet) with exactly one reason code, `runtime_changed`. Planned digest `0xfa84b636…a896` vs local `0xfbc5239f…9310`; differing fields: `genesisHash` and `metadataHash`. Limits: only the runtime lock is demonstrated. The preflight and signing envelope are offline placeholders, `requireSignedDryRun` is `false`, and `signed_bytes_match` is fed the plan's own bytes, so it shows nothing real. The signed-bytes and signed-dry-run checks need a real signed run. Nothing was signed or sent and mainnet was never contacted. Bot 3's gate tests also cover this case.
- The node reports no token properties, so the run declared `--token POT:14` (the mainnet spec-1002 snapshot's values, not read from the node).

**Signed run with the public `//Alice` dev account** ([`testnet-summary.json`](evidence/portaldot-local-node/testnet-summary.json), run files in [`evidence/portaldot-local-node/runs`](evidence/portaldot-local-node/runs)). The gate's `sending` and `done` checks passed (`ok: true`) at every step of the sequential and atomic flows:

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

## Next step: Portaldot V3 testnet

**Contract deploy is an "unchecked setup step".** The demo contract deploy is signed through the dry-run and gate path, but policy does not evaluate it, and the compiler has no instantiate action. Only the compiled plan steps (such as `settle`) are covered by policy.

The testnet script `scripts/testnet-run.mjs` is merged but has only run against the local dev node. Nothing has run on Portaldot V3, and the real polkadot.js extension is untested (only a stand-in wallet).

Blocked only on the V3 testnet **RPC URL** and **faucet**. Once we have them: read the runtime, re-lock the fingerprint, re-check the compiler against V3 (does it still use the old contracts pallet?), run the demo flow, and record contract addresses and transaction hashes. Exact steps: [docs/testnet-checklist.md](docs/testnet-checklist.md).

## License

Apache-2.0. Copyright 2026 Rishu Kumar Gupta. See [LICENSE](LICENSE).
