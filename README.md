# SEAM

**SEAM is the execution layer for Portaldot: one Manifest in, one verified receipt out.** A developer (or an AI agent) writes a **Manifest** saying what should happen. SEAM reads the live runtime, **compiles** the exact calls from the chain's own metadata, checks them against a **policy**, binds an **approval**, hands the transaction to the user's own wallet to **sign** (SEAM never holds keys), re-checks everything at a per-step **submit gate**, waits until it is **finalized**, and ends with a **receipt** that anyone can re-verify against the chain. Nothing is guessed: if the metadata doesn't show a call, SEAM refuses to build it, and a step it cannot prove stays `unknown`, never "success".

Built for Portaldot Hacker House 2026 (Modular Cloud & Middleware track).

**For judges (5 minutes):** [docs/demo-script.md](docs/demo-script.md) is a timed walkthrough. The real V3 testnet transactions are in [`evidence/testnet-v3`](evidence/testnet-v3/README.md).

## 5-minute quickstart

Needs Node 22 or later. Run from the repo root. Everything here runs offline: no node, no wallet, no network after `npm ci`. `npm run -s seam -- <command>` runs the built CLI; `npx seam` does not work on a fresh clone, because the bin is linked before `dist/cli.js` exists.

```bash
npm ci && npm run build

# Compile a Manifest against the bundled read-only Portaldot mainnet snapshot (spec 1002)
npm run -s seam -- compile docs/examples/demo-manifest.json
npm run -s seam -- compile docs/examples/missing-pallet-manifest.json      # "Nfts.mint cannot be compiled: this runtime's metadata has no Nfts.mint call (runtime spec 1002) ..."
npm run -s seam -- check docs/examples/demo-manifest.json --policy docs/examples/strict-policy.json   # blocked: amount over limit

# Check a real V3 testnet receipt (sequential plan, tx 0x67015f59…971a + 0x5adae6e9…44da)
node -e 'const r=require("./evidence/testnet-v3/runs/plan-sequential-1792411270138.json");require("fs").writeFileSync("/tmp/v3-receipt.json",JSON.stringify(r.nftVerdictReceipt.receipt))'
npm run -s seam -- verify /tmp/v3-receipt.json            # offline: integrity only, not on-chain proof

# Replay the real V3 records through execute and live verification (they must agree)
npx vitest run --root packages/sdk tests/v3-replay.test.ts

# The console (LIVE V3, recorded and offline modes)
npm run dev -w @seam/console                     # http://localhost:5173
```

`npm test` runs every workspace suite. `npm run test:e2e` runs the full flow (sequential, rollback, atomic) on a throwaway local `substrate-contracts-node` in about 15 s; the first run downloads the node binary. More: [docs/quickstart.md](docs/quickstart.md).

## V3 testnet status

