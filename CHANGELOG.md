# Changelog

All notable changes to SEAM. Packages are pre-release (`0.1.0`, private). Format loosely follows Keep a Changelog; entries name the
audit item (SEAM-nnn) they close. Nothing here is a Portaldot V3 or Revive claim: no V3 result has been verified.

## Unreleased

### SDK / CLI
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

### Docs
- SEAM-024: README and docs say two local chains were used and neither is the hosted V3 testnet or mainnet; stale counts removed.
- SEAM-025: added `SECURITY.md`, `CONTRIBUTING.md` and this changelog.

## 0.1.0 (pre-release, not published)

Initial monorepo: compiler, policy, SDK/CLI, chain adapter and recorded demo console, with local-chain evidence only.

### Interface/version notes
- Receipt version stays `1`; new step fields (`coverage`, `code`) are additive. Receipts written before them still pass integrity checks.
- Fingerprint digest schema is unchanged (V1).
