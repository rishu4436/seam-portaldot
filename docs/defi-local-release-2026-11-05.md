# Local DeFi release — 2026-11-05

Branch: `codex/defi-local-20261104`. Based on the tested native-wallet release `e6a9eb2253cb035e25687fd7f681a569fe3a90fe`.

This release was built and tested locally before publishing its source. It does not replace the hosted Vercel application or Railway backend. No real testnet deployment, approval or economic transaction was submitted by this work.

## Delivered

- A separate DeFi workspace with protected swap, ERC-4626 deposit and full share redemption, balances/exit previews, exact review, responsive layout and reduced-motion support.
- An executable loopback-only reference market, disposable funded development accounts and a development-only unlocked-account connector. No wallet file, private key or password is read or stored. The connector and generated profiles are absent from production assets.
- Strict market and intent schemas; network/genesis/deployment/runtime-code identity checks; exact decimal base units; deadline, slippage, fee budget, scoped allowance and simulation checks.
- A postcondition guard that binds calls to its deployment ID, checks recipient balance changes, enforces minimum output/deadline/gas price, rejects replay and clears venue allowances atomically with the action.
- Durable pre-request claims, origin-wide exclusion, wallet-rejection handling and read-only hash/nonce recovery without resubmission. Settled records can be exported, removed and restored; unresolved claims cannot be removed.
- Independent economic receipt checks against canonical transaction bytes, historical code, guard events and token transfers. Network outages remain unknown; proven reverts are shown separately from pending execution. Local inclusion never becomes a testnet-finality claim.
- Atomic, bounded archive restore/deduplication; device-local pilot metrics with separate local/testnet counts; SDK example; threat model and costed-milestone worksheet for a future funding pilot.

## Validation

| Check | Result |
| --- | --- |
| Compiler | 359 passed |
| Policy | 452 passed |
| SDK | 478 passed |
| Chain | 407 passed; 13 opt-in tests skipped |
| DeFi contracts/execution | 21 passed on an isolated local chain |
| Console | 338 passed |
| Control-plane backend | 13 passed |
| Total passing | **2,068** |
| ESLint | Passed, zero warnings |
| Prettier | Passed |
| Production build | Passed |
| Quickstart commands | 20 passed, 9 setup/network commands skipped |
| Clean external SDK package install/consumer/CLI | Passed (`pack smoke OK`) |
| Runtime dependency audit | Zero advisories |
| Full development dependency audit | Three related high findings in Hardhat/Zod 3; documented below |

The full existing regression suite passed; after final review, the changed DeFi and console suites were run again. Tests include lost-response recovery, explicit rejection, uncertain claims, exact/reset allowances, adverse market movement, vault donation/rounding changes, fee overrides, stale quotes, on-chain deployment mismatch/deadline/gas-price enforcement, replay, storage failure, archive integrity, deduplication and settled-record removal. A reproduced wallet account-change race was fixed so that late balance reads cannot repopulate a disconnected account's positions; a completed transaction also clears its approval before an optional balance refresh.

Browser checks exercised actual local swap, deposit and full withdrawal through the final guard ABI. All three produced independently confirmed local effects; withdrawing all reference shares returned the position to zero. Earlier browser checks verified review invalidation, reload persistence, independent re-verification and archive restore confirmation/deduplication. The final workspace preserved native-wallet navigation. Mobile had no horizontal overflow. The production preview correctly showed an unconfigured/read-only V3 market and no unlocked local-account connector. Local visual captures are in the ignored `.vercel/qa/` directory.

The browser's native wallet is still the user's signer. Local tests do not prove a real wallet's V3 EVM compatibility, market liquidity, contract security, or mainnet readiness.

## Remaining gates

V3 DeFi submission is explicitly disabled. A read-only probe confirmed the expected EVM chain ID and finalized-block RPC, but no reviewed V3 swap/vault market, ERC-20 mapping, liquidity or exit was established. Enabling it requires the deployment and protocol review described in [the threat model](defi-threat-model.md). The local reference contracts are experimental and unaudited.

The runtime ABI dependency resolves patched Zod 4.6.7, and the compiler's `tmp` dependency is overridden to patched 0.2.7. Hardhat's separate localhost-only development dependency still requires Zod 3. The full audit reports three related high findings across Zod, Hardhat's Zod utility and Hardhat itself. They are not shipped in the browser runtime. Forcing the incompatible Zod 4 API into Hardhat was avoided; the upstream migration remains a development-tool maintenance item. See [the dependency boundary](defi-threat-model.md#dependencies).

Start with [the local run/test guide](defi-local.md). Funding work is an [internal milestone and pilot worksheet](defi-pilot-milestones.md), not a claim of adoption, revenue, partnership or grant eligibility.
