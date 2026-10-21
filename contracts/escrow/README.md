# SeamEscrow (P1-02 prep, not deployed)

`Escrow.sol`: `deposit(payee, releaseAfterBlock)` payable stores `{payer, payee, amount, releaseAfterBlock, state}`
under ids 0,1,2,…; `release(id)` pays the payee (payer any time, anyone once `block.number >= releaseAfterBlock`);
`refund(id)` returns the value to the payer before that block. Events `Deposited`, `Released`, `Refunded`. The only
external interaction is the value transfer; state is set before it.

Build: `./build.sh` (pinned resolc 1.4.0 + solc 0.8.30 by sha256; installed under `/home/box/tools/revive/`).
Rebuilds are byte-identical. `artifacts/build-info.json` records versions, sizes and keccak256 code hashes.

Read-only V3 deploy estimate: `evidence/testnet-v3/escrow-dryrun-1792555095045.md`. It does **not** fit the
remaining budget (≈914.7 tPOT for the PolkaVM build, ≈170.7 tPOT for the EVM build, vs 4.80 tPOT left).
