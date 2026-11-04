# Local DeFi workbench

This branch adds an executable DeFi vertical alongside Seam's existing Substrate transaction flow. GitHub's tested release and the hosted app are not needed to run it. The development contracts are **experimental reference implementations, not audited production markets**.

## Run

Use Node 24 and npm from the repository root:

```sh
npm ci --no-audit --no-fund
npm run build
npm run defi:local
```

Keep that terminal running. In another terminal:

```sh
cd packages/console
node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173
```

Open **http://127.0.0.1:4173/console.html?view=defi**. Select **Use funded local account**. This development-only connector uses the localhost node's unlocked second account; no private key or password is read or stored. It is excluded from the production bundle. An injected EVM wallet can also connect to chain 31337 at `http://127.0.0.1:8545`; use only disposable development accounts.

The bootstrap creates two tokens (lUSD, 6 decimals; lETH, 18 decimals), a two-token constant-product reference pool, an ERC-4626 asset-holding vault and the Seam postcondition router. Three development accounts receive 10,000 lUSD and 10 lETH each. The pool starts with 1,000,000 lUSD and 500 lETH. The vault advertises no yield strategy or APY. These balances and liquidity are local fixtures, never testnet adoption or production TVL.

The node binds only to loopback and mines every five seconds as well as on transactions. Stopping it resets the chain. Restarting creates a new deployment ID: old receipts must fail deployment identity checks rather than appear verified against a fresh market. `.seam-defi/` contains generated public profiles and accounts; it is ignored by Git. Do not expose this unlocked RPC to a network or tunnel.

## Acceptance flow

1. Connect locally. Check the local network badge, full account, three token balances and native fee balance. Reads request no signature.
2. Swap 100 lUSD into lETH. Read a quote. Inspect the minimum received, recipient, deadline, total fee budget and exact allowance target. Edit the amount: the previous quote and review must disappear.
3. Quote again, acknowledge the review, execute. The approval and action are separate transactions. Both must pass simulation and identity checks before each wallet request. Expect **Effect confirmed locally**, not testnet finality. Check exact lUSD debit, lETH credit and receipt checks.
4. Deposit 100 lUSD into the vault, to your own account. Expect 100 reference shares at the initial exchange rate and a corresponding exit preview. No APY is displayed.
5. Use **Withdraw available shares**, quote, review and execute. Shares should return to zero and underlying assets return to the recipient. Network fees remain spent.
6. Reload. The three receipts remain, initially **Not checked**. Independently verify each against its network without connecting a wallet. Evidence statuses are not trusted from an archive or previous page session.
7. Export the archive and restore it twice. Expect confirmation and zero duplicates. A malformed archive must leave existing records unchanged. Imported evidence never authorizes an automatic send.
8. Test an injected wallet rejection: the attempt reads **rejected by wallet · not sent**. Retry needs an explicit click and the same unexpired plan. A generic disconnect remains uncertain.
9. After an uncertain request, **Recover receipt** queries the hash, or scans at most 256 blocks by account and nonce. It never rebroadcasts. No match does not prove an unsent request; the claim remains blocking. A conflicting nonce or a wider window needs manual wallet/chain reconciliation.
10. If an approval remains after a failed action, use **Revoke unused allowance** while connected to that account. Revocation is a separate, fee-bearing zero-approval transaction. The original plan's gas-price and fee budget still apply; if those are no longer sufficient, revoke directly using the wallet's reviewed allowance manager. Revocation is permitted after quote expiry and after execution.

Use **Remove saved plan** to free space after exporting settled records. Unresolved wallet claims cannot be removed. Removing local evidence never revokes an allowance or changes chain state; exported records can be restored. The guard binds calls to its deployment ID on chain as well as through the client identity check.

## Automated checks

```sh
npm run test:defi
npm run lint
npm run format:check
npm run build
npm test
npm run test:control-plane
npm run docs:quickstart-check
npm run smoke:pack
npm audit --omit=dev
```

On Windows use Git Bash for the last two Bash-based scripts, or put `C:\Program Files\Git\bin` before the Windows WSL Bash shim in the terminal PATH. The contract tests start and stop their own isolated localhost node on port 18546; they never use a wallet file, testnet funds or a public RPC for submissions.

## V3 boundary

`npm run defi:audit-v3` performs read-only probes and writes `.seam-defi/v3-audit.json`. On 2026-11-04 the official EVM endpoint returned chain ID **420420777**, genesis **0x7c05b2dc7486f81a693d676553fa13f380b5be16da7c739b182931cd6cf07001**, latest and finalized blocks. This EVM block-zero identity differs from the native Substrate genesis; do not substitute one for the other.

**V3 DeFi submission is disabled in this release**, including when a user loads a profile. Profiles may be inspected read-only. Enabling it requires a reviewed deployment/allowlist, actual ERC-20 addresses and asset mapping, compatible bytecode, verified pool liquidity, a tested vault exit and wallet confirmation on the real testnet. Local contracts target Cancun with solc 0.8.38, optimizer 200, via-IR, OpenZeppelin 5.6.1. V3 opcode compatibility is not established by an ordinary RPC read. Asset ID 806707 is not automatically an ERC-20 address.

The original polkadot-js/native transfer workspace remains available in **New transaction**. The DeFi workspace uses an EVM wallet; it does not pretend a native account or asset can be used through EVM without a verified mapping.

## SDK integration

`@seam/defi` exports strict market/plan parsers, a pinned-identity reader, V2 two-token swap and ERC-4626 quote adapters, a wallet executor, recovery, archive store, receipt verifier and local pilot counters. See [the integration example](../examples/defi/local-client.mjs). It is a private workspace package while these adapter and protocol boundaries are experimental.

Every browser journal mutation must share `JOURNAL_LOCK`; Executor acquires it for the entire operation and the UI takes it for archive restore. Cross-tab exclusion fails closed if Web Locks are unavailable. Journal writes must succeed before any wallet request. The portable DeFi namespace is separate from the existing native transaction journal and receipt archives.

See [the threat model](defi-threat-model.md) and [pilot milestones](defi-pilot-milestones.md) for practical limits and release gates.
