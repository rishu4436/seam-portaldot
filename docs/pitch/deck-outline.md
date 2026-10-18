# SEAM pitch deck outline (12 slides)

Status: DRAFT by Bot 1. Sources: README, `docs/demo-script.md`, `docs/reference.md`, evidence runs in `evidence/devnode/runs`. Event: DoraHacks Portaldot Hacker House 2026, Modular Cloud & Middleware track. Deadline Nov 6, 9:30 AM IST.
Honesty rule: all live proof is a local dev chain (spec 100). No Portaldot V3 testnet run yet. Put a small footer "Evidence: local test chain, not Portaldot" on slides 7-9.

1. **Title: SEAM**
   - The developer execution layer for Portaldot: one Manifest, one verified Receipt.
   - Team name, track, event, repo link.
   - Visual: logo plus the six-step console sidebar (Connect to Receipt) or a hero crop of the receipt screen.

2. **The problem**
   - Portaldot mixes execution surfaces (pallets like Assets, ink! contracts, batches); one intent needs several transactions and calls.
   - Today: hand-built calls, a runtime upgrade or missing pallet fails late, a signed tx can differ from what the user approved, and "success" is not checked against the chain.
   - Visual: sketch of a 3-step intent breaking halfway (step 2 fails, step 1 already sent).

3. **The solution**
   - Write one Manifest saying what should happen; SEAM compiles, checks, gets approval, has the user's wallet sign, sends step by step, and verifies the result.
   - SEAM never holds keys. Anything not allowed or unconfirmable is blocked.
   - Visual: Manifest JSON beside the final "3 of 3 steps verified" receipt (`sequential-5-receipt-v3.png`).

4. **Pipeline / architecture**
   - Manifest, runtime discovery, fingerprint + lock, compiler, preflight, policy, approval, wallet signing, per-step submit gate, finalization, verification, Execution Receipt.
   - Sequential (one tx per step) or atomic (`Utility.batch_all`, only when rollback is verified on that runtime).
   - Visual: the README pipeline diagram redrawn as two rows with icons; mark "wallet" as the only place keys exist.

5. **Built from the chain's own metadata**
   - Pallet and call indexes come from live metadata, never hard-coded; ink! calls by message name + pinned ABI.
   - An action SEAM cannot honestly compile is a plain answer, not a guess: `Nfts.mint cannot be compiled: no observed V3 Revive/Nfts metadata exists` (spec 1002).
   - Visual: terminal screenshot of `seam compile` on the missing-pallet Manifest (last line highlighted).

6. **What it blocks (real codes)**
   - Policy: `abi_pinned`, `message_allowed`, `selector_allowed`, amount/fee/weight limits, recipient and asset allow-lists.
   - Submit gate: `approval_reused`, `approval_expired`, `approval_tampered`, `approval_mismatch`, `runtime_changed`, `signed_bytes_mismatch`, `signed_dry_run_failed`, `out_of_order`, `abi_hash_mismatch`.
   - Visual: table of code to plain-English meaning (from `docs/reference.md`), with `signed_dry_run_failed` highlighted.

7. **Live proof 1: sequential and atomic**
   - Local chain: transfer, ink! `settle` call, mint. Sequential gave 3 txs, each gate-checked and verified by events (`ContractEmitted`).
   - Atomic: same 3 steps in one `batch_all`, one tx; allowed only as `atomic_verified`.
   - Visual: console receipts side by side (`sequential-5-receipt-v3.png`, `atomic-5-receipt-v3.png`). Runs: `sequential-1792301010881`, `atomic-1792301015006`.

8. **Live proof 2: the gate refuses, rollback holds**
   - Gate blocked a signed `batch_all` that would overdraw (`signed_dry_run_failed`, `assets.BalanceLow`); nothing sent.
   - Labelled test-only bypass: the whole batch failed, balances unchanged, only the fee charged (nonce 52 to 53).
   - Visual: `tc-rollback-checks-v4.png` (red block panel + rollback proof). Run: `rollback-1792301012980`.

9. **Reproduce it in one command**
   - `npm run test:e2e` starts a fresh local chain and runs all flows: 3 of 3 pass in about 15 s. Unit tests: compiler 105, policy 46, SDK 61, chain 54 (6 skipped).
   - Anyone can `seam verify` a receipt offline; digests match on any machine.
   - Visual: terminal with `Tests  3 passed (3)` and a `seam verify` output.

10. **Honest status and limits**
    - Done: compiler, policy, submit gate, chain layer, SDK/CLI, console, recorded local runs, automated tests.
    - Not done: no Portaldot V3 testnet run (RPC and faucet pending), no testnet addresses or tx hashes, no run signed in a real browser wallet; runs used the public `//Alice` dev account; mainnet is only a read-only snapshot (spec 1002, V13), so the V3 runtime (still the old contracts pallet?) must be re-checked.
    - Visual: a two-column "Shown / Not yet shown" table with green and amber marks.

11. **Roadmap**
    - Next (blocked only on RPC + faucet): V3 discovery, re-lock the fingerprint, re-check the compiler, run the demo flow, record contract address and tx hashes (`docs/testnet-checklist.md`).
    - Then: real browser-wallet signing, more actions (more pallets, XCM/CrossVM surfaces), agent-friendly SDK, policy presets.
    - Visual: timeline with a "PENDING testnet" milestone clearly marked; no dates beyond the Nov 6 deadline unless the team confirms them.

12. **Team and ask**
    - Team: names/roles TO FILL (Rishu plus the bot roles: UI, compiler/policy, chain, SDK/docs, QA, as the team wants to present).
    - Ask: Portaldot V3 testnet RPC URL + faucet access; feedback on runtime upgrade/metadata policy; a LICENSE decision is open internally (do not put on slide).
    - Visual: repo QR code, demo video link, contact. No fabricated links; fill after submission.

Notes
- 10-12 slides, about 2 minutes of speaking if presented alongside the video; slides 7-8 reuse video scenes 5-7.
- Add testnet slide (hashes, explorer link, address) after slide 8 only after the real run, copying values from the run file.
