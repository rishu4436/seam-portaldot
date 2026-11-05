# V3 test market setup — 5 November 2026

This release removes the three related development dependency findings and prepares the wallet-driven V3 DeFi test market. The existing native transaction workspace and hosted Railway backend remain available. **A persistent V3 market and its liquidity are not deployed until the user approves market creation in their EVM wallet.** Source review and VM simulation do not replace that acceptance step.

## Delivered

- Removed Hardhat and its vulnerable Zod 3 path. The isolated loopback runner uses the pinned official Anvil 1.7.1 native package; version and network restrictions are checked. Full and runtime dependency graphs report zero npm advisories.
- Added an atomic test-market factory: two valueless faucet tokens, seeded constant-product liquidity, an asset-holding ERC-4626 vault and the postcondition guard. The creator receives test assets; other addresses can claim once. There is no yield strategy, APY, external protocol integration, monetary backing or independent audit.
- Bundled reproducible creation bytecode, runtime templates and compiler-declared immutable bindings. Imported profile hashes or a copied review ID cannot establish trust. All six deployed programs and the exact canonical, finalized factory creation transaction are checked against the bundled source build.
- Added explicit wallet setup, V3 network selection, native funding-destination resolution through `ReviveApi_account_id`, EVM balance/shortfall and buffered cost review. Gas limits have a 20% buffer plus 5,000 gas; setup has a 10% gas-price buffer, with zero priority fee. Fresh estimates cannot exceed the approved total or gas-price ceiling. Native and EVM decimal units and signing accounts remain distinct.
- Added durable pre-request setup/faucet journals, one origin-wide wallet lock shared with economic sends, explicit rejection handling, bounded no-hash recovery and optional wallet-provided transaction-hash reconciliation. Hash recovery checks the original nonce, full payload, canonical receipt and cost limits; it never resends or clears a claim merely because a hash was supplied.
- Creation waits for finalized inclusion before enabling the market. A longer finality/RPC delay leaves the confirmed request recoverable. A market profile can be exported, restored after source checks, or reconstructed using its creation transaction from a share link.
- Added pre-approval approval/action cost previews using read-only storage overrides. Budget increases clear the quote and review. The executor conservatively carries forward submitted gas-limit ceilings across steps, and independent receipt checks reject an excessive aggregate upfront ceiling even when actual reported gas fees are small.

## Validation

The accompanying [V3 VM proof](defi-v3-simulation-2026-11-05.json) records exact source/compiler and input hashes. The read-only harness created the exact market, swapped 100 sUSD, deposited 100 sUSD, then fully redeemed its shares on V3's actual VM. Storage override support was separately checked. No state was committed, wallet signature requested, or user funds spent by this simulation.

| Check | Result |
| --- | --- |
| Compiler | 359 passed |
| Policy | 452 passed |
| SDK | 478 passed |
| Native chain | 407 passed; 13 existing opt-in skips |
| DeFi contracts/execution | 29 passed |
| Console | 340 passed |
| Control plane | 13 passed |
| Unique passing tests | **2,078** |
| ESLint | Zero warnings |
| Formatting and production build | Passed |
| Quickstart | 20 passed; 9 setup/network commands skipped |
| External package/consumer/CLI smoke | Passed |
| Full npm audit | Zero findings |

The first full console run hit a five-second deadline in one unchanged real-metadata integration case. All seven assertions/cases in that file passed on isolated recheck. That single expensive case now has a 20-second test deadline, with all assertions retained; the full console suite passed afterward. The affected DeFi and wallet UI checks were rerun after the final wallet-cost changes. CI also now runs the full npm advisory check.

Desktop and 390-pixel mobile preview checks found no horizontal overflow. Invalid market hashes produced a clear failure without connecting a wallet. The production output excludes the unlocked development connector. Source and static release output are scanned for actual stored application credentials before publication. The existing backend health check returned HTTP 200 / `ok`.

## Live wallet acceptance

Open [the DeFi workspace](https://seam-portaldot.vercel.app/console.html?view=defi) in a browser with a fresh EVM test wallet. Select **Connect test wallet for setup**, then **Check funding & deployment cost**. Connection and reads require no transaction signature. Review the runtime-resolved native destination before funding it from the native test account. Refresh the estimate afterward. Setup creation needs more upfront tPOT than the final fee may consume; use the current wallet-specific estimate and keep a margin for the later actions.

Only then review and approve **Create test market in wallet**. Wait for finality and deployed-source checks. Connect the EVM wallet in the trading panel, confirm the creator's test balances, swap in both directions, deposit and fully withdraw shares. Review exact allowances and each cost ceiling. Test rejection, refresh/recovery, independent finalized verification, receipt export and deduplicated restore. Export the market profile and share its creation transaction so the deployment can be independently checked and selected as a default in a later release.

The engineering review and remaining valuable-asset gates are documented in [the review](defi-v3-engineering-review.md) and [threat model](defi-threat-model.md). No independently audited protocol, organic liquidity, production TVL, user adoption or completed real-wallet V3 economic flow is claimed by this release.
