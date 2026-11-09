# Portaldot V3 testnet validation

Use this checklist for a specific source revision and account. Historical executions establish what happened on their recorded blocks; they do not substitute for testing a later release.

## Network and prerequisites

- Hosted V3 RPC: `https://test-node-v3.portaldot.dev` or `wss://test-node-v3.portaldot.dev`.
- Recorded V3 genesis: `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd`; observed runtime spec 3002. Read the runtime again rather than assuming its version is unchanged.
- Live workspace: https://seam-portaldot.vercel.app/console.html.
- Use a compatible Polkadot wallet and a funded testnet account. Keep credentials in the wallet.
- Native swaps use existing V3 DEX liquidity and require native tPOT for input and fees, or the selected asset plus tPOT for a reverse swap. See [native swaps](native-swaps-v3.md).
- **Send assets** additionally requires an asset ID and a positive balance. A non-self-sufficient asset can require the recipient to have native tPOT meeting the live account minimum. Minting requires the account's actual on-chain mint permission.

A local `substrate-contracts-node` or Portaldot dev node is a different chain. Local rollback results, public development accounts and fixture metadata must not be used as V3 authorization or production evidence.

## Local release checks

From the repository root:

```sh
npm ci
npm run build
npm run lint
npm run format:check
npm run docs:quickstart-check
npm test
npm run test:control-plane
npm audit --audit-level=low
npm run smoke:pack
```

The package-consumer smoke check requires Bash. The optional `npm run test:e2e` downloads and runs a disposable local chain; it does not submit to V3. Record opt-in skips separately from passing checks.

## Read-only checks

- Check `/release.json` and the app's source link against the intended clean commit.
- Connect the wallet, select the account and read live facts. Reads must not request a signature.
- Confirm the genesis, finalized block and live action availability. Unknown or mismatched observations must not authorize signing.
- Inspect native and selected-asset balances, minimum balances and recipient readiness. Use live fee estimates rather than a fixed funding assumption.
- Compile the intended operation and review the exact signer, action, recipient, amount, expected effect and applicable limits.
- Change an amount, recipient or policy field and confirm the previous approval is invalidated. Runtime drift must trigger the appropriate recheck or recompilation.

## Wallet and execution checks

- Reject one wallet request and confirm no transaction hash or broadcast is recorded for that rejection.
- Approve only the intended V3 operation in the wallet. A signed-byte mismatch or failed signed dry run must stop broadcast.
- Check that repeated clicks and simultaneous tabs do not produce duplicate sends for one operation.
- Distinguish pending, included, finalized, failed and effect-unknown results. Confirm the expected effect against canonical chain evidence.
- Refresh after submission and recover the same hash without repeating the send.
- Export an archive, restore it twice, and confirm deduplication and visible import feedback.
- In a separate browser without a connected wallet, import the archive and verify it against V3. Imported verification claims alone must not count as proof.

## Evidence and scope

Record the tested commit, network, account, transaction hash, finalized block, expected effect and observed result. Keep original receipt archives distinct from later independent block reads, and never commit credentials or secret-bearing files.

The [V3 evidence index](../evidence/testnet-v3/README.md) includes earlier Assets, NFTs, sequential/atomic plans and Revive executions. The [November 6 QA report](live-qa-2026-11-06.md) includes user-signed native swaps in both directions and their independent verification. The [live wallet acceptance report](live-wallet-test-2026-11-04.md) records the asset-transfer prerequisites and observed outcomes.

The separate [contract-market and vault route](defi-local.md) requires its own identity review, setup, liquidity, wallet compatibility and full exit validation. Native swap results do not establish that route, an independent security audit, mainnet readiness or cross-VM atomicity.
