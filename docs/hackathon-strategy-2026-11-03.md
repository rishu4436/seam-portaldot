# SEAM: a stronger Portaldot Hacker House entry

Research date: 3 November 2026, Asia/Calcutta. This is a product and delivery assessment, with a demo outline for the team to adapt in its own words. It does not predict a prize or supply completed submission-field answers.

## Recommendation

Make SEAM the easiest way for a Portaldot application developer to execute a constrained transaction workflow and prove what happened. Center the presentation on a single real task: prepare a transfer, enforce the recipient and spending rules, sign the approved bytes with an external wallet, wait for finalization, then independently verify the receipt. Demonstrate a changed recipient being refused before signing.

The implementation has unusually substantial engineering evidence: five packages, deterministic compilation, policy and runtime binding, per-step gates, receipt verification, adversarial regressions and disposable-chain integration tests. The largest remaining competitive gaps concern proof of a fresh hosted-wallet journey, how quickly a new developer can integrate it, and whether someone outside the team wants it. Additional dashboards will contribute less before the deadline than closing those gaps.

## Event facts that change the plan

The official event page gives the final deadline/code freeze as **6 November, 04:00 UTC / 09:30 IST**. Judging weights are technical feasibility 30%, innovation 30%, ecosystem contribution 20% and business potential 20%. The final video is limited to three minutes. Requirements include a public repository, runnable code/demo, deployment information and a pitch deck. Code should primarily originate during the event; at least three valid commits are required, and core final versions must not all arrive in the last 24 hours. Substantial post-freeze changes are restricted. These facts were read directly in the browser because the page rejected the web fetcher. [Official event details](https://dorahacks.io/hackathon/portaldot-hacker-house-2026/detail).

The repository already contains several genuine commits within the event period, including four on 1 November. The current security, redesign and lint changes need a deliberate source release so the public repository can reproduce the hosted app. Preserve the real history. A practical target is to publish the core final changes before **5 November, 09:30 IST**, leaving the final day for verification and submission preparation.

The existing `docs/demo-script.md` is a five-minute walkthrough. Keep it as extended technical material and produce a separate three-minute final video.

## Fit to the judging criteria

These are my assessments of the repository, rather than predicted judge scores.

| Criterion              | Existing strength                                                                                                                      | Gap that would most improve the evidence                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Technical delivery     | Real metadata compilation, external signing path, signed-byte checks, finalized receipts, historical V3 records and a green test suite | Record a fresh complete flow from the deployed origin; include its transaction hashes and independent verification output |
| Innovation             | One approval binds intent, plan, runtime, policy, preflight and signing envelope; effect claims are checked after execution            | Explain the concrete failure prevented at each boundary. Show that tampered or reused evidence is refused                 |
| Ecosystem contribution | Reusable compiler/policy/chain/SDK packages and consumer integration example                                                           | Have one separate app consume the SDK and display a verified result without importing repository internals                |
| Business potential     | Clear potential buyer: teams shipping Portaldot DApps or wallet-assisted automation                                                    | Interview three developers; record their current workflow, pain, willingness to integrate and next commitment             |

The visual redesign helps judges navigate the product. Its most valuable role is making the trust boundaries visible: what is proposed, what is approved, what the wallet signs, and what the chain proves.

## The actual competitive landscape

I inspected the event's current build listing and two close entries, then opened both live products. This is a focused sample, not an exhaustive review or a ranking of submissions. Their descriptions and visible UI establish scope; I did not test their signing or audit their code. [Event build directory](https://dorahacks.io/hackathon/portaldot-hacker-house-2026/build).

| Reference        | What the inspected evidence shows                                                                                                                                                       | Consequence for SEAM                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChainRelay Recon | Its submission and live homepage describe transfer-intent, balance, fee and preflight diagnostics. The homepage explicitly says it does not sign, submit or verify on-chain execution   | Lead with the full approval → signed bytes → submission → finalized-effect path and independently replayable receipt. Preflight alone is weak differentiation                                 |
| PortalGuard      | Its submission describes a browser warning, approval scanner, capped/expiring permissions and an on-chain drainer registry. Its live page exposes the scanner and a SafeApprove address | Avoid a generic “wallet safety” pitch. Explain SEAM's developer-facing execution contract and evidence verification, including capabilities beyond EVM token approvals                        |
| Polkadot-API     | Current official documentation describes metadata-generated types, transactions, storage/events/runtime calls, runtime compatibility checks and extension signers                       | Claiming metadata-driven encoding alone is insufficient. Focus on the policy/approval/effect-verification layer built around execution                                                        |
| Tenderly         | Its current simulation documentation describes transaction and bundle simulation, traces, gas and balance/storage changes                                                               | Distinguish pre-execution estimates from finalized observations. SEAM should show both and preserve unknown coverage accurately                                                               |
| Txtx             | Its repository and current documentation describe declarative operational runbooks and browser signing. Colosseum's record lists it as Radar's first-place Infrastructure winner        | A reusable execution workflow can be a strong infrastructure presentation. The useful lesson is a concrete developer job and reproducible operation; the award does not predict SEAM's result |

Sources: [ChainRelay submission](https://dorahacks.io/build/50221), [ChainRelay live](https://chainrelay-sepia.vercel.app/), [PortalGuard submission](https://dorahacks.io/build/50703), [PortalGuard live](https://blucewill.github.io/PortalGuard/), [Polkadot-API](https://papi.how/), [Tenderly simulation docs](https://docs.tenderly.co/simulations/overview), [Txtx repository](https://github.com/solana-foundation/txtx), [Txtx language docs](https://docs.txtx.sh/language), [Txtx award record](https://colosseum.com/projects/explore/txtx).

The Colosseum comparison used winner-filtered discovery and the full Txtx record. Its repository summary was captured in June 2025; its current repository/docs were checked separately. The old `txtx.sh` homepage did not load, so no current hosted-product claim relies on it. The Grid returned Polkadot records but no matching Tenderly/Txtx records in the limited name query. That gap is coverage uncertainty, not evidence those competitors are absent. No paid research was used.

## Highest-value work before code freeze

| Priority | Work                                                                           | Completion evidence                                                                                                |
| -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| P0       | Test the hosted app with the actual wallet extension and a funded test account | A fresh finalized transaction from the deployed origin; saved receipt and independent chain verification           |
| P0       | Establish an honest first-use path                                             | Exact wallet/network instructions, native gas funding route, and a usable asset ID with an owned balance           |
| P0       | Rehearse cancellation and refusal                                              | Wallet rejection, changed recipient, expired approval and wrong network each stop safely; no unintended broadcasts |
| P0       | Record the three-minute walkthrough                                            | A publicly accessible video that shows a real wallet interaction, transaction hash and proven effect               |
| P1       | Show a minimal separate-app integration                                        | A small consuming app imports the SDK packages and uses the same policy/gate/receipt flow                          |
| P1       | Tie technical claims to clickable evidence                                     | A compact index maps claim → runtime → block/tx → verification method → limitation                                 |
| P1       | Gather external feedback                                                       | Three observed developer sessions and one concrete integration commitment, with consent to quote any feedback      |

Native testnet gas and Assets balances are separate. The current builder sends `assets.transfer`, which needs an existing asset ID and a balance in that asset. Receiving native tPOT alone does not make that action runnable. The official event page describes participant token distribution through the organizer's Discord; do not invent a public faucet or automatic asset provisioning. Use a known, controlled test asset for the first rehearsal and document the setup.

The public website uses the Vercel production domain while execution remains restricted to the hosted V3 testnet. Mainnet submission should stay blocked.

## Three-minute demo outline

This is a sequence to rehearse, not narration to paste into the submission.

1. **0:00–0:20 — A concrete developer problem.** An app needs to send an exact asset amount to an allowed recipient and prove completion. Show the intent and the one relevant rule.
2. **0:20–0:45 — Read and prepare.** Show the live V3 identity, compiled action and readable policy review. Keep hashes behind technical details until they matter.
3. **0:45–1:05 — Show one failure that matters.** Change the recipient or amount. The approval becomes invalid and the gate explains the refusal. No wallet prompt or transaction should follow this path.
4. **1:05–1:55 — Execute the permitted intent.** Restore the intended values, approve, sign in the real wallet, and show finalization. Rehearse actual network latency beforehand.
5. **1:55–2:35 — Verify independently.** Open the transaction hash and re-check the exported receipt against chain data. Explain what is proven and any remaining unknown effect coverage.
6. **2:35–3:00 — Show reuse and next adoption.** A separate-app SDK call or integration example connects the product to the developer buyer. State one measured next milestone.

Prepare the account, asset and contract permissions before recording. Keep a clearly labelled recording as an outage fallback; do not present it as a new live transaction. A simple flow completed reliably is sufficient for the first version. A multi-action sequence can follow once the single-action rehearsal is dependable.

## Claims to keep precise

- A receipt hash detects edits relative to a saved digest; independent chain reads establish execution evidence.
- A transaction being finalized is different from proving the intended effect. Unknown effects must remain visible.
- Atomicity requires rollback evidence for the relevant runtime and composition. Preserve the scope of existing proofs.
- Existing V3 records cover native Assets/NFT and Revive/EVM operations. The fresh ink! contract integration test runs on a local chain. Do not claim fresh V3 WASM execution or cross-VM atomicity from that test.
- Passing tests and removing lint warnings demonstrate engineering discipline. They are not a formal security audit.
- Hosted monitoring, paying customers, broad wallet compatibility and production SLAs are future work unless separately measured.

## Taking SEAM beyond this hackathon

The strongest long-term direction is a developer execution SDK with an optional hosted verification/operations service. Keep wallet custody with the user. Let applications integrate policy, approvals and receipts through a small API; make the console a reference consumer of that API.

For the first month, prioritize three design partners over adding chains. Observe a real release/treasury/fulfilment workflow, integrate one recurring operation, and measure time to the first verified transaction. A reasonable experiment is to compare the developer's current process with a SEAM integration and record the actual reduction in setup and debugging effort.

For a subsequent release, consider finalized-block state readers with explicitly scoped assertions, durable team evidence storage, runtime-change review and resumable execution/reconciliation. Each requires an explicit trust model. State readers should bind observations to a finalized block and authenticated RPC responses; a caller's asserted `actual` value must never become proof again. Hosted checks should be read-only unless the user has explicitly approved a transaction in their wallet.

Test the commercial hypothesis with developers first. Possible paid value lies in team audit trails, retained independent verification and runtime-change operations. Treat pricing, demand and willingness to pay as hypotheses. Do not introduce a token or an extra chain solely to expand the presentation.

## Measures that would make the case stronger

Track these as observations, rather than invented traction targets presented as results:

- Time from opening the deployed app to a valid review, and from approval to a verified finalized receipt.
- Successful and failed complete flows, separated by wallet, browser, RPC and action kind.
- Refusals for wrong network, changed recipient, edited signed bytes, stale approval and reused evidence, with zero unexpected submissions.
- First successful SDK integration by a developer outside the team, and the changes they needed.
- Actual initial network payload and time to interactive. The roughly 295 kB console entry is one chunk; shared vendor/runtime chunks also load.
- Evidence that at least one potential adopter wants to keep using the workflow after the hackathon.

The next decision should follow the hosted wallet rehearsal. Its failures will identify the most valuable product work more reliably than a broad feature wishlist.
