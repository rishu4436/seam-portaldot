# Portaldot Hacker House 2026: submission checklist

Status is **done** or **pending**, based on what is in the repo at the commit you are reading (check `git log`; no commit is pinned here). All times IST. Source for the rules: the DoraHacks page, read Oct 11, 2026. Re-check it before each deadline.

**Several Portaldot V3 testnet runs exist** (every hash, block and verification file: [evidence-manifest.md](evidence-manifest.md)). Besides two local chains (a `substrate-contracts-node` dev chain and a local Portaldot dev node, spec 1002, neither showing V3 or Revive support), the hosted Portaldot V3 testnet (spec 3002) was used in one funded run (two phases, 18 finalized transactions, [`evidence/testnet-v3`](../evidence/testnet-v3/README.md)): Assets, Nfts, SEAM sequential and `atomic_verified` plans, `Utility.batch_all` rollback, an EVM contract deploy and a SEAM `revive.call` are verified there; a per-call Revive effect (V3 has no such event), a fresh account mapping, ink!/PolkaVM, and cross-VM atomicity are not. Later console runs were signed through the polkadot.js extension and independently verified: #118310, #119634, #119996, #120936 (step 1 of 2) and the 2-step sequential run #121390/#121394.

## Rules and key dates
- Track: Modular Cloud & Middleware. Judging: feasibility 30, innovation 30, ecosystem 20, business 20.
- Code must be written Oct 14 to Nov 6, 2026. Check-in is **Oct 24, 5:30 PM** (testnet contract addresses and tx hashes required). Final deadline and code freeze **Nov 6, 9:30 AM** (04:00 UTC). Demo day Nov 8 to 9. Office hours (optional) are Oct 28 and 29; apply by Oct 27.

## Rules compliance
- [x] Repo is public (`rishu4436/seam-portaldot`). Owner: Rishu. Done.
- [x] At least 3 real commits inside Oct 14 to Nov 6. Owner: all. Done, by git author date at `7a551e3`: 385 commits in total, 116 dated Oct 11 (before the window) and 269 inside it (204 non-merge, 65 merges) on Oct 18 (157), Oct 19 (23) and Oct 20 (89). Keep committing across the period; don't land everything in the last 24 hours. Recount with `git log --format=%ad --date=short | sort | uniq -c`.
- [ ] Keep the screenshot of the Portaldot team allowing early coding, in case judges ask about the Oct 11 commit dates. Owner: Rishu. Pending.
- [x] Deployed on the Portaldot testnet with real on-chain activity. Owner: Bot 4 and Rishu. Done: funded V3 run (spec 3002), hashes in [`evidence/testnet-v3`](../evidence/testnet-v3/README.md).

## Submission items
- [x] README. Owner: Bot 5, branch `bot5/readme-judges`. Done (merged).
- [x] Docs: `docs/quickstart.md`, `docs/reference.md`, `docs/examples/`, `evidence/README.md`. Owner: Bots 2 and 5. Done, including `docs/demo-script.md` and `docs/testnet-checklist.md`.
- [x] Runnable code. Owner: all. Done: `npm install && npm run build && npm test` (see `docs/quickstart.md`).
- [x] `npm run test:e2e`: starts a fresh local dev chain and runs the sequential, atomic and rollback flows. Owner: Bot 6. Done (PR #2). It is not in CI because the test chain download is about 100 MB.
- [x] One-command quickstart in the root README. Owner: Bot 5. Done.
- [x] Testnet info (V3 RPC, faucet). Owner: Rishu. Done: `wss://test-node-v3.portaldot.dev` / `https://test-node-v3.portaldot.dev` (spec 3002); faucet funding received for the funded run.
- [x] `scripts/testnet-run.mjs`. Owner: Bot 4, branch `bot4/testnet-ready`. Done (merged). Local-node tested; funded V3 run used `scripts/v3-funded-run.mjs` (see `evidence/testnet-v3/`). Docs: `packages/chain/docs/testnet-run.md`.
- [x] Addresses and tx hashes file under `evidence/` (testnet). Owner: Bot 4. Done: [`evidence/testnet-v3/README.md`](../evidence/testnet-v3/README.md) (local-chain recordings remain under `evidence/devnode/`).
- [x] Architecture diagram (required at check-in). Owner: Bot 1, refreshed by Bot 5. Done (`docs/architecture.md`, `docs/img/architecture.{mmd,svg,png}`).
- [ ] Demo video of 3 minutes or less, showing the real product and how it uses Portaldot. Owner: Bot 1. Storyboard drafted in `docs/pitch/video-storyboard.md`; recording pending (the real testnet runs now exist).
- [ ] Pitch deck: problem, why Portaldot, proof it works. Owner: Bot 1. Outline drafted in `docs/pitch/deck-outline.md`; slides pending.
- [x] No secrets in the repo. Owner: Bot 6. Done at the time of that grep (re-run it before freeze; no commit pinned here): a grep over tracked files for private-key blocks, AWS and `sk-`/`xai-` style keys, and `api_key`/`secret`/`mnemonic = "..."` assignments found nothing, and no `.env` or `.pem` files are tracked. This was a quick scan, not a full audit. Re-run it before submitting.
- [x] LICENSE file. Done: Apache-2.0 (`LICENSE`).

## Date targets (ours)
- [x] Oct 22: real testnet transactions from the demo flow, saved to `evidence/`. Done early: console runs #118310 to #121394, see [evidence-manifest.md](evidence-manifest.md).
- [ ] Oct 23: check-in video recorded.
- [ ] Oct 24, 5:30 PM: check-in. Needs progress notes, the public repo, an architecture diagram, testnet addresses and hashes, and a demo or a video of 3 minutes or less.
- [ ] Nov 3: feature freeze, with the final video and deck done.
- [ ] Nov 6, 9:30 AM: final deadline.

## Rishu only
- [x] Send the V3 RPC URL and faucet to the team. Done: `wss://` / `https://test-node-v3.portaldot.dev`; funding received.
- [ ] Keep the screenshot proving the Portaldot team allowed early coding.
- [ ] Revoke the old Binance Web3 API key from the previous project.

## Where we earn the judging points
| Criterion | Weight | Evidence in the repo now |
|---|---|---|
| Technical feasibility | 30 | Compiler, policy, SDK and chain test suites, plus `npm run test:e2e` on a local dev chain. V3 testnet transactions with independent verification files ([evidence-manifest.md](evidence-manifest.md)). |
| Innovation | 30 | One Manifest compiled from live metadata, runtime lock, approval binding, verified receipts, ink! contract calls by ABI. |
| Ecosystem contribution | 20 | Open-source SDK, CLI and docs under Apache-2.0. |
| Business potential | 20 | RuntimeGuard (offline drift and runtime-lock checks today; a hosted service is a roadmap idea, not delivered), and SEAM as the safety layer for wallets and AI agents. Pitch deck pending. |
