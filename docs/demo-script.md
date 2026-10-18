# Judge demo script (3 minutes max)

## Timing (total 180 s = 3:00, at the cap)

| # | Step | Seconds |
|---|------|---------|
| - | Opening statement ("Say this first") | 10 |
| 1 | Manifest compiled from live metadata | 25 |
| 2 | `npm run test:e2e` (sped-up recording or result) | 20 |
| 3 | Sequential: one transaction per step | 40 |
| 4 | Atomic: all or nothing | 25 |
| 5 | Rollback and a gate block, explained | 50 |
| 6 | Console and close | 10 |
| | **Total** | **180** |

Setup (section 0) happens before the demo and is not counted. The earlier version of this script added up to about 3:20; step 2 is now a sped-up recording (as in the video storyboard) rather than a live run, and steps 1 and 4 are tightened by 5 s each.

**PENDING: browser-wallet scene.** No run has been signed in a browser wallet yet. A wallet-signed scene stays PENDING until the Portaldot testnet is up and a real signed run exists. Do not show or invent a tx hash for it; all hashes in this script come from the local chain only. If it is added later, it must fit by trimming another step so the total stays at or under 180 s.

**Contract deploy: say it is an "unchecked setup step".** If the deploy is mentioned or shown, label it that way: it is signed through the dry-run and gate path, but policy does not evaluate it, and the compiler has no instantiate action. Policy covers the compiled plan steps only.

**Local Portaldot dev node (spec 1002), optional evidence, not part of the 180 s table.** Recorded runs from a local Portaldot dev node (not the hosted testnet) are in [`evidence/portaldot-local-node`](../evidence/portaldot-local-node/README.md): sequential pay block 88, call block 91, mint block 94; atomic block 100 (tx `0xb3ded1ac...`); rollback gated with `signed_dry_run_failed`, bypass failed with `assets.BalanceLow`. Also a recorded run, runtime lock only: [`mainnet-plan-blocked.json`](../evidence/portaldot-local-node/mainnet-plan-blocked.json) shows the gate blocking the mainnet-snapshot plan with exactly one reason code, `runtime_changed` (planned digest `0xfa84b636…a896` vs local `0xfbc5239f…9310`; `genesisHash` and `metadataHash` differ). Say plainly that this demonstrates only the runtime lock: preflight and signing envelope are offline placeholders, `requireSignedDryRun` is false, `signed_bytes_match` is fed the plan's own bytes and shows nothing real, and the signed-bytes and signed-dry-run checks need a real signed run. Nothing signed, mainnet never contacted. If shown, say "local Portaldot dev node, spec 1002", and that the contract step is a raw-data call to a small hand-written Wasm emitter, **not** contract-by-message, because the ink! 5 demo contract cannot run on this old pallet. The contract deploy is an unchecked setup step. Wallet signing and the hosted V3 testnet stay PENDING. Full hashes: README section "Local Portaldot dev node (spec 1002), not the hosted testnet".

**Say this first (10 s):** "Everything you will see ran on local chains (a substrate-contracts-node dev chain; a local Portaldot dev node, spec 1002, is shown separately), not Portaldot V3 testnet. V3 and Revive are not verified. The testnet RPC and faucet are pending. The mainnet snapshot is read-only."

All outputs below were produced by running the command on the repo at the time of writing. Tx hashes and block numbers exist only on that local chain and change on every fresh run. Evidence files are in [`evidence/devnode/runs`](../evidence/README.md).

## 0. Setup (before the demo)

```bash
npm install && npm run build
node -e 'const fs=require("fs");const d="evidence/devnode/runs/";for(const [n,f] of [["sequential","sequential-1792301010881"],["atomic","atomic-1792301015006"]]){fs.writeFileSync(`/tmp/${n}-receipt.json`,JSON.stringify(require("./"+d+f+".json").run.receipt))}'
```

## 1. One Manifest, compiled from live metadata (25 s)

```bash
npx seam compile docs/examples/missing-pallet-manifest.json
```
Say: "SEAM reads what the runtime really offers. A missing pallet is a plain answer, not a failed transaction."
Proves: last lines include `- nft: can't run, because Nfts.mint cannot be compiled: no observed V3 Revive/Nfts metadata exists, so SEAM does not guess the call layout (runtime spec 1002).` (against the bundled Portaldot mainnet snapshot).

## 2. Live proof in one command (20 s, shown sped-up or as a result)

```bash
npm run test:e2e
```
Say: "This starts a fresh local chain, deploys a demo ink! contract, and runs the sequential, rollback and atomic flows, then cleans up."
Proves: `Tests  3 passed (3)`. The test time is about 13-17 s (first run downloads the node binary), so do not run it live inside the cap: show a sped-up recording of the run, or show its final `Tests  3 passed (3)` result. Say which one it is. If time is short, skip this and use the recorded runs below.

