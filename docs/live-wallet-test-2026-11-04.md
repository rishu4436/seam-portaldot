# Live wallet acceptance test

Open [the live workspace](https://seam-portaldot.vercel.app/console.html) in the browser containing your Substrate wallet. Use Portaldot V3 testnet funds. This test requires native tPOT for fees, an asset the sender owns, and a second test account you control as recipient. No seed phrase, private key or wallet password belongs in SEAM.

The application submits asset transfers, not a native tPOT transfer form. The amount field uses the asset's **base units**. Check the asset's minimum balance and use an amount the sender can spare while remaining alive. Keep the recipient funded/existing if the asset requires it.

**For test asset 806707, fund the recipient with native tPOT before transferring.** This asset is not self-sufficient. The sender needs both an asset balance and native tPOT for fees; the recipient needs a native account meeting the live minimum account balance. In the completed acceptance run, funding the recipient with 0.5 tPOT resolved a `Token` dry-run rejection. That is an observed funding amount, not a universal minimum.

Enter `806707` in **Asset IDs to inspect**, then read balances. IDs are currently supplied manually. A wallet with no balance must receive assets from a holder, or use **Mint assets** only if it has the asset's issuer rights. Minting does not create an asset ID.

| Step | What to do | Expected result |
| --- | --- | --- |
| 1 | Refresh the app, click **Connect wallet**, authorize the site in your wallet and select the intended account/provider. | Correct account and wallet name appear. With two wallets installed, selecting the second must use that wallet. |
| 2 | Click **Read live facts**, then **Read balances**, supplying your asset ID. | V3 testnet identity/runtime and finalized balances load. Unreadable data remains unavailable. A balance read requests no signature. |
| 3 | Add **Send assets**. Enter the owned asset ID, the recipient account and a small amount in base units. Start with one action and **Sequential** mode. | The exact asset, recipient and amount appear in the form. |
| 4 | Click **Compile against live runtime**. Read the fee from preflight if prompted, review the derived policy, then click **Send to approval and signing**. | Compilation succeeds for supported calls; the policy binds the chosen asset, recipient, amount and fee cap. |
| 5 | Click **Check policy and approve**. Then change the amount or recipient before signing. | Approval is cleared. The changed transaction needs compilation/review again. Restore your intended transaction and approve it afresh. |
| 6 | Start the live signing flow once and **reject** the wallet request. | No transaction hash is submitted, recipient balance does not change, and the UI reports rejection. Reapprove if needed before the successful attempt. |
| 7 | Review the intended plan again, click **Check live and sign with wallet**, and inspect the wallet's account, call and network before accepting. Do not approve if they differ. | One transfer is submitted. Record its transaction hash. Wait for finality and effect verification; submission/inclusion alone is not success. |
| 8 | Wait for the **Receipt saved in this browser** message. Open **Activity & recovery**, refresh the page, then open the saved receipt. | The same receipt survives refresh. Reconciliation reads the chain without resending. The run must not appear twice or request another signature. |
| 9 | In **Receipt inspector**, click **Verify against live V3 testnet**. | The finalized transaction, call, recipient, amount and effects verify independently. A node outage may produce incomplete; retry the read when available. It must never silently become verified. |
| 10 | Export the receipt archive, then restore that file (or use a second browser profile). Reopen and independently verify it. | Complete receipt, plan and manifest recover. Reimport deduplicates the run and never resets send guards. Archive restoration does not submit anything. |
| 11 | Optional team check: connect with a workspace key, import the receipt, check explicit sharing consent, upload, and verify on the server. Import a different receipt afterward. | Server result has a fresh check time. Consent resets for the new receipt; upload remains disabled until consent is checked again. |
| 12 | Optional negative tests: disconnect the account or choose an incompatible network; try a policy with a lower amount/fee cap; use an expired approval. | Signing/submission blocks, with a reason. Do not clear local journal/send guards to retry an uncertain transaction. |

Stop on a wrong recipient/account, an unexpected wallet request, duplicate submission, lost receipt after the saved message, or a verified badge for a failed/incomplete run. Share the transaction hash, failing step, visible error and browser/wallet versions for investigation. Public addresses and transaction hashes are enough; never share wallet secrets.

Automatic backend backup/restore testing has already been performed separately with an encrypted production snapshot and an isolated restored API. It does not require a wallet signature or overwriting the live database.
