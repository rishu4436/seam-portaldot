# SEAM: 5-minute judge walkthrough

**Total: 5:00.** Every command below exists in this repo and runs offline (no node, no wallet, no network) unless marked otherwise. Outputs are what the repo prints at `dd64b02`. Every V3 tx hash comes from [`evidence/testnet-v3/README.md`](../evidence/testnet-v3/README.md); nothing is invented.

| # | Segment | Time | Running total |
|---|---|---|---|
| 0 | Setup (before the clock starts) | 0:00 | 0:00 |
| 1 | What SEAM is | 0:30 | 0:30 |
| 2 | Compile from the runtime's own metadata | 0:35 | 1:05 |
| 3 | Policy blocks before anything is signed | 0:25 | 1:30 |
| 4 | Real V3 receipts: sequential and atomic plans | 0:55 | 2:25 |
| 5 | V3 gate block and `batch_all` rollback | 0:35 | 3:00 |
| 6 | Replay: execute and live verification agree, including `revive.call` | 0:40 | 3:40 |
| 7 | Console, LIVE V3 view | 0:40 | 4:20 |
| 8 | Honest status and close | 0:40 | 5:00 |

## 0. Setup (before the demo, not timed)

```bash
npm install && npm run build
node -e 'const fs=require("fs"),d="./evidence/testnet-v3/runs/";
for (const [n,f] of [["seq","plan-sequential-1792411270138"],["atomic","plan-atomic-1792411355057"]]) {
  const r=require(d+f+".json");
  fs.writeFileSync(`/tmp/v3-${n}-receipt.json`, JSON.stringify(r.run.receipt));
  fs.writeFileSync(`/tmp/v3-${n}-nft-receipt.json`, JSON.stringify(r.nftVerdictReceipt.receipt));
}'
npm run dev -w @seam/console &   # Vite on http://localhost:5173, keep a tab open
```

## 1. What SEAM is (0:30)

Say: "SEAM is the execution layer for Portaldot. You write one **Manifest**: what should happen. SEAM reads the live runtime, **compiles** the exact calls from the chain's own metadata, checks them against a **policy**, gets an **approval**, hands the transaction to your wallet to **sign** (SEAM never holds keys), re-checks everything at a per-step submit gate, waits until it is **finalized**, and ends with a **verified receipt** anyone can re-check against the chain. There is no AI guessing anywhere in that path: if the metadata doesn't show a call, SEAM refuses instead of guessing."

