# Changelog

All notable changes to SEAM. Packages are pre-release (`0.1.0`, private). Format loosely follows Keep a Changelog; entries name the
audit item (SEAM-nnn) they close. Portaldot V3 claims are limited to what `evidence/testnet-v3/README.md` records.

## Unreleased

### SDK / CLI

- SDK receipt verifiers for the coming `revive.instantiate_with_code` and `revive.map_account` action kinds (V3 spec 3002 only):
  `verifyReviveInstantiateOutcome`, `decodeV3InstantiateWithCode`, `instantiateCodeHash`, `reviveAddressOf`,
  `verifyMapAccountOutcome`, and `V3_SPEC3002_REVIVE_INSTANTIATED_SHAPE` (`Revive.Instantiated(deployer H160, contract H160)`,
  observed in tx `0xad39bce1…acb2`). The deploy check rests on the call bytes (keccak256 of the code), success and an
  `Instantiated` from the signer's H160, because the event has no code hash. map_account emits no event on V3, so it is `unknown`
  unless a `Revive.OriginalAccount` read is supplied (`ContractEffect.originalAccount`). Both are wired into the `buildReceipt` /
  `verifyStep` defaults for spec 3002 only. Tests use the recorded deploy and map_account transactions plus edited copies.
  **Deploy through policy and a fresh account mapping are still NOT V3-verified**: no SEAM-planned run of either exists, and the
  recorded map_account was for an account that was already mapped.
- `seam verify` accepts a run record and never crashes on a non-receipt (fc5cae7).

- SEAM-010 (SDK side): `nfts.mint` receipt steps are checked by default with `verifyNftsMintOutcome` against the planned collection,
  item and recipient, using `V3_SPEC3002_NFTS_SHAPE` (`Nfts.Issued(collection, item, owner)`, observed on the V3 testnet, spec 3002).
  `verified` only when `buildReceipt({ runtime })` is `portaldot-v3` spec 3002; otherwise capped at `contract_emitted`. Explicit
  `verdicts` still win and forged ones are still downgraded. Tests use the real recorded V3 events.
- SEAM-010 (SDK side): `verifyReviveCallV3Outcome` and `decodeV3ReviveCall`, the default for `revive.call` receipt steps on
  `portaldot-v3` spec 3002. V3 has no per-call Revive event, so it checks the extrinsic's own call bytes (`StepOutcome.callHex`)
  against the plan, `ExtrinsicSuccess`, and an expected `Revive.ContractEmitted` from `dest` when `effects` gives one. Without an
  expected event it is `unknown` with `basis: "call_args_and_success"` (never `effect_proven`); with a matching one it is `verified`
  with `basis: "call_args_success_and_emitted"`. Tests replay the recorded V3 Revive call records plus tampered variants.
- SEAM-004, SEAM-010: receipts carry a verifier coverage level (`none`, `call_dispatched`, `extrinsic_finalized`, `contract_emitted`,
  `effect_proven`). A generic `ContractEmitted` event is `unknown`; only the exact expected event data or a matching state readback
  (caller-supplied `effects`) is `verified`. Revive and Nfts steps report `unsupported_runtime`. New step status `uncertain`.
- SEAM-003: offline `seam verify` reports `integrity_checked` ("integrity only, not on-chain proof"). New live check
  `seam verify --endpoint <ws> [--plan file] <receipt>` re-reads the chain and returns `chain_verified`, `unknown` or `failed`.
- SEAM-022: stable `SeamCode` values, documented exit codes (0 verified, 5 integrity/chain check failed, 6 unknown or uncertain, 7 partial
  or not verified, ...), `code` in `--json` output, no ambiguous success boolean. A finalized step without tx hash and block is not verified.
- SEAM-021: `seam drift <snapA> <snapB> [--plan]` compares two saved runtimes (offline) and exits 10 on drift.
- SEAM-020: `examples/consumer` sample app, `bundledSnapshotDir()`, the SDK package ships its snapshot, `npm run smoke:pack`.
- SEAM-013 (SDK side): the Manifest validator passes `atomicRequired` through.

- SEAM-010 (SDK side): `verifyNftsMintOutcome` / `verifyReviveCallOutcome` and `buildReceipt({ verdicts })`: fail-closed outcome verifiers, `effect_proven` only for an exact match with an observed event shape; plus fixed wording for `NO_OBSERVED_V3_METADATA` and `V3_ARG_SHAPE_MISMATCH`. Not verified on V3.

- Docs: `seam verify --endpoint` documented as it really behaves: `chain_verified` needs a matching plan, on-chain call bytes equal to the planned call (atomic: outer batch call only), every step present and finalized, and each step re-derived `effect_proven`; no plan or an uncomparable input gives `unknown`. `revive.call` and `nfts.mint` stay `unknown` in live verification. CLI help text updated.

### Docs

- V3 status: README, SDK README, reference, quickstart, RuntimeGuard and this changelog now say what the first funded V3 testnet
  run (spec 3002, `evidence/testnet-v3`) verified (signing, dry runs and fees, Assets, Nfts, SEAM sequential and `atomic_verified`
  plans, `batch_all` rollback, `Revive.map_account` call path, an EVM contract deploy and a SEAM `revive.call`) and what it did not (a per-call Revive event, deposit refund, fresh account mapping,
  ink!/PolkaVM, cross-VM, browser-extension signing). Stale "local nodes only / nothing on V3" wording removed.
- SEAM-024: README and docs say two local chains were used and neither is the hosted V3 testnet or mainnet; stale counts removed.
- SEAM-025: added `SECURITY.md`, `CONTRIBUTING.md` and this changelog.

## 0.1.0 (pre-release, not published)

Initial monorepo: compiler, policy, SDK/CLI, chain adapter and recorded demo console, with local-chain evidence only.

### Interface/version notes

- Receipt version stays `1`; new step fields (`coverage`, `code`) are additive. Receipts written before them still pass integrity checks.
- Fingerprint digest schema is unchanged (V1).
- `Seam.execute({ verdicts })`: optional `Record<actionId, OutcomeVerdict>` passed to every receipt the run builds (final receipt and the per-step receipts that gate the next step), like `effects`. Without it nothing changes; `execute` never computes a verdict. Not verified on V3.
