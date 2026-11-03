# Protected payment integration

This importable Node example uses public SEAM packages and keeps preparation separate from wallet signing. It never runs a transaction when imported.

1. Build the monorepo with `npm run build` on Node 24.
2. Provide a `createPortaldotAdapter` from `@seam/chain`, connected to the official V3 testnet, and a durable private journal path.
3. Call `preparePayment` with the real wallet signer identity, recipient, asset ID, amount and maximum fee as base-unit strings. Display its `review`, `plan`, policy and preflight observations to the user.
4. After explicit user approval, call `executeReviewedPayment` with that reviewed plan digest, an external `WalletSigner`, and trusted current block/nonce readers. An adapter's `walletFrom(signPayload)` accepts an external wallet payload signer. No private keys belong in this example.
5. Export the resulting `evidence` to the console inspector or your authenticated team backend. An uncertain result requires reconciliation rather than another execution attempt.

The strict policy requires a successful signed dry run and an unchanged runtime. Nodes that cannot provide these checks will block execution. The caller must protect the durable journal, authenticate its wallet bridge, and enforce its own user authorization. This example does not provide wallet custody or a public signing service.
