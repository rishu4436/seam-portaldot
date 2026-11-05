# V3 test market engineering review — 5 November 2026

This is a source and integration review by the coding agent, backed by executable checks. **It is not an independent security audit, an external protocol review, or approval for assets with monetary value.** The contracts are isolated test fixtures. No live deployment, liquidity or wallet acceptance is established by this document alone.

## Reproducible program

Sources: `contracts/defi/SeamDeFi.sol`, `SeamTestMarket.sol`, and the read-only `SeamV3Scenario.sol` harness. Compiler: pinned Solidity 0.8.38; OpenZeppelin Contracts 5.6.1; Cancun EVM; optimizer 200; via-IR; metadata bytecode hash disabled. `npm run defi:review` compiles and regenerates the tracked `packages/defi/src/reviewed-v3.ts` anchor. Tests compare that bundled factory creation program with freshly compiled source.

The browser does not trust a profile's own code hashes as proof of review. It compares every byte of all six deployed contracts against the bundled program, replacing only compiler-declared immutable slots with the expected factory, deployment ID, token addresses and decimal precisions. The factory's canonical successful creation transaction must have the exact bundled creation input, zero native value, expected deployer and matching contract address. V3 creation and economic receipts require finalized inclusion. A copied review ID cannot bless different bytecode.

Network: chain 420420777, official EVM endpoint `https://test-evm-rpc-v3.portaldot.dev/`, EVM block-zero hash `0x7c05b2dc7486f81a693d676553fa13f380b5be16da7c739b182931cd6cf07001`. The native Substrate genesis is different. Native asset 806707 is not represented by either test token.

## Source review

| Boundary | Finding and treatment |
| --- | --- |
| Test token issuance | Only the immutable issuer can mint. In the factory deployment the issuer is the factory, whose sole public minting path grants a fixed allocation once per address. Anyone can create more addresses. Assets have no monetary value or promised backing. |
| Atomic market creation | Only local 31337 and V3 420420777 are allowed. Creation either initializes all five children and seed positions or reverts. It accepts no native value. |
| Liquidity | Seed: 1,000,000 sUSD and 500 sETH. Initial LP shares belong to the deploying wallet, except the minimum burned shares. That wallet can remove its liquidity through the pool contract. Availability must be re-read before every swap; it is not locked or organic TVL. |
| Vault | OpenZeppelin ERC-4626 asset-holding vault; no strategy, borrowing or APY. Seed 1,000 sUSD with shares retained by the factory, which has no withdrawal/rescue method. Donations can alter the share price. The app checks preview, minimum shares/assets and available exits; it does not promise a fixed exchange rate. |
| Guard custody and approvals | Non-reentrant entry points; no owner, upgrade, keeper or rescue authority. Exact input pulls reject transfer-tax/rebasing behavior. Venue approvals are exact and cleared within the same successful action. Recipient output and input consumption are checked before accepting the effect. |
| Replay and context | Calls bind a nonzero deployment ID, actor-specific plan ID, deadline and gas price. Reverts roll back the consumed marker. Client plans additionally bind chain profile, account, recipient, amounts, quote block, slippage, fee ceiling and random salt. |
| Price quality | Constant-product two-token venue charges 0.3%. Minimum output limits adverse movement, not price fairness. There is no independent oracle, MEV protection, multi-hop router or fair-price claim. Donation/imbalanced-liquidity and arithmetic-bound behavior make this reference pool unsuitable for valuable assets without further protocol work. |
| Wallet request safety | Persist a request before opening the wallet; one origin-wide lock covers setup, faucet and economic sends. Explicit EIP-1193 rejection is unsent; a generic error remains uncertain. Hash/nonce recovery reads canonical transactions and never resubmits. An old no-hash setup claim can use a wallet-provided hash only after full canonical payload/nonce/fee checks; an unrelated hash leaves the original claim blocking. Unknown requests block further sends and cannot be removed. |
| Cost preview | V3 uses zero priority fee, a 20% gas buffer plus 5,000 gas, a 10% gas price buffer for setup, and the explicitly reviewed plan price ceiling for economic calls. Fresh setup estimates can adjust the price ceiling only within the previously approved total budget, never below the current RPC price. Approval/action previews use a read-only allowance override for the pinned OpenZeppelin layout; real execution simulates again after actual approval. Budget changes clear review. Storage reservation can inflate the upfront requirement beyond final fees. |
| Funding | Fresh EVM wallets have different keys from native polkadot-js accounts. The UI obtains the native destination from `ReviveApi_account_id`; it does not reinterpret the user's native public address as an EVM signer. EVM spendable balance excludes the native account deposit. |
| Evidence | Runtime bindings, constructor input, canonical transaction/receipt, finalized inclusion, historical code, guard events and ERC-20 transfers are checked. An RPC outage remains unknown. Export hashes detect corruption; they do not authenticate an archive's author. |

## Validation and deployment gate

`npm run defi:simulate-v3` executes an `eth_call` creation harness on the actual V3 VM using a temporary balance override. It creates the exact factory and children, swaps 100 sUSD, deposits 100 sUSD and fully redeems the resulting shares, checking balances and zero residual allowances. It returns an ABI proof without committing any state. This confirms observed VM compatibility, not persistent deployment or user signing.

The contract/integration suite also exercises source attestation, immutable mismatch, self-declared hash substitution, one-time faucet allocation, seeded reserves, pre-approval cost previews, lost deployment response recovery, wallet rejection and the existing adversarial economic checks. The current release report records the actual completed check results.

The total wallet budget conservatively carries forward the full gas limit × maximum gas price of earlier canonical transactions, including gas that was unused or refunded. It does not rely on RPC-reported gas fees alone to account for native storage reservations. Receipt verification independently checks the sum of these submitted upfront limits, and setup recovery rejects a wallet fee/gas override beyond its reviewed maximum. This can require a new reviewed plan even when the earlier final fee was lower.

Before valuable-asset deployment: an independent audit, protocol-specific economic review, oracle/price protection design, monitoring/incident response and operational/legal decisions remain separate work. This release requests only disposable V3 test funds and minted fixtures.
