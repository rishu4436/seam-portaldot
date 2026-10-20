# @seam/chain

Bot 4's part of SEAM: the Portaldot chain layer. It does live discovery, the runtime recheck before
submission, preflight, the signing handoff to the user's wallet, and submit-and-track with decoded
events. **SEAM never holds user keys.** It builds the exact bytes, the wallet signs them, and SEAM checks
and broadcasts the result.

```
discover ─► compile (Bot 2) ─► preflight ─► policy + approve (Bot 3) ─► buildSigningRequests ─► wallet signs
   ─► assembleSignedExtrinsic ─► extractSignedCall + refetchFingerprint ─► checkBeforeSubmit (Bot 3)
   ─► submitAndWatch ─► events ─► receipt (Bot 5)
```

It will move into the monorepo as `packages/chain`.

```bash
npm install          # installs ../seam-compiler as a copy (install-links=true, see below)
npm run build
npm test             # offline: mainnet snapshot + an in-process fake node
SEAM_LIVE=1 npm test # adds read-only checks against wss://mainnet.portaldot.io (never submits)
```

## API

All functions take an `Endpoint`: either a `wss://` URL (SEAM opens and closes the connection) or an
open `RpcClient` (`@polkadot/rpc-provider`'s `WsProvider`, or anything with `send`/`subscribe`/`unsubscribe`).
Errors are `SeamChainError` with a `code` (`RPC_FAILED`, `NODE_MISSING_VALUE`, `FACTS_MISMATCH`,
`RUNTIME_CHANGED`, `ENVELOPE_INVALID`, `PAYLOAD_MISMATCH`, `BAD_SIGNATURE`, `NOT_SIGNED`,
`MAINNET_SUBMIT_REFUSED`, ...).

### 1. Discovery

| function                                                              | returns                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover(endpoint, { typesBundle?, batchAllRollback? })`             | the compiler's `RuntimeFacts` (via `factsFromMetadata` with the pinned types)                                                                                                                            |
| `readChainInputs(endpoint)`                                           | raw `ChainInputs`: metadata, runtime version, genesis, properties, head, **all pinned to one block hash**                                                                                                |
| `factsFromChainInputs(inputs)` / `fingerprintFromChainInputs(inputs)` | pure versions (no network)                                                                                                                                                                               |
| `snapshotFromNode(endpoint, outDir, { name? })`                       | writes `<name>-metadata.hex` + `<name>-snapshot.json` in the same format as the mainnet evidence, plus `signedExtensions`, `rpcMethods`, `fetchedAt` and `fingerprintDigest`. Use it for the V3 testnet. |
| `chainInputsFromSnapshot(snapshotJson, metadataHex)`                  | replays a saved snapshot offline (checks the metadata hash)                                                                                                                                              |
| `readCheckpoint(endpoint)`                                            | finalized head `{ number, hash }`: the era checkpoint for signing                                                                                                                                        |
| `listRpcMethods`, `signedExtensionsOf`, `tokenInfo`                   | helpers                                                                                                                                                                                                  |

The spec name, spec version, transaction version and SS58 prefix reported by the node are cross-checked
against the metadata by `factsFromMetadata`. A missing `tokenSymbol`/`tokenDecimals` is an error and is never guessed.

### 2. Recheck before submission

`refetchFingerprint(endpoint): RuntimeFingerprint`. It re-reads everything and returns the nine-field
fingerprint. `readFingerprint` returns it with `fingerprintDigest` and `atBlock`. The digest is computed by
the compiler's `computeFingerprintDigest`, so it matches Bot 2 and Bot 3 byte for byte (tested).

### 3. Preflight

`preflight(endpoint, plan, facts, { nonce?, at?, signedExtrinsics? }): PreflightReport`

- `result`: the agreed `PreflightResult` (`steps[{ actionId, weight, fee, storageDeposit, dryRun, note }]`, `totalFee`).
- `nonce` comes from `system_accountNextIndex` (`nonceSource: 'node'`), or from the caller.
- Fee and weight come from `payment_queryInfo` on a **fake-signed** extrinsic per transaction (nonce +i for
  sequential plans). Atomic plans query the batch once (`totalFee`) and each inner call on its own (the
  policy's per-step weight limit). `payment_queryFeeDetails` goes into `transactions[].feeDetails`.
- `contracts.call` steps are dry-run with `contracts_call`. An `Err` is decoded (e.g. `contracts.ContractNotFound`),
  and `flags & 1` (revert) counts as failed.
- Asset steps: an empty `Assets.Asset(id)` storage entry → `dryRun: 'failed'` ("asset does not exist").
  Otherwise the result stays unknown.
- `system_dryRun` runs only with `signedExtrinsics` (real signatures). With a fake signature mainnet returns
  `Invalid(BadProof)` (checked), so without them generic steps are `dryRun: 'unknown'`.
- `storageDeposit` is always `{ unknown: true }`: spec 1002 doesn't report it.
- Refuses (`RUNTIME_CHANGED`) if the node's spec or transaction version differs from the facts.

#### Preflight for `revive.call` and `nfts.mint` (not V3-verified)

No real Portaldot V3 metadata has ever been observed, so these two kinds are handled conservatively:

- `coverage.steps[i]` is always `{ basis: "unobserved", proves: "nothing" }`, whatever the node answers, and `coverage.wholePlan` is `"none"` for any plan containing one. A node `dryRun: 'ok'` for such a step is reported as `'unknown'`; a failure stays `'failed'`.
- A step the compiler marked unavailable (`NO_OBSERVED_V3_METADATA`, `V3_ARG_SHAPE_MISMATCH`, `ATOMIC_REQUIRED_UNAVAILABLE`) keeps its code in `coverage.steps[i].reasonCode` and `v3.steps[i]`. For an unavailable plan containing such a step nothing is simulated (only head and nonce are read; if that fails, `v3.chainReadError` is set and block/nonce are placeholders). Previously this threw `PLAN_NOT_SIGNABLE`; other unavailable plans still throw.
- For an encoded call, only the node's generic `payment_queryInfo` (and `system_dryRun` when signed extrinsics are given) are used. `ReviveApi_call` is never called (its layout is unverified); `v3.steps[i].reviveApi` only says whether the runtime version lists `ReviveApi`.
- `v3.accountMapping` (revive.call only) is `unknown` unless the metadata has `Revive.map_account` AND a `Revive.OriginalAccount` storage entry maps keccak256(signer)[12..] back to the signer. That derivation is the generic pallet-revive rule, not verified for Portaldot V3.
- Positive tests use SYNTHETIC metadata (`tests/syntheticV3.ts`); the negative case uses the real dev-node (spec 100) older Revive layout. Errors from the node become reasons; `FACTS_MISMATCH` / `RUNTIME_CHANGED` still throw.

### 4. Signing handoff

| function                                                                              | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildSigningRequests(plan, facts, envelope)`                                         | era from `envelope.checkpoint`; one `SigningRequest` per transaction: the `outerCall` batch_all for atomic plans, or each step with nonce `envelope.nonce + i`. Each request has `payload` (polkadot.js-extension `SignerPayloadJSON` for `signer.signPayload`), `raw` (`SignerPayloadRaw`), `signingPayloadHex` (SCALE payload) and `signBytesHex` (exact bytes the key signs, which is the blake2b-256 of the payload when it is over 256 bytes), plus `callHex`, `nonce`, `era` |
| `buildSigningRequest(callHex, facts, { signer, nonce, mortalityBlocks, checkpoint })` | the same for one call                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `signingRequestsForCalls(calls, facts, envelope)`                                     | the same for explicit calls (the SDK wallet's `callsToSign(plan)`)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dryRunSigned(endpoint, signedTxs, facts)`                                            | `system_dryRun` of each signed transaction → `{ results: ('ok'\|'failed'\|'unknown')[], details }` for `checkBeforeSubmit({ signedDryRun })`. In a sequential run, transaction i > 0 with a future nonce is `'unknown'` (the earlier ones aren't on chain yet)                                                                                                                                                                                                                     |
| `signBytesOf(payload, facts)`                                                         | the bytes a key signs for a payload (for raw-signing wallets)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `assembleSignedExtrinsic(payload, signature, facts, { scheme?, verify? })`            | signed extrinsic hex. Refuses a payload for another genesis, spec or tx version, a non-zero tip, or other signed extensions. By default it **verifies the signature** first. Typed (65/66-byte) signatures are taken as given. An untyped 64-byte one needs `scheme`.                                                                                                                                                                                                              |
| `extractSignedCall(extrinsicHex, facts)`                                              | `{ callHex, capability, palletIndex, callIndex, signer { accountId, ss58 }, nonce, era, tip, signature, signatureScheme, txHash }`: what is **actually inside** the extrinsic                                                                                                                                                                                                                                                                                                      |
| `signedCallsOf(extrinsics, facts)`                                                    | `Hex[]` → Bot 3's `checkBeforeSubmit({ signedCalls })`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `checkSignedExtrinsic(extrinsicHex, request, facts)`                                  | compares call, signer, nonce, era and tip, and verifies the signature over the extrinsic's own contents. Returns `{ ok, mismatches[] }`                                                                                                                                                                                                                                                                                                                                            |

Tip is always 0. `mortalityBlocks` must be a power of two from 4 to 65536. polkadot.js silently rounds
other values, and SEAM signs exactly what was approved. Don't use a polkadot.js extension's `signRaw` for
transactions, because it wraps data in `<Bytes>`. Use `signPayload`.

### 5. Submit and track

| function                                                                              | what                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitAndWatch(endpoint, signedHex, onStatus, { facts, timeoutMs?, allowMainnet? })` | `author_submitAndWatchExtrinsic`. `onStatus` gets `submitted` → `in_block` → `finalized`, or `retracted` / `dropped` / `invalid` / `usurped` / `finality_timeout`. Returns `{ txHash, status, history, timedOut, error?, inclusion: { number, hash, extrinsicIndex, events, success, dispatchError? } }` |
| `readEvents(endpoint, blockHash, extrinsicIndex, facts)`                              | System.Events at that block, filtered to that extrinsic. Refuses a block whose spec differs from the pinned one                                                                                                                                                                                          |
| `readInclusion(endpoint, blockHash, txHash, facts)`                                   | the same, finding the index by tx hash                                                                                                                                                                                                                                                                   |
| `waitFinalized(endpoint, blockHash, { timeoutMs })`                                   | `{ finalized, block, reason?: 'timeout' \| 'not_canonical' }`                                                                                                                                                                                                                                            |
| `decodeBlockEvents(eventsHex, facts)` / `outcomeForExtrinsic(...)`                    | offline decoding                                                                                                                                                                                                                                                                                         |

Events come back as `{ pallet, name, args, eventIndex, extrinsicIndex, argTypes, topics }`. `pallet` is the
metadata name (`Assets`, `System`). `args` are positional (V13 has no field names): accounts as 0x
AccountId32 hex, integers as decimal strings, byte arrays as hex, and structs/enums as JSON with sorted
keys (e.g. `{"class":"Normal","paysFee":"Yes","weight":200000000}`). `toChainEvent` strips an event to
`{ pallet, name, args }`.

Before broadcasting, `submitAndWatch` checks that the node's genesis equals the facts' genesis, and it
**refuses Portaldot mainnet** unless `allowMainnet: true` is set.

### Bot 5's `ChainAdapter`

`createPortaldotAdapter(endpoint, options)` implements `@seam/sdk`'s `ChainAdapter` exactly:

- `discover()` → `RuntimeFacts`. With `options.facts` it checks that the node still matches them.
- `readFingerprint()` → fresh `RuntimeFingerprint`
- `preflight(plan)` → `{ preflight: PreflightResult, envelope: SigningEnvelope }`. The envelope's signer is
  the plan signer (SS58), `nonce` comes from the node, `mortalityBlocks` defaults to 64, and `expiresAt` is
  now + (mortality − 1) × block time. The block time is read from metadata (`Babe.ExpectedBlockTime` =
  60 000 ms on spec 1002). `checkpoint` is the finalized head the wallet signs against (bound by the approval).
- `dryRunSigned(signedTxs)` → one `SignedDryRun` per signed transaction (see `dryRunSigned` above).
- `submit(signedTx, actionId)` → `StepOutcome { actionId, status, txHash, block, events: {pallet,name,args}[], error? }`.
  `finalized` means it is in a finalized block, and the receipt checks the events. `failed` covers
  ExtrinsicFailed (with the decoded error) and dropped/invalid/usurped. `included` means it is in a block
  but the timeout ran out before finality. `submitted` means it was not yet in a block.

`submit` dry-runs each transaction again right before broadcasting it and returns a `failed` outcome
without sending when that fails (`dryRunBeforeSubmit: false` turns this off).

Sequential plans with `requireSignedDryRun` on (Bot 3's default): transactions 2..n can't dry-run before
transaction 1 is on chain (future nonce → `'unknown'`), so the SDK's `execute` (77d3c82) gates each step on its
own. Before every step it re-reads the fingerprint, calls `dryRunSigned([thatStep])` and runs
`checkBeforeSubmit({ sendIndex, previousSteps })`, after the previous step finalized and verified. A step whose own
dry run fails is never sent; the receipt says `partial`, and the blocked step and later ones are `not_run`.

Extras: `signingRequests(calls, envelope)`, `lastDryRun`, `walletFrom(signPayload)` (turns
an extension-style `signPayload` into the SDK's `WalletSigner`), `lastPreflight`, `lastSubmit`.

```ts
const chain = createPortaldotAdapter("wss://<v3-testnet>");
const seam = new Seam(chain);
const facts = await seam.discover();
const prepared = await seam.prepare(manifest, facts, policy);
const approval = seam.approve({ ...prepared, policy, facts });
const wallet = chain.walletFrom((payload) => injector.signer.signPayload(payload)); // user's extension
const run = await seam.execute({ ...prepared, policy, facts, approval: approval.approval, wallet });
```

## How Bot 3's submit gate uses it

```ts
checkBeforeSubmit({
  ...approvedInputs,
  preparedFingerprint: facts.fingerprint,
  currentFingerprint: await refetchFingerprint(endpoint),  // runtime lock
  signedCalls: signedCallsOf(signedExtrinsics, facts),     // exact bytes inside what the wallet signed
  ...
});
```

`tests/policy.test.ts` runs this with the real package. It passes for honest inputs and blocks a swapped
signed call (`signed_bytes_mismatch`) and a changed runtime (`runtime_changed`).

## How Bot 5's receipt uses it

`submit()` / `readEvents()` return `{ pallet, name, args }` events read from System.Events at the inclusion
block. The receipt compares `Assets.Transferred(assetId, from, to, amount)`, `Assets.Issued(assetId,
beneficiary, amount)` and `Contracts.ContractEmitted(contract, data)` against the plan's decoded args.
Anyone can re-verify later with `readEvents(endpoint, block.hash, extrinsicIndex, facts)`.
`tests/sdk.test.ts` runs the SDK's whole flow on this adapter against the fake node, for sequential and
atomic plans and a failing step.

## Real vs assumed

**Real (checked against wss://mainnet.portaldot.io, read-only):**

- Snapshot: block 2,721,455, spec 1002, tx version 2, metadata V13, SS58 42, POT with 14 decimals.
  Live discovery at block ~2,721,485 gives the **same fingerprint digest**
  `0xfa84b636f16022d59470133e37c4130e936421a85d272363fb394b1116eba896`.
- Signed extensions: CheckSpecVersion, CheckTxVersion, CheckGenesis, CheckMortality, CheckNonce,
  CheckWeight and ChargeTransactionPayment. No CheckMetadataHash, so the runtime lock is the only guard
  against a same-spec metadata change.
- The node exposes author_submitAndWatchExtrinsic, chain_subscribeFinalizedHeads, payment_queryInfo,
  payment_queryFeeDetails, system_dryRun, system_accountNextIndex, state_call and **contracts_call**
  (plus contracts_getStorage, contracts_instantiate and contracts_rentProjection).
- Fees (live, fake-signed): Assets.transfer_keep_alive weight 567,688,000 with a fee of ≈1.49 × 10¹²
  base units (≈0.0149 POT). Contracts.call (gasLimit 5e9) weight 5,811,203,000 with a fee of ≈1.52 × 10¹².
  Assets.mint weight 295,983,000 with a fee of ≈1.42 × 10¹². The batch_all of all three has weight
  6,692,474,000 and a fee of ≈2.36 × 10¹².
- `system_dryRun` on a fake signature returns `Invalid(BadProof)` (`0x010004`).
- `contracts_call` response shape is `{ debugMessage, gasConsumed, result: { Ok | Err } }`, and `Err` is
  `{"Module":{"index":13,"error":12}}` = `contracts.ContractNotFound`.
- Event decoding: the real System.Events of block 2,721,116 decode byte for byte with the pinned types plus
  `DECODE_TYPES` (fixture and live test).
- `DispatchError::Module` is `{ index: u8, error: u8 }` on this runtime, while polkadot.js 17 assumes
  `[u8; 4]`. This override lives on a **separate decode-only registry** (`decodeRuntime`), so encoding and
  the fingerprint are untouched.

**Assumed / not yet checkable:**

- `DispatchError` variants 6–7 (Token, Arithmetic) use the Substrate 3.x order. They only matter for a
  failed extrinsic with that error.
- The `Assets.Asset` storage key comes from metadata hashers via polkadot.js. Mainnet has no assets, so
  "exists" has never been seen live, only "absent".
- `AssetId` u32 / `TAssetBalance` u64 are assumptions in the compiler's pinned file.
- Submission, inclusion and finality tracking are tested against the in-process fake node, and have been run
  against two local chains only: substrate-contracts-node `--dev` (spec 100) and the organizers' Portaldot
  dev node (spec 1002, old Contracts pallet). Nothing has been submitted to Portaldot mainnet or to the V3
  testnet; V3 and Revive behaviour is not verified. That waits for a V3 RPC URL and a funded test account.
- `storageDeposit` is never reported by this runtime, so it is always unknown.

## Notes

- **One copy of polkadot.js.** `.npmrc` sets `install-links=true`, so `file:../seam-compiler` is
  installed as a copy and shares this package's single `@polkadot/types`/`util`. After changing the
  compiler, rebuild it, then run `rm -rf node_modules/@seam/compiler && npm install` (npm caches the copy).
- **Quiet output.** `src/quiet.ts` sets `POLKADOTJS_DISABLE_ESM_CJS_WARNING=1`, which polkadot.js honours
  only when every copy has the same version, so a real version conflict still warns. `quietly()` drops
  exactly "Unable to map [u8; 32] to a lookup index", which polkadot.js prints while decorating V13 storage
  for well-known keys SEAM never reads.
- Raw RPC instead of `ApiPromise`: everything is encoded and decoded with the **pinned** runtime from the
  fingerprint, never with whatever metadata the node serves at the moment.

## Local dev node (substrate-contracts-node)

```sh
npm run devnode -- start          # prebuilt substrate-contracts-node v0.42.0 (sha256-checked), ws://127.0.0.1:9944
node scripts/devnode/snapshot.mjs # read-only snapshot
node scripts/devnode/setup.mjs    # //Alice: create + mint asset 1, deploy contracts/seam-demo (Bot 2's ink! contract)
node scripts/devnode/run-sequential.mjs
node scripts/devnode/run-rollback.mjs
node scripts/devnode/run-atomic.mjs <rollback-*.json>
npm run test:devnode              # SEAM_DEVNODE=1: all of the above as tests
```

### Evidence

Every script writes to `/workspace/seam-evidence/devnode/` and to the repo's `evidence/devnode/`
(see `evidence/README.md`: local dev chain, not Portaldot). Run files (`recordingVersion: 2`) record:

- **Inputs:** the full Manifest, runtime facts and fingerprint, policy JSON and rule-by-rule policy result.
- **Before signing:** preflight (with `proofSize`), signing envelope, approval, and the signing requests (payload and sign bytes).
- **Gate checks:** one `gateChecks[]` entry per SDK `onStep` event with a `check` (sending, done, blocked), holding the gate's `ok`, `reasons` and `passed` list as the SDK reported them. Atomic and first-step refusals come from `run.check`. Nothing is recomputed.
- **After submitting:** the SDK step log, node status history, events and receipt.
- **Rollback only:** SEAM's blocking gate result with its reasons, then the test-only direct submission (status history,
  decoded events) and the balances before, after the gate, and after.

Evidence never contains signatures, signed extrinsics, seeds or keys: `saveEvidence` refuses such fields and dev
derivation paths. The signed extrinsic the rollback resends exists in memory only.

Metadata V14, spec `substrate-contracts-node` 100, instant seal (a block per transaction, finalized after 1 s),
system_properties empty (UNIT/12 is declared via `declaredToken`), no Babe (pass `blockTimeMs`).
Dev keys are public: these scripts refuse any endpoint other than localhost and the Portaldot mainnet genesis.
The contract step is written by message name and arguments (`settle`, `abiRef: seam_demo`, `proofSize`,
`storageDepositLimit: null`); @seam/compiler binds the V14 `Contracts.call` shape, so the run scripts no longer patch it.
The step is verified by `Contracts.ContractEmitted` from the contract. `seam_emitter` (fixtures/devnode, 158-byte
hand-written Wasm) is only the earlier stand-in.

## Testnet run

`scripts/testnet-run.mjs RPC_URL` (read-only report; `--yes` plus `SEAM_SIGNER` or `--external ADDRESS` to deploy and run the flows) is described in [docs/testnet-run.md](docs/testnet-run.md), including the browser-wallet steps. Tested on the local dev node only.

## Hosted V3 read-only discovery (`scripts/v3-discover.mjs`)

**V3 is NOT VERIFIED.** No hosted Portaldot V3 RPC URL has been run through this yet. The only metadata in the repo is the mainnet spec 1002 snapshot (no Revive, no Nfts), and the tests use that plus an in-process fake node. Once a V3 RPC URL exists:

```bash
npm run build
node scripts/v3-discover.mjs wss://<v3-rpc-host> --out evidence/v3-discovery
```

It sends only reads (`state_getMetadata`, `state_getRuntimeVersion`, `system_chain`, genesis/head, `system_properties`, `rpc_methods`, `Metadata_metadata_versions` via `state_call`), never a transaction, and needs no key. Any other method is refused by a wrapper before it reaches the node. The Portaldot mainnet host is refused by URL, and a node with the mainnet genesis hash is refused before anything is written; there is no override flag.

It writes `<name>-snapshot.json` and `<name>-metadata.hex` (same format as the mainnet evidence), `v3-capabilities.json` and `v3-capabilities.md`. Each item (pallets Revive/Contracts/Nfts/Assets/Utility, their calls such as `Revive.call`, `Revive.instantiate_with_code`, `Nfts.mint`, `Utility.batch_all`, runtime APIs `ReviveApi`/`ContractsApi`, signed extensions, and a few RPC methods) is `observed`, `absent` (the list that would contain it was read and it is not there) or `NOT VERIFIED` (the list could not be read). Review the files by hand before calling anything V3-compatible; a report from one node is not a compatibility proof, and funded writes still need a separate run.

## Browser entry (`@seam/chain/browser`)

`import { verifySignedAgainstRequest, verifySignedBatch, assembleSignedExtrinsic } from '@seam/chain/browser'` gives the offline signature checks and the extrinsic assembler without any node builtin, WebSocket client or `@seam/compiler` runtime import (the compiler reads its types file with `node:fs` at load time, so the chain's signing code builds its registry with `src/runtime-core.ts`, a browser-safe copy of the compiler's `loadRuntime`; a test keeps the two in step). The functions are the same objects the node entry exports. It also exports `buildSigningRequest(callHex, facts, input)` and `buildSigningRequests(plan, facts, envelope)` (pure; the plan is a type-only import here), so a browser can build the payloads a wallet signs. It does not connect, discover, sign or submit.

**Facts in the browser.** `factsFromChainInputs(inputs, opts?)` and `fingerprintFromChainInputs(inputs, opts?)` are exported from `@seam/chain/browser` too. They are the same pure code the node discovery path runs (`src/facts-core.ts`), so identical inputs give identical `RuntimeFacts`, `fingerprintDigest` and `metadataLayoutHash` (tested on the committed spec 1002 and V3 spec 3002 metadata). The only difference: the node entry defaults `typesBundle` to the compiler's pinned spec 1002 file, read from disk. The browser entry has no default. Metadata V14+ (V3) needs none; V13 and older must be given `typesBundle` (the exact text of `@seam/compiler/types/portaldot-spec1002.json`), or it fails with `NODE_MISSING_VALUE`. From the compiler it imports only `@seam/compiler/facts`, the node-free facts path.

**Live capabilities (`liveCapabilities`, `readLiveCapabilities`).** For each SEAM action, these report whether the connected runtime supports it, read from the runtime's own metadata. They are exported from both `@seam/chain` and `@seam/chain/browser`. They are read-only: they never sign or submit.

```ts
import { liveCapabilities, readLiveCapabilities } from "@seam/chain/browser";
// Pure, from inputs you already read (same ChainInputs and options as factsFromChainInputs):
const caps = liveCapabilities(inputs, { typesBundle }); // typesBundle only for metadata V13 and older
// Or read live through any JSON-RPC sender (a fetch wrapper, or httpRpcClient(url).send):
const caps2 = await readLiveCapabilities((method, params) => rpc.send(method, params), {
  endpoint,
});
```

`readLiveCapabilities` reads only `chain_getBlockHash(0)`, `chain_getFinalizedHead`, `chain_getHeader`, `state_getRuntimeVersion` and `state_getMetadata` at the finalized head, and `system_properties`.

The result (`LiveCapabilities`):

| field                                                                                | contents                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                                                            | `1`                                                                                                                                                                   |
| `fingerprint`                                                                        | The compiler's `RuntimeFingerprint`: genesisHash, specName, specVersion, transactionVersion, metadataHash, ss58Prefix, tokenSymbol, tokenDecimals, typesBundleHash    |
| `fingerprintDigest`, `metadataLayoutHash`, `metadataVersion`, `atBlock`, `endpoint?` | Same values as the discovery path                                                                                                                                     |
| `actions`                                                                            | One `ActionCapability` per kind: `assets.transfer`, `assets.mint`, `nfts.mint`, `contracts.call`, `revive.call`, `revive.instantiate_with_code`, `revive.map_account` |

`ActionCapability` is `{ kind, capability: "Pallet.call_name", presence, supported, reasonCode?, reason, palletIndex, callIndex, args: [{ name, type, rawType }] }`. The result also carries `facts` (the `RuntimeFacts` it was derived from), so a consumer can hand them straight to the compiler.

- Indices, names and types come only from the metadata. `palletIndex` and `callIndex` are `null` when the call is not there.
- `name` is the camelCased metadata name. `rawType` is the type resolved through the metadata's registry, with named V13 aliases such as `AssetId` and `BalanceOf` resolved too.
- `presence` is what the metadata shows: `observed`, `pallet_missing`, `call_missing` or `unreadable`.
- `reasonCode` uses the compiler's own codes, set the same way `compile()` and `supportedKinds` set them:
  - `NO_OBSERVED_V3_METADATA`: a V3 kind (`nfts.mint`, `revive.*`) whose call is not in the metadata.
  - `V3_ARG_SHAPE_MISMATCH`: a V3 kind whose arguments do not match the shape contract.

  The `assets.*` and `contracts.call` kinds carry no code, as in the compiler; `reason` explains them.

The verdict (`supported`, `reasonCode`, `reason`) is `supportedKinds(facts)` from `@seam/compiler/browser`, unchanged; this module has no support rules of its own. Indices are reported only when the metadata reading agrees with `supportedKinds`; if they ever differ, the action is unsupported. `tests/live-capabilities.test.ts` checks that every field equals `supportedKinds` and `compile()` on the same `facts`, for the spec 3002 and spec 1002 fixtures and for mutated versions of spec 3002. `@seam/compiler` does not depend on `@seam/chain`, so there is no cycle.

`scripts/v3-live-capabilities.mjs` runs it read-only against the V3 test node. It writes `evidence/testnet-v3/capabilities-<ts>.json`.

## Browser preflight

`@seam/chain/browser` exports the same preflight as the node entry, over a plain JSON-RPC `send`:

```ts
import { preflight, preflightReport } from "@seam/chain/browser";

const send = (method: string, params: unknown[]) => myFetchJsonRpc(method, params); // RpcSend
const result = await preflight(send, plan, facts, { at, nonce, signedExtrinsics }); // PreflightResult
const report = await preflightReport(send, plan, facts); // PreflightReport (coverage, transactions, nonce, ...)
```

- `preflight(rpc: RpcSend | RpcClient, plan: Plan, facts: RuntimeFacts, opts?: PreflightCoreOptions): Promise<PreflightResult>` returns `{ steps: [{ actionId, weight, fee, storageDeposit, proofSize?, dryRun, note }], totalFee }`, one step per plan step. This is what `@seam/policy/browser` `assertPolicyAllows` / `gatePolicy` take as `preflight`.
- Node and browser run one implementation, `preflightWithClient` in `src/preflight-core.ts`. The node `preflight(endpoint, ...)` only opens the connection around it.
- Methods it sends, all read-only: `chain_getBlockHash`, `chain_getHeader`, `state_getRuntimeVersion`, `system_accountNextIndex`, `payment_queryInfo`, `payment_queryFeeDetails`, `state_getStorage` (asset existence, Revive account mapping), `contracts_call` or `state_call ContractsApi_call` (for `contracts.call` steps), and `system_dryRun` only when signed extrinsics are given.
- Fee and weight come from `payment_queryInfo` on a fake-signed extrinsic: the signer's address, the nonce, the era from the block and filler signature bytes (`fakeSignedExtrinsic`). It is never submittable and no key is needed.
- `dryRun`:
  - `"ok"` or `"failed"` for a step only from the node: `system_dryRun` of a really signed extrinsic, or a contract dry run for `contracts.call`.
  - To get a signed dry run, pass `opts.signedExtrinsics`: the real signed extrinsics, one per transaction SEAM would send (same order as the signing requests; a sequential plan has one per step, an atomic plan one batch). SEAM never signs; without them `dryRun` is `"unknown"`.
  - A fake signature is never dry-run: the node rejects it.
- Anything the node does not answer is `{ unknown: true }`, or `dryRun: "unknown"`. An RPC error on `payment_queryInfo` leaves that step's fee and weight unknown and `totalFee` unknown, and the gate blocks. `storageDeposit` is always unknown (the runtime does not report it). If the node cannot be reached at all, `preflight` throws.

`scripts/v3-live-preflight.mjs` runs it read-only against the V3 test node for the demo plan (`packages/console/src/demo/v3-demo-transfer.json`) and records Sentinel's gate verdict with the sequential demo policy. It writes `evidence/testnet-v3/preflight-<ts>.json`.
