# V3 signed dry run: capability and real results (read-only replay)

Recorded runs, replayed read-only on https://test-node-v3.portaldot.dev at 2026-10-21T03:29:53.029Z (best #126253). Nothing was signed or submitted. The two transactions are the live 2-step sequential run signed through the polkadot.js extension by the SEAM team (already on chain).

- `rpc_methods` lists: state_call, state_callAt, state_callRecorded, system_dryRun, system_dryRunAt.
- `system_dryRun` on the assembled signed bytes works on V3 (spec 3002). SEAM maps the raw ApplyExtrinsicResult with `dryRunOne` (now also exported from `@seam/chain/browser` as `dryRunOne` / `signedDryRun`).
- `state_call BlockBuilder_apply_extrinsic` at the parent also answers (same result). No separate DryRunApi call was needed.

| block | tx | at | outcome | detail | raw |
|---|---|---|---|---|---|
| #121390 (idx 1) | 0xadced4b5e1… | parent block (state before inclusion): expected ok #121389 | ok | dispatch ok | `0x0000` |
| #121390 (idx 1) | 0xadced4b5e1… | its own block (nonce already used): expected Stale #121390 | failed | invalid transaction: Stale | `0x010003` |
| #121390 (idx 1) | 0xadced4b5e1… | best block (mortal era passed): expected invalid #126253 | failed | invalid transaction: BadProof | `0x010004` |
| #121394 (idx 1) | 0xaea5014518… | parent block (state before inclusion): expected ok #121393 | ok | dispatch ok | `0x0000` |
| #121394 (idx 1) | 0xaea5014518… | its own block (nonce already used): expected Stale #121394 | failed | invalid transaction: Stale | `0x010003` |
| #121394 (idx 1) | 0xaea5014518… | best block (mortal era passed): expected invalid #126253 | failed | invalid transaction: BadProof | `0x010004` |

The best-block result depends on when it is read: an earlier probe the same morning returned `0x010004` (BadProof) once and `0x010005` (AncientBirthBlock) once, both Invalid, because the 64-block mortal era of these transactions has passed. Either way SEAM maps it to failed.

## Why the 2-step run showed "unknown (allowed by policy, weaker proof)"

That label is the **pre-sign** preflight. Before the extension signs there is only a fake signature, which system_dryRun rejects, so SEAM reports unknown instead of guessing. The signed dry run happens at submit, on the real bytes (the gate has `requireSignedDryRun: true` and passed both steps). #120936 step 2 shows the failing direction: it was blocked at submit with `signed_dry_run_failed`.

## What the console must pass (no console change made here)

- After signing, before submit: `preflightReport(send, plan, facts, { signedExtrinsics: allSignedHex })`. It already does this in `signflow.ts` preSubmit. Or call `signedDryRun(send, facts, signedHexes, { at })` directly.
- Record `transactions[sendIndex].dryRun` in the receipt: `outcome`, `detail`, and the new `raw` (ApplyExtrinsicResult hex) and `at` ({number, hash}). Today the receipt keeps only the pre-sign preflight, so the signed result is lost.
- Sequential: step i>0 dry-run before its own submit (Invalid(Future) earlier maps to unknown, by design).

Raw RPC requests/responses: `dryrun-capability-1792553385164.json` → `rawRpc`. Script: `packages/chain/scripts/v3-dryrun-replay.ts`.