Hosted Portaldot V3 testnet, `portaldot-v3` spec 3002, 18 finalized transactions from one disposable test wallet on 2026-10-19. This table matches [`evidence/testnet-v3/README.md`](evidence/testnet-v3/README.md); details and full hashes are [below](#portaldot-v3-testnet-spec-3002-what-is-and-isnt-verified).

| Verified on V3 (with evidence) | Example tx | Not verified on V3 |
|---|---|---|
| SEAM signing path, signed dry run, fee estimate (every tx) | all 18 | A `revive.call` effect without an emitted event: stays `unknown` (V3 has no per-call Revive event) |
| Assets: create, mint, transfer | `0x5a3fcfe8…0ea4` #102529 | A deposit refund for a deployed contract (not possible on this runtime, EIP-6780) |
| Nfts: create, mint, `Nfts.Issued` shape | `0x9ea5ff6b…8f75` #102327 | A contract deploy through policy (the deploy was a setup step, outside policy) |
| SEAM sequential plan, receipt verified | `0x67015f59…971a` #102653, `0x5adae6e9…44da` #102657 | A fresh account mapping (the signer was already auto-mapped) |
| `batch_all` rollback (gate blocked; test-only bypass rolled back) | `0xd1662231…da80` #102665 | ink! contracts and the PolkaVM path |
| SEAM atomic plan (`atomic_verified`), receipt verified | `0x6be1232e…f355` #102671 | Cross-VM atomicity |
| EVM contract deploy (`Revive.instantiate_with_code`) | `0xad39bce1…acb2` #102843 | A real browser-extension signature (a local keystore signer was used) |
| SEAM-compiled `revive.call`; receipt `verified` only with an expected `ContractEmitted` | `0xec917338…7482` #102853 | Preflight simulation coverage for `nfts.mint` (`unobserved` by design) |

Elsewhere: local runs on a `substrate-contracts-node` dev chain and a local Portaldot dev node (spec 1002). Portaldot **mainnet was only read** (a snapshot at block 2,721,455); nothing was ever submitted to it. There are no users or transaction volume yet. The business model is a hypothesis, not a result: SEAM stays open source, and one idea to test is a hosted service for runtime-change monitoring and independent receipt verification ([RuntimeGuard scope](docs/runtimeguard.md)). No customer, price or demand has been validated.

## Use it from your app

[`examples/consumer`](examples/consumer/index.mjs) is a separate app that imports only `@seam/sdk`, `@seam/compiler` and `@seam/policy` (no repo paths, no node, no keys). Run it with `npm run build && npm run smoke:pack`, which packs the packages, installs them into an empty folder and runs it.

```js
const facts = factsFromSnapshot(bundledSnapshotDir());            // a recorded runtime, offline
const manifest = defineManifest({ signer, actions: [action.transfer('pay', { assetId: '1', amount: '2500', recipient })] });
const plan = compile(manifest, facts);                            // exact runtime calls
console.log(explainPlan(plan), explainPolicy(evaluatePolicy({ policy, plan, facts, manifest })));
```

Sending it for real goes through approval, an external wallet and a per-step gate: see [docs/quickstart.md](docs/quickstart.md).

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
- [docs/demo-script.md](docs/demo-script.md): the 5-minute judge walkthrough, with timing per segment.
- [docs/testnet-checklist.md](docs/testnet-checklist.md): steps for the Portaldot V3 testnet. The first funded run is in [`evidence/testnet-v3`](evidence/testnet-v3/README.md).
- [docs/submission-checklist.md](docs/submission-checklist.md): dates, rules, submission items.
- [evidence/README.md](evidence/README.md): what each recorded run holds. Latest recordings: [sequential](evidence/devnode/runs/sequential-1792301010881.json), [rollback](evidence/devnode/runs/rollback-1792301012980.json), [atomic](evidence/devnode/runs/atomic-1792301015006.json).

## What the evidence does and does not show

Shows (local dev chain only): a three-step Manifest (transfer, ink! contract call `settle` by name, mint) runs sequentially with a gate check before each step; the same steps run atomically in one `batch_all`; a `batch_all` whose step 2 overdraws is **blocked by the gate** (`signed_dry_run_failed`) and, when the same signed bytes are sent anyway as a test-only bypass, fails as a whole with no inner events and unchanged balances (only the fee is charged); receipts verify.

Also shows (local Portaldot dev node, spec 1002): the same three flows signed with `//Alice`, with a raw-data call to a hand-written Wasm emitter instead of contract-by-message (see the section below).

Does not show (for these local runs): anything on Portaldot V3 or mainnet (V3 is covered separately [below](#portaldot-v3-testnet-spec-3002-what-is-and-isnt-verified)); behavior of Portaldot's runtime for contract calls (mainnet is the older spec 1002 / metadata V13 runtime, so the V3 runtime still needs to be re-checked); a run signed in a real browser wallet. Dev-chain runs signed with the public `//Alice` dev account.

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
- Still **PENDING**: a run signed in a real polkadot.js wallet. (The hosted V3 testnet has since been used: see the next section.)

## Portaldot V3 testnet (spec 3002): what is and isn't verified

Source: [`evidence/testnet-v3/README.md`](evidence/testnet-v3/README.md). Nothing beyond that file is claimed here.

**Node:** `wss://test-node-v3.portaldot.dev`, `portaldot-v3` spec 3002, transaction version 2, ss58 prefix 42, token `tPOT` with 14 decimals (the stated config says `tPOTv3`; the node reports `tPOT`), genesis `0xd4f9acbc…83bd`. A test network, not mainnet. Runs on 2026-10-19 from a disposable test wallet: phase 1 (16:48 to 17:32 IST, blocks #102233 to #102671) spent 3.04 tPOT of a 10 tPOT cap; phase 2, Revive (17:49 to 17:52 IST, blocks #102843 to #102862), spent 14.17 tPOT of a further 20 tPOT, almost all of it a contract deposit that cannot be refunded on this runtime (EIP-6780).

**Verified on V3** (finalized transactions; each has a record in [`evidence/testnet-v3/runs`](evidence/testnet-v3/runs)):

| What                                                                                                                                  | tx hash                                                 | block                     | record                                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------- | ------------------------------------------ |
| SEAM signing path, signed `system_dryRun`, `payment_queryInfo` fees (every tx below)                                                  |                                                         |                           |                                            |
| `Revive.map_account` call path (account was **already** auto-mapped)                                                                  | `0x7577717d…1812`                                       | #102233                   | `map-account-1792408724499.json`           |
| `Nfts.create`                                                                                                                         | `0x390bc579…23af`                                       | #102241                   | `nfts-create-1792408936565.json`           |
| `Nfts.mint`, event `Nfts.Issued(collection, item, owner)`                                                                             | `0x9ea5ff6b…8f75`                                       | #102327                   | `nfts-mint-1792409706466.json`             |
| `Assets.create` / `mint` / `transfer_keep_alive`                                                                                      | `0xbc93ca2f…7194`, `0x8b84f63e…82be`, `0x5a3fcfe8…0ea4` | #102411, #102493, #102529 | `assets-*.json`                            |
| SEAM sequential plan: `assets.transfer` (verified) + `nfts.mint`                                                                      | `0x67015f59…971a`, `0x5adae6e9…44da`                    | #102653, #102657          | `plan-sequential-1792411270138.json`       |
| `Utility.batch_all` rollback (gate blocked it; test-only direct send failed with `assets.BalanceLow`, every inner effect rolled back) | `0xd1662231…da80`                                       | #102665                   | `plan-rollback-1792411297498.json`         |
| SEAM `atomic_verified` plan: `assets.mint` + `nfts.mint` in one `batch_all`                                                           | `0x6be1232e…f355`                                       | #102671                   | `plan-atomic-1792411355057.json`           |
| `Revive.instantiate_with_code`, 13-byte EVM contract `0x86b9…d95b` (setup step, outside policy)                                       | `0xad39bce1…acb2`                                       | #102843                   | `revive-deploy-1792412368928.json`         |
| SEAM plan `revive.call` (data `0x`), contract emitted `Revive.ContractEmitted(0x86b9…d95b, 0x, [])`                                   | `0xec917338…7482`                                       | #102853                   | `plan-revive-call-1792412445848.json`      |
| SEAM plan `revive.call` (data `0x01`, SELFDESTRUCT; contract **not** removed, EIP-6780)                                               | `0xc0ad1497…338f`                                       | #102862                   | `plan-revive-terminate-1792412498767.json` |

In that run, SEAM's own receipt left the `nfts.mint` steps `unknown` (`unsupported_runtime`), because no nfts verdict was passed; a receipt built with `verifyNftsMintOutcome` and the metadata's `Nfts.Issued` field order verified them. The two `revive.call` receipts were likewise `unknown` (`unsupported_runtime`). The SDK now applies default checks for both kinds when the receipt is given the spec 3002 runtime: `nfts.mint` against `Nfts.Issued`, and `revive.call` against the extrinsic's own call bytes plus success, which is weaker and stays `unknown` unless the caller also expects a `Revive.ContractEmitted` that matches (see [docs/reference.md](docs/reference.md#outcome-verifiers-for-revivecall-and-nftsmint)).

**NOT verified on V3:**

- A per-call Revive effect. V3 has no event carrying a call's (dest, data, value), so a `revive.call` receipt rests on its call bytes and success, plus an expected `ContractEmitted` when one is given. No recorded receipt was produced with that check; the tests replay the recorded events.
- A deposit refund for a deployed contract (not possible on this runtime once the contract outlives its creating transaction; `remove_code` refused with `CodeInUse`).
- Contract deploys through policy: `instantiate_with_code` is a setup step; the compiler has no instantiate action.
- A fresh account mapping (the signer was already auto-mapped).
- ink! contracts, the PolkaVM path, and cross-VM atomicity. `batch_all` rollback is shown only for `assets.transfer`, `assets.mint` and `nfts.mint`.
- Preflight simulation coverage for `nfts.mint` (still `unobserved` by design).
- A real browser-extension signature (a local keystore signer was used).

**Chain findings** (from the evidence): the metadata bytes drift between blocks without a runtime upgrade (one storage fallback, `Revive.EthBlockBuilderIR`), so a pinned raw metadata hash went stale within minutes; the node's WebSocket drops with code 1006 often. `@seam/chain` now fingerprints a stable metadata layout and has an HTTPS JSON-RPC transport (commit 2300423); that fix has not been re-checked by a new funded V3 run.

**Contract deploy is an "unchecked setup step".** The demo contract deploy is signed through the dry-run and gate path, but policy does not evaluate it, and the compiler has no instantiate action. Only the compiled plan steps (such as `settle`) are covered by policy.

The local-node testnet script `scripts/testnet-run.mjs` and the steps in [docs/testnet-checklist.md](docs/testnet-checklist.md) remain for re-runs. The V3 run used `scripts/v3-funded-run.mjs`.

## License

Apache-2.0. Copyright 2026 Rishu Kumar Gupta. See [LICENSE](LICENSE).
