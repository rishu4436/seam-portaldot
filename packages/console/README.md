# SEAM live testnet workspace

The React console connects to the Portaldot V3 testnet. Its default screen is a live transaction workspace, with three stages:

1. Connect an external wallet, read the runtime and compile a transaction.
2. Derive and tighten the policy, then review and approve the plan.
3. Sign in the wallet, run the submit gate and verify the finalized outcome.

The landing page is `/`; the workspace is `/console.html`. Recorded tools are available separately at `/console.html?view=lab`. Historical data never becomes a live runtime reading.

## Run locally

From the repository root, with Node 22.12+:

```bash
npm ci
npm run build
npm run dev -w @seam/console
```

The default RPC is `https://test-node-v3.portaldot.dev`. The workspace only contacts it when requested. Wallet signing requires an injected Polkadot-compatible extension and testnet funds for fees. Mainnet submission is refused.

Draft changes clear the selected policy and approval. Late results from an earlier review are discarded. Atomic-to-sequential downgrades require acknowledgment. Signed bytes remain in memory; stored run data supports read-only reconciliation after a refresh.

The UI adapts to narrow screens and honors reduced-motion preferences. Recorded screens and evidence load in separate chunks; vendor code is split for caching. Receipt labels distinguish finality from proof of effects.

## Checks

```bash
npm test -w @seam/console
npm run build -w @seam/console
```

The root build must run first because the console consumes the workspace packages' built browser exports. See [the security gates](../../docs/SECURITY_GATES.md) for the trust boundaries.
