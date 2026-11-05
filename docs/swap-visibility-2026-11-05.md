# Swap visibility correction — 5 November 2026

The initial V3 setup layout filled the first viewport and pushed the swap controls below it. The sidebar's generic DeFi label and the homepage's native-workspace link also made the feature hard to find.

The homepage and sidebar now expose **Swap & vaults** directly. **Swap, Deposit and Withdraw** appear immediately below the workspace title, with a matching heading for the selected action. Setup is collapsed by default and opens through an explicit **Set up or open market** button. A shared market-creation link still opens setup for verification. A successfully verified profile closes setup and returns to the action form.

Trading remains disabled until a reviewed market is selected and a wallet is connected. The setup requirement is stated next to the action controls. No contract, economic limit, wallet request, journal schema or source-attestation rule was changed. No liquidity or token prices are fabricated to populate the empty form.

Validation: 341 console tests passed, including a regression for visible action selection before setup without wallet calls. Production build, zero-warning ESLint and formatting passed. Browser checks covered desktop, all three action switches, the setup entry, the homepage link and a 390-pixel mobile viewport with no horizontal overflow. All three actions were within the first mobile viewport. No wallet was connected and no transaction was submitted during these UI checks.

The previous full release's remaining package/backend results still apply; the additional console regression brings the unique test count to 2,079. Persistent V3 deployment and wallet acceptance continue to require the user's funded wallet and explicit signature.
