# SEAM: 5-minute judge walkthrough

**Total: 5:00.** Every command below exists in this repo and runs offline (no node, no wallet, no network) unless marked otherwise. Outputs are pasted exactly as the repo prints them on this branch. Every V3 tx hash comes from [`evidence/testnet-v3/README.md`](../evidence/testnet-v3/README.md); nothing is invented.

| # | Segment | Time | Running total |
|---|---|---|---|
| 0 | Setup (before the clock starts) | 0:00 | 0:00 |
| 1 | What SEAM is | 0:30 | 0:30 |
| 2 | Compile from a recorded runtime's metadata (bundled spec 1002 snapshot) | 0:35 | 1:05 |
| 3 | Policy blocks before anything is signed | 0:25 | 1:30 |
| 4 | Real V3 receipts: sequential and atomic plans | 0:55 | 2:25 |
| 5 | V3 gate block and `batch_all` rollback | 0:35 | 3:00 |
| 6 | Replay: execute and live verification agree, including `revive.call` | 0:40 | 3:40 |
| 7 | Console, LIVE V3 view | 0:40 | 4:20 |
| 8 | Honest status and close | 0:40 | 5:00 |

## 0. Setup (before the demo, not timed)

Run everything from the repo root. `npm run -s seam -- ...` runs the built CLI (`node packages/sdk/dist/cli.js`); it works on a fresh clone after `npm ci && npm run build`, where `npx seam` does not (the `seam` bin is not linked because `dist/cli.js` doesn't exist at install time).

```bash
npm ci && npm run build
node -e 'const fs=require("fs"),d="./evidence/testnet-v3/runs/";
for (const [n,f] of [["seq","plan-sequential-1792411270138"],["atomic","plan-atomic-1792411355057"]]) {
  const r=require(d+f+".json");
  fs.writeFileSync(`/tmp/v3-${n}-nft-receipt.json`, JSON.stringify(r.nftVerdictReceipt.receipt));
  fs.writeFileSync(`/tmp/v3-${n}-plan.json`, JSON.stringify(r.plan));
}'
npm run dev -w @seam/console &   # Vite on http://localhost:5173, keep a tab open
```

## 1. What SEAM is (0:30)

Say: "SEAM is the execution layer for Portaldot. You write one **Manifest**: what should happen. SEAM reads the runtime, **compiles** the exact calls from that runtime's own metadata, checks them against a **policy**, gets an **approval**, hands the transaction to your wallet to **sign** (SEAM never holds keys), re-checks everything at a per-step submit gate, waits until it is **finalized**, and ends with a **verified receipt** anyone can re-check against the chain. There is no AI guessing anywhere in that path: if the metadata doesn't show a call, SEAM refuses instead of guessing."

Show: the architecture diagram in the [README](../README.md#architecture).

## 2. Compile from a runtime's own metadata (0:35)

These commands compile against the **bundled, read-only snapshot of Portaldot mainnet** (spec 1002, block 2,721,455), not a live node. (`--endpoint <ws>` would read a live node instead; the demo stays offline.)

```bash
npm run -s seam -- compile docs/examples/demo-manifest.json
npm run -s seam -- compile docs/examples/missing-pallet-manifest.json
```
Output (first command, exit 0):
```
Runtime: portaldot spec 1002 (POT), snapshot at block 2721455.
Plan for 3 steps: steps run one at a time, and SEAM stops at the first one that fails.
- pay: assets.transfer is ready (Assets.transfer_keep_alive).
- call: contracts.call is ready (Contracts.call).
- receipt: assets.mint is ready (Assets.mint).
Why this mode: Utility.batch_all exists but its rollback on failure is not verified (set allowAtomicUnverified to batch anyway). Steps run one after another; a failure stops later steps.
Plan digest: 0x287a8f7f215d7c7e4188f9982092b1e6dd69dbb56bbe42729b20b9a5ac2156ac
```
Output (second command, exit 3):
```
Runtime: portaldot spec 1002 (POT), snapshot at block 2721455.
Plan for 4 steps: this plan cannot run on this chain.
- pay: assets.transfer is ready (Assets.transfer_keep_alive).
- call: contracts.call is ready (Contracts.call).
- receipt: assets.mint is ready (Assets.mint).
- nft: can't run, because Nfts.mint cannot be compiled: this runtime's metadata has no Nfts.mint call (runtime spec 1002), so SEAM does not guess the call layout. It compiles on a runtime that has it, such as Portaldot V3 (spec 3002).
Plan digest: 0x4e471a46c55609b26865ad9665bf3108fe2077fb1c0d2b7ddf569c5d6b8b4797
```
Say: "Same Manifest format, compiled from the recorded spec 1002 metadata. That runtime has no `Nfts.mint`, so the step is a plain answer, not a guessed call and not a failed transaction. The same action compiles on V3 (spec 3002)."

## 3. Policy blocks before anything is signed (0:25)

```bash
npm run -s seam -- check docs/examples/demo-manifest.json --policy docs/examples/strict-policy.json
```
Output (exit 4):
```
Runtime: portaldot spec 1002 (POT), snapshot at block 2721455.
Plan for 3 steps: steps run one at a time, and SEAM stops at the first one that fails.
- pay: assets.transfer is ready (Assets.transfer_keep_alive).
- call: contracts.call is ready (Contracts.call).
- receipt: assets.mint is ready (Assets.mint).
Why this mode: Utility.batch_all exists but its rollback on failure is not verified (set allowAtomicUnverified to batch anyway). Steps run one after another; a failure stops later steps.

Blocked by policy (1 of 13 checks did not pass):
- pay: Blocked: amount 2500 is over the limit of 1000 for asset 1.
```
Say: "Allow-lists and limits run before signing. Anything not allowed, or that can't be confirmed, is blocked."

## 4. Real V3 receipts: sequential and atomic plans (0:55)

Hosted Portaldot V3 testnet, `portaldot-v3` spec 3002, one disposable test wallet. These went manifest -> compile -> preflight -> policy -> approve -> sign -> submit gate -> finalized -> receipt.

The atomic plan is the one **recorded** in run #102671, not a fresh compile:

```bash
npm run -s seam -- explain /tmp/v3-atomic-plan.json
```
Output (exit 0):
```
Plan for 2 steps: all steps run in one transaction, and the chain has been shown to undo everything if any step fails.
- mint: assets.mint is ready (Assets.mint).
- nft: nfts.mint is ready (Nfts.mint).
Why this mode: All steps go in one Utility.batch_all; rollback on failure has been verified on this runtime.
```
Say honestly: "This is the plan as it was compiled and signed during the run. If you compile the same Manifest against V3 today, you get **sequential**, not atomic: the rollback proof is pinned to V3's raw metadata hash, and V3's raw metadata bytes drift between blocks without a runtime upgrade, so the proof no longer matches. SEAM falls back to the safe mode instead of assuming the rollback still holds."

```bash
npm run -s seam -- verify /tmp/v3-seq-nft-receipt.json
npm run -s seam -- verify /tmp/v3-atomic-nft-receipt.json
```
Output (sequential, exit 0):
```
Receipt status: integrity_checked (integrity only, not on-chain proof: this checks that the receipt was not edited after it was written. Anyone can recompute that digest, so it does not show that any transaction exists. Use live verification (seam verify --endpoint) for that.)
Verified: all 2 steps finalized and the chain shows exactly what was planned.
- pay: finalized. Transfer confirmed: asset, amount and account all match the plan. Tx 0x67015f593a98a1ef1da9d07062a305d0b19c68371870edb864da3cb87a72971a
- nft: finalized. The NFT mint finalized and the chain shows exactly the requested arguments. Tx 0x5adae6e98e2b3d823680a5c35bd0ee5ebb3e0bc924516c185c299c2a571744da
```
Output (atomic, exit 0):
```
Receipt status: integrity_checked (integrity only, not on-chain proof: this checks that the receipt was not edited after it was written. Anyone can recompute that digest, so it does not show that any transaction exists. Use live verification (seam verify --endpoint) for that.)
Verified: all 2 steps finalized and the chain shows exactly what was planned.
- mint: finalized. Mint confirmed: asset, amount and account all match the plan. Tx 0x6be1232e17cee41f0376d91b5638ae3f2f9909f4d0f2d15cd633422a339cf355
- nft: finalized. The NFT mint finalized and the chain shows exactly the requested arguments. Tx 0x6be1232e17cee41f0376d91b5638ae3f2f9909f4d0f2d15cd633422a339cf355
```
Say: "Sequential: two transactions, blocks #102653 and #102657. Atomic: both steps share one `Utility.batch_all`, tx `0x6be1232e…f355` in #102671. The NFT step is checked against the `Nfts.Issued(collection, item, owner)` shape read from V3's own metadata."

Be precise: offline `seam verify` checks **integrity only**, as its first line says (the receipt was not edited). The on-chain proof is the hashes behind the explorer links in the evidence README, plus live re-verification (segment 6). If asked about the receipts written during the run itself (`run.receipt`): they show `nfts.mint` as `unknown` / `unsupported_runtime`, because the nfts check was not the default then. `nftVerdictReceipt` is the same run with that check applied, and the check has been the default since.

## 5. V3 gate block and `batch_all` rollback (0:35)

```bash
node --input-type=module -e '
import { explainSubmitCheck } from "@seam/sdk";
import fs from "fs";
const r = JSON.parse(fs.readFileSync("evidence/testnet-v3/runs/plan-rollback-1792411297498.json"));
console.log(explainSubmitCheck(r.run.check));
console.log("batch_all rollback:", r.batchAllRollback);'
```
Output:
```
Not submitted:
- Blocked: the dry run of the signed transaction failed, so it would fail on chain.
Checks that passed:
- this step of the approval hasn't been sent before (approval_unused: this approval hasn't been used)
- the approval hasn't expired (approval_valid_time: the approval is valid until 2026-10-19T12:07:50.767Z)
- the approval's contents still match its hash (approval_intact: the approval's contents match its hash)
- what is about to be sent is exactly what was approved (approval_matches: what is about to be sent is exactly what was approved (plan, policy, runtime, envelope, preflight))
- the chain runtime is the one the plan was prepared for (runtime_unchanged: the runtime is the one the plan was prepared for)
- the signed transaction bytes are exactly the approved calls (signed_bytes_match: the 1 call(s) decoded from the signed transaction bytes are exactly the approved calls)
batch_all rollback: verified
```
Say: "A four-step batch whose last step overdraws. SEAM's gate refused to send it. As a test-only bypass we then sent the same signed bytes directly: tx `0xd16622312a942d519e3d246ef46d2c677050c09e787883f7c7c1ffc6595bda80` in #102665 failed with `assets.BalanceLow`, and every balance, the asset supply and the NFT were unchanged. Only the fee was charged. That is the rollback proof the recorded atomic plan relied on."

## 6. Replay: execute and live verification agree (0:40)

```bash
npx vitest run --root packages/sdk tests/v3-replay.test.ts --reporter=verbose
```
Output (test lines; timings removed):
```
 ✓ tests/v3-replay.test.ts > the records are what they claim (REAL) > spec 3002 portaldot-v3, the approval covers the recorded plan, and the signed calls are the plan's calls
 ✓ tests/v3-replay.test.ts > the records are what they claim (REAL) > the receipts SEAM wrote during the funded run had nfts.mint and revive.call at unsupported_runtime
 ✓ tests/v3-replay.test.ts > Seam.execute replay of REAL V3 runs: execute passes runtime and call bytes to the receipt > sequential [pay, nft]: both sent once, nfts.mint verified / effect_proven, run verified
 ✓ tests/v3-replay.test.ts > Seam.execute replay of REAL V3 runs: execute passes runtime and call bytes to the receipt > atomic batch_all [mint, nft]: one send, nfts.mint verified / effect_proven
 ✓ tests/v3-replay.test.ts > Seam.execute replay of REAL V3 runs: execute passes runtime and call bytes to the receipt > revive.call without an expected event: unknown / effect_unproven (call bytes + success only)
 ✓ tests/v3-replay.test.ts > Seam.execute replay of REAL V3 runs: execute passes runtime and call bytes to the receipt > revive.call with the expected ContractEmitted (data 0x, no topics) that matches: verified / effect_proven
 ✓ tests/v3-replay.test.ts > Seam.execute replay of REAL V3 runs: execute passes runtime and call bytes to the receipt > revive.call with an expected event that does not match: not_verified / effect_mismatch
 ✓ tests/v3-replay.test.ts > fails closed (SYNTHETIC variants of the REAL records) > facts claiming another runtime than the node reports: blocked before anything is sent
 ✓ tests/v3-replay.test.ts > fails closed (SYNTHETIC variants of the REAL records) > an adapter-reported call that differs from the plan is used as reported: effect_mismatch
 ✓ tests/v3-replay.test.ts > fails closed (SYNTHETIC variants of the REAL records) > perStepOfBatch: a batch call that is not exactly the plan's steps gives no per-step call bytes
 ✓ tests/v3-replay.test.ts > agreement with live re-verification (verify-live's verifyStep call, with runtime and call bytes) > nfts.mint (sequential and atomic) and revive.call (with and without the expected event) agree
      Tests  11 passed (11)
```
Say: "This replays the real V3 records (no network) through `Seam.execute` and through the live re-verifier. Both reach the same verdict. The EVM contract call (tx `0xec9173388b0a017adc6ad0916f3549f6c3aee838e9fe856838aed7f79ef17482`, #102853) is `verified` only when we name the event the contract must emit; without one it stays `unknown`, because V3 has no per-call Revive event. SEAM never upgrades that to verified on its own."

Live form, for a judge with network (not run in the demo; read-only, nothing is signed or sent). After the setup step, also write the recorded plan: `node -e 'require("fs").writeFileSync("/tmp/v3-seq-plan.json",JSON.stringify(require("./evidence/testnet-v3/runs/plan-sequential-1792411270138.json").plan))'`, then:

```bash
npm run -s seam -- verify --endpoint wss://test-node-v3.portaldot.dev --plan /tmp/v3-seq-plan.json --runtime evidence/testnet-v3/runs/plan-sequential-1792411270138.json /tmp/v3-seq-nft-receipt.json
```

It re-reads block, signer, call bytes and events. `--runtime` takes the run record's `fingerprint`: it must have the receipt's `fingerprintDigest`, and genesis, spec, transaction version and ss58 must match the node; only the metadata hash may differ. Without `--runtime`, `nfts.mint` and `revive.call` steps stay `unknown`. A step whose receipt or re-check says `not_verified` comes back **`failed`** with a problem listed; atomic steps are re-checked against their own slice of the batch call. This live command has not been run against V3 for this script, so no output is shown.

## 7. Console, LIVE V3 view (0:40)

**Depends on Pixel's console commit `3149897` (`bot1/live-v3-console`) being merged to `main`.** Without it, LIVE V3 has no default endpoint and stays blocked; show that instead and skip the evidence view.

Open http://localhost:5173 and pick **LIVE V3** in the mode switch.
- **Facts step.** LIVE defaults to `https://test-node-v3.portaldot.dev` and only reads. Say exactly what is live: "The runtime fingerprint comes from a labelled, recorded V3 snapshot. Only the metadata is read live. If the node's genesis, spec or transaction version differs from the recorded one, it fails closed. Only the metadata hash is allowed to drift, because V3's raw metadata bytes change between blocks." Pixel's run read spec 3002 at block #115817; what you see will be a later block.
- **Signing stays blocked.** The console does not sign or send anything on V3 in this demo, and nothing here uses a wallet.
- **"V3 testnet transactions (recorded)".** This lists the 18 finalized V3 transactions from `evidence/testnet-v3`. The SEAM plan rows 12, 13 (sequential) and 15 (atomic) show as **verified**, from the run's `nftVerdictReceipt`. `revive.call` shows as **unknown** when no event is expected. Say: "These are recorded results, not a live re-check."
- Optional: switch to **RECORDED LOCAL EVIDENCE**. The badge says it is a local Portaldot dev node, spec 1002, not V3.

## 8. Honest status and close (0:40)

Say: "On the V3 testnet we've verified signing, dry runs and fees, Assets, Nfts, sequential and atomic SEAM plans, `batch_all` rollback, one EVM contract deploy and a SEAM-planned `revive.call`, 18 finalized transactions in all. Not verified on V3 yet: a `revive.call` effect without an emitted event (that stays unknown), the contract deposit refund (not possible on this runtime, EIP-6780), a deploy through policy, a fresh account mapping, ink!/PolkaVM, cross-VM, and a real browser-extension signature. Everything is in `evidence/testnet-v3`, and the table in the README says the same."

## Facts to have ready if asked

- Chain: `wss://test-node-v3.portaldot.dev`, `portaldot-v3` spec 3002, tx version 2, token tPOT. A test network, not mainnet. Mainnet was only ever read (snapshot at block 2,721,455).
- Signer: a disposable test wallet whose keystore is outside the repo. All signatures came from a local keystore signer, **not** a browser extension.
- The deploy (`0xad39bce1a24072a76c4164b35828b1af8a508b1b6ebb107c96fe0515d33aacb2`, #102843) was signed through SEAM's signing path and a signed dry run, but it is a setup step **outside** policy: the compiler has no instantiate action.
- `Revive.map_account` (`0x7577717d1dba2f0d4148e8a023e76e997d697b736a6f1f0817fa6b846b0b1812`, #102233) dispatched, but the account was already auto-mapped, so it is **not** a fresh mapping.
- Throwaway local dev chain proof: `npm run test:e2e` (~15 s, needs network the first time to download the node binary) runs sequential, rollback and atomic flows end to end. Show the result, don't run it inside the 5 minutes.
