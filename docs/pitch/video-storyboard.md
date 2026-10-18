# SEAM demo video storyboard (target 2:55, hard cap 3:00)

Status: DRAFT by Bot 1. Source: `docs/demo-script.md` (bot5/readme-judges), README, console screenshots in `/workspace/bot1-testchain-shots/` (v3/v4).
Deadline: Nov 6, 9:30 AM IST. Video must be 3 min or less.

**Honesty rule for the whole video:** every on-chain scene is from a **local dev chain, signed with the public `//Alice` dev account**: either the organizers' **local Portaldot dev node (spec 1002, metadata V13)**, recorded in `evidence/portaldot-local-node/`, or the earlier substrate-contracts-node run (spec 100, V14) in `evidence/devnode/`. Always say which one is on screen. Mainnet is a **read-only snapshot** (spec 1002, V13). **No Portaldot V3 testnet run exists yet.** Never show or say a testnet tx hash until Rishu's RPC/faucet run produces one. A persistent on-screen lower-third reads: `LOCAL TEST CHAIN, NOT PORTALDOT` (the console's green banner covers the substrate-contracts-node view; add it as a caption on terminal scenes). For the Portaldot node scenes the banner and caption read: `Local Portaldot dev node, spec 1002, not the public testnet`. The console and landing page now show that banner on every view.

Note: the written 3-minute script adds up to about 3:20 of spoken steps. This storyboard trims it to fit: the `npm run test:e2e` run is shown as a sped-up recording ending on `Tests  3 passed (3)` instead of live (about 15 s real time).

## Local Portaldot dev node scenes (new; use these in place of, or beside, scenes 5-7)

Open the console, click **Local Portaldot node, real run** in the sidebar (or the landing page section "Real run on a local Portaldot node"). Everything on that view is generated from `evidence/portaldot-local-node/` by `packages/console/scripts/import-local-node.mjs`. Read hashes off the screen; never retype them.

| Beat | On screen | Voiceover | Proves (file) |
|---|---|---|---|
| L1 | Banner `Local Portaldot dev node, spec 1002, not the public testnet`, then the Node and runtime card (spec 1002, V13, Contracts yes, Revive no). | "This is the organizers' own node, running on this machine. Same runtime family as mainnet, a throwaway chain. Not the public testnet." | `runtime-report.json` |
| L2 | Deploy card: tx `0xa635cbeb…1554`, block #79. Read the note under it. | "The demo contract in ink! 5 can't run on this older runtime, so we deployed a small hand-written Wasm emitter." | `runs/deploy-*.json` |
| L3 | Sequential card: pay #88, call #91, mint #94, gate row per step all passed. | "Three steps, three transactions, and the gate re-checks before each send. The contract step is a raw-data call, not a call by message name." | `runs/sequential-*.json` (`gateChecks`) |
| L4 | Atomic card: one batch, block #100, same tx on all three steps. | "The same three steps in one batch." | `runs/atomic-*.json` |
| L5 | Rollback card: gate blocked `signed_dry_run_failed`, nothing sent; labelled bypass fails with `assets.BalanceLow`; balances unchanged. | "The gate refused. We then sent those exact bytes anyway as a test. The whole batch failed with `BalanceLow` and nothing was left behind except the fee." | `runs/rollback-*.json` |
| L6 | "Not done yet" card, all PENDING. | "Not done yet: signing in a real browser wallet, and a run on the hosted V3 testnet." | none (PENDING) |

Do not call the contract step "contract by message" or "settle by name" in any Portaldot-node beat: it is raw data shaped like `settle(7, 2500)`. Scenes 5 and 7 above, which show a call by message name and a decoded `Settled` event, come from the **substrate-contracts-node** run (spec 100); say so when they are on screen.

## Scene table

| # | Time | On screen | Voiceover (plain, short) | Proves (real run file / output) |
|---|---|---|---|---|
| 1 | 0:00-0:12 | Console, receipt screen with the green banner "Real run on a local test chain, not Portaldot" (`rollback-5-receipt-v3.png` / live console). Caption: LOCAL TEST CHAIN, NOT PORTALDOT. | "SEAM is an execution layer for Portaldot. Everything you'll see ran on a local dev chain, not Portaldot V3 testnet. The testnet is the next step." | Honesty banner; `evidence/README.md` |
| 2 | 0:12-0:22 | Slide or console Manifest screen: one Manifest, three steps (pay, call `settle`, mint). | "One Manifest says what should happen: pay, call a contract, mint. SEAM does the rest." | `docs/examples/demo-manifest.json` |
| 3 | 0:22-0:45 | Terminal: `npx seam compile docs/examples/missing-pallet-manifest.json`. Zoom on last line. | "SEAM reads what the runtime really offers. A missing pallet is a plain answer, not a failed transaction." | Output ends `- nft: can't run, because Nfts.mint is not on this runtime (spec 1002).` (bundled mainnet snapshot, read only) |
| 4 | 0:45-0:55 | Terminal: sped-up `npm run test:e2e`, freeze on `Tests  3 passed (3)`. | "One command starts a fresh local chain and runs all three flows. Three of three pass." | `npm run test:e2e` output (real, about 15 s; record it, do not fake) |
| 5 | 0:55-1:30 | Terminal: `npx seam verify /tmp/sequential-receipt.json` (3 finalized steps, 3 different tx). Cut to console Receipt screen (`sequential-5-receipt-v3.png`): per-step tx, Contract Event, decoded `ContractEmitted: Settled`, submit gate list per step. | "Sequential: three steps, three transactions. The contract was called by name, `settle`, and verified by its event. Before each send, the gate re-checked everything." | `evidence/devnode/runs/sequential-1792301010881.json`; `gateChecks` has `sending` and `done` per step, all `ok: true`, with `passed` list |
| 6 | 1:30-1:55 | Terminal: `npx seam verify /tmp/atomic-receipt.json`; highlight same Tx `0x533223b9...` on all 3 steps. Then console atomic receipt (`atomic-5-receipt-v3.png`). | "Atomic: the same three steps in one `batch_all`. SEAM only allows this mode because rollback was verified on this chain first." | `evidence/devnode/runs/atomic-1792301015006.json`; `compiledMode` = `atomic_verified` |
| 7 | 1:55-2:40 | Console rollback receipt (`tc-rollback-checks-v4.png`): red "SEAM blocked this submission, Signed Dry Run Failed", "Nothing was sent", balances before/after identical. Scroll to Rollback proof panel: "Test-only bypass", `ExtrinsicFailed`, nonce 52 to 53. Optionally terminal `explainSubmitCheck` one-liner. | "Here the gate refused to send, because the signed transaction would fail. Then, as a labelled test-only bypass, we sent those exact bytes anyway. The whole batch failed. Steps one and three left nothing behind. Only the fee was charged." | `evidence/devnode/runs/rollback-1792301012980.json`: `directSubmit.dispatchError` = `assets.BalanceLow`; `state.before/after.asset` identical (alice 999999955000, bob 45000, charlie 126); `aliceNonce` 52 to 53; reason code `signed_dry_run_failed` |
| 8 | 2:40-2:52 | **PENDING (wallet signing; every run so far used the public //Alice key).** Wallet signing scene (browser wallet popup showing the exact call, then "signed"). See capture notes below. If no real browser-wallet run exists by recording day, replace with console Approve screen (`sequential-4-approve.png`) and say it is dev-account signing. | PENDING version: "SEAM never holds keys. Your own wallet signs, and the gate checks the signed bytes match the approval." Fallback: "On this local chain we signed with the public Alice dev account. A real wallet run is next." | Nothing yet. No browser-wallet run exists. Fallback proves only `signed_bytes_match` on the dev account |
| 9 | 2:52-3:00 | End card: repo URL, "Next: Portaldot V3 testnet (RPC + faucet pending)". | "Next step is the Portaldot V3 testnet. The repo and checklist are linked below." | `docs/testnet-checklist.md` (PENDING) |

Total: 3:00 at most. If over, drop scene 2 (10 s) and shorten scene 4.

## PENDING scenes (do not fabricate)

Still PENDING and never to be shown as done: browser-wallet signing, anything on the hosted Portaldot V3 testnet, and a contract call by message name on the Portaldot runtime (needs an ink! 3-era demo contract).


| Scene | What to capture once Rishu provides RPC and faucet |
|---|---|
| P1: V3 runtime discovery | `seam compile` against the live V3 endpoint, showing the real spec version and whether the contracts pallet is the old one. Capture terminal output with the endpoint URL visible. |
| P2: testnet run | Run the demo flow per `docs/testnet-checklist.md`; show real contract address and tx hashes **copied from the run file**, plus `seam verify` output. Show the block explorer page for at least one hash if one exists. |
| P3: browser-wallet signing | Console connected to the testnet, wallet popup, signed, gate passes, receipt verified. |
| P4: runtime check | Optionally show `runtime_changed` or `runtime_unchanged` against the live testnet. |
If P2 is done before the deadline, swap scenes 5-6 for it and keep the rollback proof labelled local.

## Recording checklist

**Setup**
- Screen: 1920x1080, 30 fps, record at 100% browser zoom (the console is dense; use 110-125% zoom only for receipt/gate panels). Hide bookmarks, notifications, other tabs. Dark OS theme to match the console.
- Cursor: large visible cursor, with a click highlight if the recorder offers one; move slowly; no hovering over hash text while talking.
- Terminal: 18-20 pt monospace (JetBrains Mono / Menlo), dark theme, about 90 columns wide, clear scrollback before each take. Run `npm install && npm run build` beforehand and pre-write the `/tmp/*-receipt.json` files (command in demo-script section 0).
- Audio: external or headset mic, quiet room, one voiceover pass recorded separately, then synced. Keep about 140 words per minute (total script about 400 words).
- Captions: burn in the short voiceover lines and the lower-third LOCAL TEST CHAIN, NOT PORTALDOT.

**Capturing console states**
1. `npm run dev -w @seam/console` then open http://localhost:5173.
2. Sidebar "Data source": choose **Test chain, real run**. Under "Recorded run", pick Sequential, Atomic, then Rollback proof. These replay recordings of real runs (the console says it is not connected live), which is fine; say "recorded run" if asked.
3. Walk Connect, Manifest, Plan, Checks, Approve, Receipt for the sequential run (existing frames: `sequential-0-connect`, `-2-plan-v3`, `tc-sequential-checks-v4`, `-4-approve`, `-5-receipt-v3`). Rollback: `tc-rollback-checks-v4` shows the block, gate list and bypass proof in one page.
4. For the mainnet-snapshot Checks view (`mainnet-happy-policy-v4`, banner says tx hashes are simulated), only use it if you say "saved snapshot of the Portaldot node, simulated replies"; it is optional and not in the cut above.
5. Prefer live recording over stills; use PNGs from `/workspace/bot1-testchain-shots/` only as fallback inserts or thumbnails. Re-take the screenshots if the console changed after the `bot1/console-passed` merge or the landing page branch.
6. Check every hash on screen exists in the run file; never retype hashes.

**Wallet-signing scene (needs a real browser)**
- Needs a browser extension wallet (e.g. Talisman / SubWallet / polkadot-js) installed in the recording browser with a funded account on the target chain. The box/headless setup cannot do this; Rishu or whoever has the wallet must record it.
- Against the local dev chain, import a dev account only if the wallet supports it; otherwise this must wait for the testnet account funded by the faucet.
- Capture: wallet popup showing the call details, the Approve click, then the gate list with `signed_bytes_match`. Blur nothing except seed or private data; never show a seed phrase.
- Not done as of now: no run has been signed in a browser wallet. State this honestly if the scene is cut.

**Final checks before upload**
- Length under 3:00 on export (aim 2:55). Export MP4 H.264, 1080p.
- Every claim has an on-screen source; "testnet" appears only as "next step".
- Upload target and link per `docs/submission-checklist.md`; deadline Nov 6, 9:30 AM IST.
