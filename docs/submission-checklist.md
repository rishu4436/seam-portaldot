# Portaldot Hacker House 2026: submission checklist

Status is **done** or **pending**, based on what is in the repo at the commit you are reading (check `git log`; no commit is pinned here). All times IST. Source for the rules: the DoraHacks page, read Oct 11, 2026. Re-check it before each deadline.

**There are no testnet results yet.** Every on-chain run in `evidence/` is from one of two local chains (a `substrate-contracts-node` dev chain and a local Portaldot dev node, spec 1002). Neither is the Portaldot V3 hosted testnet or mainnet, and neither shows V3 or Revive support.

## Rules and key dates
- Track: Modular Cloud & Middleware. Judging: feasibility 30, innovation 30, ecosystem 20, business 20.
- Code must be written Oct 14 to Nov 6, 2026. Check-in is **Oct 24, 5:30 PM** (testnet contract addresses and tx hashes required). Final deadline and code freeze **Nov 6, 9:30 AM** (04:00 UTC). Demo day Nov 8 to 9. Office hours (optional) are Oct 28 and 29; apply by Oct 27.

## Rules compliance
- [x] Repo is public (`rishu4436/seam-portaldot`). Owner: Rishu. Done.
- [ ] At least 3 real commits inside Oct 14 to Nov 6. Owner: all. **Pending, only partly met.** `git log` has 135 commits: 116 dated Oct 11 (before the window) and 19 dated Oct 18. Inside the window there are 19 commits (14 non-merge, 5 merges), all on one day, Oct 18. Keep committing across the period; don't land everything in the last 24 hours.
- [ ] Keep the screenshot of the Portaldot team allowing early coding, in case judges ask about the Oct 11 commit dates. Owner: Rishu. Pending.
- [ ] Deployed on the Portaldot testnet with real on-chain activity. Owner: Bot 4 and Rishu. Pending (needs the V3 RPC and faucet).

## Submission items
- [x] README. Owner: Bot 5, branch `bot5/readme-judges`. Done (merged).
- [x] Docs: `docs/quickstart.md`, `docs/reference.md`, `docs/examples/`, `evidence/README.md`. Owner: Bots 2 and 5. Done. The demo script and testnet checklist (`docs/demo-script.md`, `docs/testnet-checklist.md`) are pending on `bot5/readme-judges`.
- [x] Runnable code. Owner: all. Done: `npm install && npm run build && npm test` (see `docs/quickstart.md`).
- [x] `npm run test:e2e`: starts a fresh local dev chain and runs the sequential, atomic and rollback flows. Owner: Bot 6. Done (PR #2). It is not in CI because the test chain download is about 100 MB.
- [x] One-command quickstart in the root README. Owner: Bot 5. Done.
- [ ] Testnet info (V3 RPC, faucet). Owner: Rishu. Pending.
- [x] `scripts/testnet-run.mjs`. Owner: Bot 4, branch `bot4/testnet-ready`. Done (merged). Tested on the local dev node only; not yet run on Portaldot V3. Docs: `packages/chain/docs/testnet-run.md`.
- [ ] Addresses and tx hashes file under `evidence/` (testnet). Owner: Bot 4. Pending. Today `evidence/devnode/` holds local-chain recordings only.
- [x] Architecture diagram (required at check-in). Owner: Bot 1. Done (`docs/architecture.md`).
- [ ] Demo video of 3 minutes or less, showing the real product and how it uses Portaldot. Owner: Bot 1. Storyboard drafted in `docs/pitch/video-storyboard.md`; recording pending (needs the real testnet run).
- [ ] Pitch deck: problem, why Portaldot, proof it works. Owner: Bot 1. Outline drafted in `docs/pitch/deck-outline.md`; slides pending.
- [x] No secrets in the repo. Owner: Bot 6. Done at the time of that grep (re-run it before freeze; no commit pinned here): a grep over tracked files for private-key blocks, AWS and `sk-`/`xai-` style keys, and `api_key`/`secret`/`mnemonic = "..."` assignments found nothing, and no `.env` or `.pem` files are tracked. This was a quick scan, not a full audit. Re-run it before submitting.
- [ ] LICENSE file. Owner: Rishu. **Pending: there is no license file** and GitHub shows no license. Pick one (for example MIT or Apache-2.0), because the Ecosystem criterion is about open-source use.

## Date targets (ours)
- [ ] Oct 22: real testnet transactions from the demo flow, saved to `evidence/`.
- [ ] Oct 23: check-in video recorded.
- [ ] Oct 24, 5:30 PM: check-in. Needs progress notes, the public repo, an architecture diagram, testnet addresses and hashes, and a demo or a video of 3 minutes or less.
- [ ] Nov 3: feature freeze, with the final video and deck done.
- [ ] Nov 6, 9:30 AM: final deadline.

## Rishu only
- [ ] Send the V3 RPC URL and faucet to the team.
- [ ] Keep the screenshot proving the Portaldot team allowed early coding.
- [ ] Revoke the old Binance Web3 API key from the previous project.

## Where we earn the judging points
| Criterion | Weight | Evidence in the repo now |
|---|---|---|
| Technical feasibility | 30 | Compiler, policy, SDK and chain test suites, plus `npm run test:e2e` on a local dev chain. Testnet transactions: pending. |
| Innovation | 30 | One Manifest compiled from live metadata, runtime lock, approval binding, verified receipts, ink! contract calls by ABI. |
| Ecosystem contribution | 20 | Open-source SDK, CLI and docs. A license file is still needed. |
| Business potential | 20 | RuntimeGuard as a hosted service, and SEAM as the safety layer for wallets and AI agents. Pitch deck pending. |
