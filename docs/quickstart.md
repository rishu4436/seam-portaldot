# Quickstart

This guide goes from a fresh clone to a compiled, policy-checked plan and a checked receipt, using only the `seam` CLI as it exists in `packages/sdk/src/cli.ts`. Most of it runs offline against recorded runtime snapshots. A few steps read the public Portaldot V3 testnet node, read-only.

What the CLI does and does not do:

- **It never signs or submits anything.** No CLI command asks for a key or sends a transaction. Signing happens only through a wallet, in the SDK flow or the console.
- **Network use is read-only.** `--endpoint` and `seam snapshot` only read runtime data, blocks and events from a node.
- **No mainnet runs.** The default offline snapshot is a recorded copy of the Portaldot mainnet runtime (spec 1002, block 2,721,455). It is used only to compile and check offline. Nothing is sent to mainnet.
- **Not audited.** SEAM has had no security audit.

Every command in the `bash` blocks below is run by `npm run docs:quickstart-check` (see [Checking this guide](#checking-this-guide)). Commands marked `# network` read the V3 testnet and are skipped unless you ask for them. `# exit N` is the exit code the command is expected to give.

## 1. Prerequisites, install and build

You need Node 20 or later and npm (CI runs Node 22; this guide was checked on Node 20.19). From the repo root:

```bash
npm ci        # setup
npm run build # setup
```

`npm run -s seam -- <args>` runs the built CLI (`node packages/sdk/dist/cli.js`). The package also declares a `seam` bin, so `npx seam <args>` works from inside the repo after the build. The packages are `private` and not on npm.

```bash
npm run -s seam -- --help # exit 0
```

## 2. Commands and flags

| Command                                                                               | What it does                                                           | Network                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `seam digest <manifest.json>`                                                         | Validates a Manifest and prints its digest                             | none                                 |
| `seam compile <manifest.json> [--json]`                                               | Compiles a Manifest against a runtime and explains the plan            | none, or read-only with `--endpoint` |
| `seam check <manifest.json> --policy <policy.json>`                                   | Compiles, then runs every policy rule that doesn't need a node         | none, or read-only with `--endpoint` |
| `seam verify <receipt.json>`                                                          | Offline: checks the receipt is self-consistent. **Not on-chain proof** | none                                 |
| `seam verify --endpoint <url> [--plan <plan.json>] [--runtime <file>] <receipt.json>` | Re-reads the chain and compares it with the receipt                    | read-only                            |
| `seam explain <plan \| policy-result \| receipt .json>`                               | Explains a plan, policy result or SDK receipt in plain English         | none                                 |
| `seam drift <snapA> <snapB> [--plan <plan.json>]`                                     | Compares two saved runtimes: fingerprint fields and calls              | none                                 |
| `seam snapshot <endpoint> <out-dir> [--name n]`                                       | Saves a node's runtime to files for offline use                        | read-only                            |
| `seam help`, `seam --help`, or no command                                             | Prints the help                                                        | none                                 |

Runtime selection for `compile` and `check` (and for `verify --endpoint`):

- default: the bundled Portaldot mainnet snapshot (spec 1002), in `packages/sdk/fixtures`;
- `--snapshot <dir|file>`: a saved snapshot, either a folder holding `<name>-snapshot.json` and `<name>-metadata.hex`, or the snapshot file itself;
- `--name <name>`: which snapshot, when the folder holds several (also used by `drift` and `snapshot`);
- `--endpoint <url>`: read the live runtime from a node instead (read-only).

Other flags:

- `--json`: print raw JSON instead of the explanation. When there is a result code, it is included as `"code"`.
- `--token SYMBOL:DECIMALS`: the token for a chain whose `system_properties` doesn't report one (e.g. `--token UNIT:12`). If the runtime reports a different token, SEAM stops instead of guessing.
- `--abi NAME=<file>`: load an ink! `metadata.json` under `NAME` (repeatable), for `contracts.call` actions written with `"abiRef": "NAME"`.
- `--plan <plan.json>` (verify, drift): the plan the receipt or the drift report is checked against.
- `--runtime <file>` (verify with `--endpoint`): pin the runtime the plan ran on, from a run record's `"fingerprint"` or a bare RuntimeFingerprint JSON.

## 3. Exit codes

From `EXIT` in `packages/sdk/src/codes.ts`. `0` means the command's whole job was done, and for a receipt, that its result is fully verified. Anything else is not "fine".

| Exit | Codes                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------- |
| 0    | `ok`, `verified`, `integrity_checked`, `chain_verified`                                                             |
| 1    | `usage_error`, `internal_error` (also an unknown command)                                                           |
| 2    | `manifest_invalid`, `policy_file_invalid`, `compile_failed`                                                         |
| 3    | `plan_unavailable`, `unsupported_runtime`                                                                           |
| 4    | `policy_blocked`, `approval_invalid`, `approval_expired`, `approval_used`, `submit_gate_blocked`, `runtime_changed` |
| 5    | `integrity_failed`, `chain_verify_failed`                                                                           |
| 6    | `chain_verify_unknown`, `uncertain`                                                                                 |
| 7    | `partial`, `not_verified`                                                                                           |
| 8    | `tx_failed`                                                                                                         |
| 9    | `rpc_transport` (connection refused, timeout, WebSocket drop)                                                       |
| 10   | `runtime_drift`                                                                                                     |

For `seam verify`, passing checks are not enough on their own: when the checks pass, the receipt's own claimed outcome decides the exit code, so a `partial` run still exits 7.

## 4. Check a Manifest and get its digest

A Manifest says what you want to happen, not how. [`examples/demo-manifest.json`](examples/demo-manifest.json) transfers an asset, calls an ink! contract, then mints a receipt token. Amounts are whole numbers in base units, written as strings.

```bash
npm run -s seam -- digest docs/examples/demo-manifest.json # exit 0
# Manifest is valid. Digest: 0x4152a1947537a14faae337c502d109220e669bf23f2e9c61de8143a59e7c5d05
```

The digest is the same on any machine for the same Manifest, whatever the key order.

## 5. Compile it

Against the bundled mainnet snapshot (spec 1002):

```bash
npm run -s seam -- compile docs/examples/demo-manifest.json # exit 0
# Plan for 3 steps: steps run one at a time, and SEAM stops at the first one that fails.
# - pay: assets.transfer is ready (Assets.transfer_keep_alive).
# - call: contracts.call is ready (Contracts.call).
# - receipt: assets.mint is ready (Assets.mint).
```

A Manifest that asks for something the runtime doesn't have gives a plain answer and exit 3, not a guessed call layout:

```bash
npm run -s seam -- compile docs/examples/missing-pallet-manifest.json # exit 3
# - nft: can't run, because Nfts.mint cannot be compiled: this runtime's metadata has no Nfts.mint call (runtime spec 1002), ...
```

Against the recorded V3 testnet snapshot (spec 3002, `tPOT`), `nfts.mint` compiles, but this V3 `Contracts.call` takes a `storageDepositLimit` the demo action doesn't give, so the plan still can't run as a whole:

```bash
npm run -s seam -- compile docs/examples/missing-pallet-manifest.json --snapshot evidence/v3-discovery/portaldot-v3-spec3002-snapshot.json # exit 3
# - nft: nfts.mint is ready (Nfts.mint).
# - call: can't run, because Contracts.call on this runtime takes argument(s) SEAM cannot fill: storageDepositLimit.
```

`--json` prints the plan itself, which other commands can read:

```bash
mkdir -p /tmp/seam-quickstart
npm run -s seam -- compile docs/examples/demo-manifest.json --json > /tmp/seam-quickstart/plan.json # exit 0
npm run -s seam -- explain /tmp/seam-quickstart/plan.json # exit 0
```

A `--token` that disagrees with the runtime stops the command:

```bash
npm run -s seam -- compile docs/examples/demo-manifest.json --token UNIT:12 # exit 1
# seam: the snapshot reports token POT with 14 decimals, which differs from the declared UNIT:12
```

To compile against the live V3 runtime instead of a snapshot (read-only). As with the V3 snapshot, the demo's `contracts.call` can't run there, so it exits 3:

```bash
npm run -s seam -- compile docs/examples/demo-manifest.json --endpoint https://test-node-v3.portaldot.dev # network # exit 3
```

## 6. Check it against a policy

A policy is the set of rules your app allows. Anything not allowed, and anything SEAM can't confirm, is blocked. Offline, the `preflight` rule (fees, weight, dry runs) is left out because it needs a node; it is checked before approval in the SDK flow and the console.

```bash
npm run -s seam -- check docs/examples/demo-manifest.json --policy docs/examples/demo-policy.json # exit 0
# Offline check passed: all 13 rules that don't need a node passed. ...
npm run -s seam -- check docs/examples/demo-manifest.json --policy docs/examples/strict-policy.json # exit 4
# - pay: Blocked: amount 2500 is over the limit of 1000 for asset 1.
```

## 7. Compare two runtimes

`seam drift` compares two **recorded** snapshots. It is not a live check and not monitoring. Exit 10 means they differ.

```bash
npm run -s seam -- drift packages/sdk/fixtures/portaldot-mainnet-snapshot.json packages/sdk/fixtures/portaldot-mainnet-snapshot.json # exit 0
npm run -s seam -- drift packages/sdk/fixtures/portaldot-mainnet-snapshot.json evidence/v3-discovery/portaldot-v3-spec3002-snapshot.json # exit 10
```

Add `--plan <plan.json>` to see whether the calls a plan uses changed.

## 8. Check a receipt

`seam verify` takes an SDK receipt, a run record that holds one (it uses the first of `nftVerdictReceipt.receipt`, `run.receipt`, `receipt`), or a receipt saved by the console.

**Offline, `seam verify` checks integrity only, not on-chain proof.** It finds edits to a receipt, but anyone can edit a receipt and recompute its digests, so it does not show any transaction exists.

SDK receipt from a recorded V3 run:

```bash
npm run -s seam -- verify evidence/testnet-v3/receipts-v2/plan-sequential-1792411270138.json # exit 0
```

Console receipts (single-step and sequential; support merged in `796c249`). Offline, the plan digest and the approval hash are recomputed. The receipt's claimed result decides the exit code, so the partial run exits 7:

```bash
npm run -s seam -- verify packages/sdk/tests/fixtures/console/seq-121390.json # exit 0
npm run -s seam -- verify packages/sdk/tests/fixtures/console/seq-120936-partial.json # exit 7
npm run -s seam -- verify packages/sdk/tests/fixtures/console/single-119996.json # exit 0
```

The single-step receipt has no saved approval inputs, so its approval hash shows as `not checked`.

An edited receipt fails:

```bash
node -e 'const f=require("fs");const d=JSON.parse(f.readFileSync("packages/sdk/tests/fixtures/console/seq-121390.json","utf8"));d.planDigest="0x"+"0".repeat(64);f.mkdirSync("/tmp/seam-quickstart",{recursive:true});f.writeFileSync("/tmp/seam-quickstart/edited.json",JSON.stringify(d))'
npm run -s seam -- verify /tmp/seam-quickstart/edited.json # exit 5
# - FAIL: plan_digest: receipt planDigest 0x0000…0000 != recomputed 0xcc65…1146
```

### Live, read-only, against the V3 testnet

With `--endpoint`, `seam verify` re-reads the chain. For each step it checks that the block is canonical and finalized, that it holds the transaction, the signer, that the on-chain call bytes equal the planned call, and that the receipt's events are the chain's events. Anything that can't be read or compared is `unknown` (exit 6), and any mismatch is `failed` (exit 5).

```bash
npm run -s seam -- verify --endpoint https://test-node-v3.portaldot.dev packages/sdk/tests/fixtures/console/seq-121390.json # network # exit 0
npm run -s seam -- verify evidence/testnet-v3/runs/plan-sequential-1792411270138.json --endpoint https://test-node-v3.portaldot.dev --runtime evidence/testnet-v3/runs/plan-sequential-1792411270138.json # network # exit 0
```

For an SDK receipt, `chain_verified` needs the plan: either `--plan`, or the plan a run record carries. **Without a plan the result is `unknown`, never `chain_verified`.** `revive.call` and `nfts.mint` steps stay `unknown` unless you pin the runtime with `--runtime`. Its digest must equal the receipt's `fingerprintDigest`, and genesis, spec, transaction version and ss58 must match the node. Only the metadata hash may differ, and the output then says so in a note. A `contracts.call` step needs an assertion the CLI can't supply, so from the CLI it stays `unknown`.

The V3 node often drops connections. That gives exit 9 (`rpc_transport`), which means "try again", not a result.

## 9. Save a runtime for offline use

```bash
npm run -s seam -- snapshot https://test-node-v3.portaldot.dev /tmp/seam-quickstart/v3 --name v3 # network
npm run -s seam -- compile docs/examples/demo-manifest.json --snapshot /tmp/seam-quickstart/v3 --name v3 # network # exit 3
```

This only reads from the node. The second line is marked `# network` because it needs the first one's output.

## 10. From code

The CLI stops before signing. To run a plan for real, use the SDK flow (`Seam.prepare`, `approve`, `execute`) with a wallet that signs, or the console. See the [reference](reference.md). [`examples/consumer/`](../examples/consumer) is a separate app that imports the packed packages and runs offline:

```bash
npm run smoke:pack # setup
```

## Checking this guide

```bash
npm run docs:quickstart-check # setup
```

`scripts/quickstart-check.mjs` takes every line of the ` ```bash ` blocks in this file. Lines starting with `#` are sample output and are skipped. Each command runs from the repo root, and when the line ends with `# exit N` the exit code must be `N` (otherwise it must be 0). Lines marked `# setup` are skipped because they install, build or re-run this check. Lines marked `# network` are skipped unless you set `SEAM_QUICKSTART_NETWORK=1` or pass `--network`.