Show: the architecture diagram in the [README](../README.md#architecture).

## 2. Compile from the runtime's own metadata (0:35)

```bash
npx seam compile docs/examples/demo-manifest.json
npx seam compile docs/examples/missing-pallet-manifest.json
```
Output (second command):
```
Runtime: portaldot spec 1002 (POT), snapshot at block 2721455.
Plan for 4 steps: this plan cannot run on this chain.
- pay: assets.transfer is ready (Assets.transfer_keep_alive).
- call: contracts.call is ready (Contracts.call).
- receipt: assets.mint is ready (Assets.mint).
- nft: can't run, because Nfts.mint cannot be compiled: no observed V3 Revive/Nfts metadata exists, so SEAM does not guess the call layout (runtime spec 1002).
```
Say: "Same Manifest format, compiled against the bundled read-only Portaldot mainnet snapshot. Mainnet has no Nfts pallet, so that step is a plain answer, not a failed transaction."

## 3. Policy blocks before anything is signed (0:25)

```bash
npx seam check docs/examples/demo-manifest.json --policy docs/examples/strict-policy.json
```
Output (end):
```
Blocked by policy (1 of 13 checks did not pass):
- pay: Blocked: amount 2500 is over the limit of 1000 for asset 1.
```
Say: "Allow-lists and limits run before signing. Anything not allowed, or that can't be confirmed, is blocked."

## 4. Real V3 receipts: sequential and atomic plans (0:55)

Hosted Portaldot V3 testnet, `portaldot-v3` spec 3002, one disposable test wallet. These went manifest -> compile -> preflight -> policy -> approve -> sign -> submit gate -> finalized -> receipt.

```bash
npx seam verify /tmp/v3-seq-nft-receipt.json
npx seam verify /tmp/v3-atomic-nft-receipt.json
```
Output (sequential):
```
Receipt status: integrity_checked (integrity only, not on-chain proof: ...)
Verified: all 2 steps finalized and the chain shows exactly what was planned.
- pay: finalized. Transfer confirmed: asset, amount and account all match the plan. Tx 0x67015f593a98a1ef1da9d07062a305d0b19c68371870edb864da3cb87a72971a
- nft: finalized. The NFT mint finalized and the chain shows exactly the requested arguments. Tx 0x5adae6e98e2b3d823680a5c35bd0ee5ebb3e0bc924516c185c299c2a571744da
```
The atomic one shows both steps (`mint`, `nft`) with the **same** tx `0x6be1232e17cee41f0376d91b5638ae3f2f9909f4d0f2d15cd633422a339cf355` (#102671): one `Utility.batch_all`.

Say: "Sequential: two transactions, blocks #102653 and #102657. Atomic: one `batch_all` in #102671; SEAM only allowed atomic mode because rollback was proven on V3 first (next segment). The NFT step is checked against the `Nfts.Issued(collection, item, owner)` shape read from V3's own metadata."

Be precise: offline `seam verify` checks **integrity only** (the receipt was not edited). The on-chain proof is the hashes in the explorer links in the evidence README, and live re-verification (segment 6). If asked about the receipts written during the run itself (`run.receipt`): they say `nfts.mint` was `unknown` / `unsupported_runtime`, because the nfts verdict was not the default then; `nftVerdictReceipt` is the same run with the verdict applied, and is the default since.

## 5. V3 gate block and `batch_all` rollback (0:35)

```bash
node --input-type=module -e '
import { explainSubmitCheck } from "@seam/sdk";
import fs from "fs";
const r = JSON.parse(fs.readFileSync("evidence/testnet-v3/runs/plan-rollback-1792411297498.json"));
console.log(explainSubmitCheck(r.run.check));
console.log("batch_all rollback:", r.batchAllRollback);'
```
Output (abridged):
```
Not submitted:
- Blocked: the dry run of the signed transaction failed, so it would fail on chain.
Checks that passed:
- ... (approval_unused, approval_valid_time, approval_intact, approval_matches, runtime_unchanged, signed_bytes_match)
batch_all rollback: verified
```
Say: "A four-step batch whose last step overdraws. SEAM's gate refused to send it. As a test-only bypass we then sent the same signed bytes directly: tx `0xd16622312a942d519e3d246ef46d2c677050c09e787883f7c7c1ffc6595bda80` in #102665 failed with `assets.BalanceLow`, and every balance, the asset supply and the NFT were unchanged. Only the fee was charged. That is the rollback proof the atomic plan relies on."

## 6. Replay: execute and live verification agree (0:40)

```bash
npx vitest run --root packages/sdk tests/v3-replay.test.ts --reporter=verbose
```
Output: `Tests  11 passed (11)`, including:
```
✓ sequential [pay, nft]: both sent once, nfts.mint verified / effect_proven, run verified
✓ atomic batch_all [mint, nft]: one send, nfts.mint verified / effect_proven
✓ revive.call without an expected event: unknown / effect_unproven (call bytes + success only)
✓ revive.call with the expected ContractEmitted (data 0x, no topics) that matches: verified / effect_proven
✓ revive.call with an expected event that does not match: not_verified / effect_mismatch
✓ nfts.mint (sequential and atomic) and revive.call (with and without the expected event) agree
```
Say: "This replays the real V3 records (no network) through `Seam.execute` and through the live re-verifier. Both reach the same verdict. The EVM contract call (tx `0xec9173388b0a017adc6ad0916f3549f6c3aee838e9fe856838aed7f79ef17482`, #102853) is `verified` only when we name the event the contract must emit; without one it stays `unknown`, because V3 has no per-call Revive event. SEAM never upgrades that to verified on its own."

Live form, for a judge with network (not run in the demo; read-only):
`npx seam verify --endpoint <V3 wss> --plan plan.json receipt.json`. It re-reads block, signer, call bytes and events. A step whose receipt or re-check says `not_verified` comes back **`failed`** with a problem listed; atomic steps are compared against their own slice of the batch call. From the CLI, `nfts.mint` and `revive.call` steps stay `unknown`, because the CLI does not yet pass the runtime fingerprint (the SDK's `verifyReceiptLive(..., { runtime })` does).

## 7. Console, LIVE V3 view (0:40)

Open http://localhost:5173.
- **Mode switch -> LIVE V3.** Show the "V3 RPC URL" field and "Check live". Say: "LIVE uses a real V3 RPC and your own wallet. With no endpoint it stays blocked before signing; it never falls back to a simulation."
- Switch to the recorded mode and click through Manifest -> Plan -> Checks -> Approve -> Receipt. Say what the badge says: the recorded run is a **local Portaldot dev node, spec 1002**, not V3.

Only say the console shows real V3 transactions if Pixel's LIVE V3 wiring has landed and you have checked it before the demo. Otherwise show the blocked state as above.

## 8. Honest status and close (0:40)

Say: "On the V3 testnet we've verified signing, dry runs and fees, Assets, Nfts, sequential and atomic SEAM plans, `batch_all` rollback, one EVM contract deploy and a SEAM-planned `revive.call`, 18 finalized transactions in all. Not verified on V3 yet: a `revive.call` effect without an emitted event (that stays unknown), the contract deposit refund (not possible on this runtime, EIP-6780), a deploy through policy, a fresh account mapping, ink!/PolkaVM, cross-VM, and a real browser-extension signature. Everything is in `evidence/testnet-v3`, and the table in the README says the same."

## Facts to have ready if asked

- Chain: `wss://test-node-v3.portaldot.dev`, `portaldot-v3` spec 3002, tx version 2, token tPOT. A test network, not mainnet. Mainnet was only ever read (snapshot at block 2,721,455).
- Signer: a disposable test wallet whose keystore is outside the repo. All signatures came from a local keystore signer, **not** a browser extension.
- The deploy (`0xad39bce1a24072a76c4164b35828b1af8a508b1b6ebb107c96fe0515d33aacb2`, #102843) was signed through SEAM's signing path and a signed dry run, but it is a setup step **outside** policy: the compiler has no instantiate action.
- `Revive.map_account` (`0x7577717d1dba2f0d4148e8a023e76e997d697b736a6f1f0817fa6b846b0b1812`, #102233) dispatched, but the account was already auto-mapped, so it is **not** a fresh mapping.
- Throwaway local dev chain proof: `npm run test:e2e` (~15 s, needs network the first time to download the node binary) runs sequential, rollback and atomic flows end to end. Show the result, don't run it inside the 5 minutes.
