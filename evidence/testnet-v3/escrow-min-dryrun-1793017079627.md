# Trimmed escrow deploy: DRY RUN ONLY (P1-02)

**DRY RUN ONLY: nothing was signed, submitted or deployed. No extrinsic was signed, not even with a fake signature; fees via TransactionPaymentCallApi_query_call_info.**

Read-only calls on `https://test-node-v3.portaldot.dev` (genesis `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd`, spec 3002) at finalized block **#203144** (`0xd2bb5ebb4cad0b06efd72518fa84e5ef22e25119e9e1fc10b1a729e4f9d1b0b4`), 2026-10-26T12:17:59.627Z. Origin = budget account `5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1` (free 981.75639751744178 tPOT). Budget left under cap: 4.79674053856825 tPOT; target 4.5 tPOT. Raw RPC calls and full results: `escrow-min-dryrun-1793017079627.json` (`rawCalls`). Script: `packages/chain/scripts/v3-escrow-min-dryrun.mjs`. Build: `contracts/escrow/build-min.sh` (pinned solc Version: 0.8.30+commit.73712a01.Linux.g++).

Constants: {"depositPerByte":"6000000000000","depositPerItem":"15000000000000","codeHashLockupDepositPercent":"300000000","allowEVMBytecode":true,"existentialDeposit":"10000000000000"}

| variant | deploy code B | deposit total | code upload | contract/items | weight refTime / proof_size | fee | total | fits 4.5? |
|---|---|---|---|---|---|---|---|---|
| SeamEscrowMin-r1 | 1096 | 96.414 | 69.96 | 26.454 | 1516144 / 0 (UNKNOWN) | 0.12220678643046 | **96.53620678643046** | no |
| SeamEscrowOne-r1 | 858 | 59.052 | 55.68 | 3.372 | 5342770 / 0 (UNKNOWN) | 0.09890680329471 | **59.15090680329471** | no |
| SeamEscrowMin-r200 | 1124 | 98.598 | 71.64 | 26.958 | 1522864 / 0 (UNKNOWN) | 0.12500678994575 | **98.72300678994575** | no |
| SeamEscrowOne-r200 | 863 | 59.442 | 55.98 | 3.462 | 5343970 / 0 (UNKNOWN) | 0.09940680392244 | **59.54140680392244** | no |
| Floor-stop | 13 | 13.188 | 4.98 | 8.208 | 663430 / 0 (UNKNOWN) | 0.01380664332938 | **13.20180664332938** | no |

All amounts tPOT. Each variant was re-run with explicit limits (2x refTime, storage deposit limit = charge + 5%); all returned Ok with the same deposit. proof_size was 0 in every run and is recorded as UNKNOWN, not a passed limit, so the deploy gate stays blocked. Floor-stop is a hand-made 1-byte-runtime probe, not an escrow; it is the per-contract floor. On-chain reference: the 13-byte deploy #102840 held 4.98 + 9.144 = 14.124 tPOT plus a 0.0156 fee.

**Conclusion: no variant, and no contract at all, fits ~4.5 tPOT on V3.**