## 3. Sequential: one transaction per step (40 s)

Recorded run: `evidence/devnode/runs/sequential-1792301010881.json`

```bash
npx seam verify /tmp/sequential-receipt.json
```
Output:
```
Receipt is intact (digest matches).
Verified: all 3 steps finalized and the chain shows exactly what was planned.
- pay: finalized. Transfer confirmed: asset, amount and account all match the plan. Tx 0xa9b6c5fe...
- call: finalized. The call succeeded and the contract emitted an event. Tx 0x23708127...
- mint: finalized. Mint confirmed: asset, amount and account all match the plan. Tx 0x69d73cb0...
```
Say: "Three steps, three transactions. The contract step was called by name (`settle`) with the ABI, and verified by its `ContractEmitted` event. Before each send the gate re-checked everything."
Proves: the run file's `gateChecks` has a `sending` and `done` entry per step, all `ok: true`, each with a `passed` list (`step_order`, `approval_*`, `runtime_unchanged`, `signed_bytes_match`, `signed_dry_run_ok`).

## 4. Atomic: all or nothing in one transaction (25 s)

Recorded run: `evidence/devnode/runs/atomic-1792301015006.json`

```bash
npx seam verify /tmp/atomic-receipt.json
```
Output: the same "Verified: all 3 steps finalized ..." text, and all three steps show the **same** Tx `0x533223b9...`.
Say: "Same three steps in one `Utility.batch_all`. SEAM only allows atomic mode because rollback was verified on this chain first."
Proves: the run file's `compiledMode` is `atomic_verified`, reason "rollback on failure has been verified on this runtime."

## 5. Rollback and a gate block, explained (50 s)

Recorded run: `evidence/devnode/runs/rollback-1792301012980.json` (a `batch_all` whose step 2 overdraws).

```bash
node --input-type=module -e '
import { explainSubmitCheck } from "@seam/sdk";
import fs from "fs";
const r = JSON.parse(fs.readFileSync("evidence/devnode/runs/rollback-1792301012980.json"));
console.log(explainSubmitCheck(r.run.check));
console.log(r.conclusion);
console.log(JSON.stringify(r.state));'
```
Output (abridged):
```
Not submitted:
- Blocked: the dry run of the signed transaction failed, so it would fail on chain.
Checks that passed:
- this step of the approval hasn't been sent before (approval_unused: ...)
- the approval hasn't expired (approval_valid_time: ...)
- the approval's contents still match its hash (approval_intact: ...)
- what is about to be sent is exactly what was approved (approval_matches: ...)
- the chain runtime is the one the plan was prepared for (runtime_unchanged: ...)
- the signed transaction bytes are exactly the approved calls (signed_bytes_match: ...)
ROLLED BACK: batch_all failed as a whole (ExtrinsicFailed, the inner error from step 2); step 1's transfer and step 3's mint left no events and no balance change. Only the fee was charged (nonce advanced).
```
Say: "The gate refused to send because the signed transaction would fail. Then, as a test-only bypass, we sent those exact signed bytes anyway: the whole batch failed, nothing from steps 1 and 3 stuck, only the fee was charged."
Proves: in `state`, `before.asset` and `after.asset` are identical (alice 999999955000, bob 45000, charlie 126) and `aliceNonce` goes 52 to 53; `directSubmit.dispatchError` is `assets.BalanceLow: Account balance must be greater than or equal to the transfer amount.`; `directSubmit` is labelled "test-only bypass of the gate, local dev chain".

Policy rules vs gate checks: `message_allowed`, `abi_pinned`, `selector_allowed` are **policy rules** (`policyResult.rules`); the gate's `passed` list holds the **submit-time** checks. See [reference](reference.md).

## 6. Console and close (10 s)

```bash
npm run dev -w @seam/console   # http://localhost:5173
```
Say: "The console shows the same flow. Next step is the Portaldot V3 testnet: [testnet-checklist.md](testnet-checklist.md)."
(The console starts with this command; what it shows was not re-verified for this script.)

## Honest limits to state if asked
- A second set of recordings came from a local Portaldot dev node (spec 1002, metadata V13, //Alice, throwaway chain): not the hosted testnet. The contract step there is a raw-data call to a hand-written Wasm emitter, not contract-by-message, and a mainnet-built plan is blocked at the gate on that node (fingerprint differs).
- Local dev chain only, spec 100 / metadata V14; signed with the public `//Alice` dev account.
- No Portaldot V3 testnet run, no testnet addresses or tx hashes yet.
- No run signed in a real browser wallet yet.
