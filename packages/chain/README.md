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
| function | returns |
|---|---|
| `discover(endpoint, { typesBundle?, batchAllRollback? })` | the compiler's `RuntimeFacts` (via `factsFromMetadata` with the pinned types) |
| `readChainInputs(endpoint)` | raw `ChainInputs`: metadata, runtime version, genesis, properties, head, **all pinned to one block hash** |
| `factsFromChainInputs(inputs)` / `fingerprintFromChainInputs(inputs)` | pure versions (no network) |
| `snapshotFromNode(endpoint, outDir, { name? })` | writes `<name>-metadata.hex` + `<name>-snapshot.json` in the same format as the mainnet evidence, plus `signedExtensions`, `rpcMethods`, `fetchedAt` and `fingerprintDigest`. Use it for the V3 testnet. |
| `chainInputsFromSnapshot(snapshotJson, metadataHex)` | replays a saved snapshot offline (checks the metadata hash) |
| `readCheckpoint(endpoint)` | finalized head `{ number, hash }`: the era checkpoint for signing |
| `listRpcMethods`, `signedExtensionsOf`, `tokenInfo` | helpers |

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

### 4. Signing handoff
| function | what |
|---|---|
| `buildSigningRequests(plan, facts, envelope)` | era from `envelope.checkpoint`; one `SigningRequest` per transaction: the `outerCall` batch_all for atomic plans, or each step with nonce `envelope.nonce + i`. Each request has `payload` (polkadot.js-extension `SignerPayloadJSON` for `signer.signPayload`), `raw` (`SignerPayloadRaw`), `signingPayloadHex` (SCALE payload) and `signBytesHex` (exact bytes the key signs, which is the blake2b-256 of the payload when it is over 256 bytes), plus `callHex`, `nonce`, `era` |
| `buildSigningRequest(callHex, facts, { signer, nonce, mortalityBlocks, checkpoint })` | the same for one call |
| `signingRequestsForCalls(calls, facts, envelope)` | the same for explicit calls (the SDK wallet's `callsToSign(plan)`) |
| `dryRunSigned(endpoint, signedTxs, facts)` | `system_dryRun` of each signed transaction → `{ results: ('ok'\|'failed'\|'unknown')[], details }` for `checkBeforeSubmit({ signedDryRun })`. In a sequential run, transaction i > 0 with a future nonce is `'unknown'` (the earlier ones aren't on chain yet) |
| `signBytesOf(payload, facts)` | the bytes a key signs for a payload (for raw-signing wallets) |
| `assembleSignedExtrinsic(payload, signature, facts, { scheme?, verify? })` | signed extrinsic hex. Refuses a payload for another genesis, spec or tx version, a non-zero tip, or other signed extensions. By default it **verifies the signature** first. Typed (65/66-byte) signatures are taken as given. An untyped 64-byte one needs `scheme`. |
| `extractSignedCall(extrinsicHex, facts)` | `{ callHex, capability, palletIndex, callIndex, signer { accountId, ss58 }, nonce, era, tip, signature, signatureScheme, txHash }`: what is **actually inside** the extrinsic |
| `signedCallsOf(extrinsics, facts)` | `Hex[]` → Bot 3's `checkBeforeSubmit({ signedCalls })` |
| `checkSignedExtrinsic(extrinsicHex, request, facts)` | compares call, signer, nonce, era and tip, and verifies the signature over the extrinsic's own contents. Returns `{ ok, mismatches[] }` |

Tip is always 0. `mortalityBlocks` must be a power of two from 4 to 65536. polkadot.js silently rounds
other values, and SEAM signs exactly what was approved. Don't use a polkadot.js extension's `signRaw` for
transactions, because it wraps data in `<Bytes>`. Use `signPayload`.

### 5. Submit and track
| function | what |
|---|---|
| `submitAndWatch(endpoint, signedHex, onStatus, { facts, timeoutMs?, allowMainnet? })` | `author_submitAndWatchExtrinsic`. `onStatus` gets `submitted` → `in_block` → `finalized`, or `retracted` / `dropped` / `invalid` / `usurped` / `finality_timeout`. Returns `{ txHash, status, history, timedOut, error?, inclusion: { number, hash, extrinsicIndex, events, success, dispatchError? } }` |
| `readEvents(endpoint, blockHash, extrinsicIndex, facts)` | System.Events at that block, filtered to that extrinsic. Refuses a block whose spec differs from the pinned one |
| `readInclusion(endpoint, blockHash, txHash, facts)` | the same, finding the index by tx hash |
| `waitFinalized(endpoint, blockHash, { timeoutMs })` | `{ finalized, block, reason?: 'timeout' \| 'not_canonical' }` |
| `decodeBlockEvents(eventsHex, facts)` / `outcomeForExtrinsic(...)` | offline decoding |

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
const chain = createPortaldotAdapter('wss://<v3-testnet>');
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
- Submission, inclusion and finality tracking are tested against the in-process fake node only. Nothing has
  been submitted to any real chain yet; that waits for a local dev node or the V3 testnet.
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
node scripts/devnode/snapshot.mjs # read-only snapshot -> /workspace/seam-evidence/devnode/
node scripts/devnode/setup.mjs    # //Alice: create + mint asset 1, deploy fixtures/devnode/seam_emitter.wasm
npm run test:devnode              # SEAM_DEVNODE=1: sequential, rollback, atomic runs (evidence in .../runs/)
```

Metadata V14, spec `substrate-contracts-node` 100, instant seal (a block per transaction, finalized after 1 s),
system_properties empty (UNIT/12 is declared via `declaredToken`), no Babe (pass `blockTimeMs`).
Dev keys are public: these scripts refuse any endpoint other than localhost and the Portaldot mainnet genesis.
`seam_emitter` is a 158-byte hand-written Wasm contract (fixtures/devnode/seam_emitter.wat) that emits one
event; replace it with Bot 2's ink! demo contract when that lands. Contracts.call needs a shim on V14 until the
compiler binds `storage_deposit_limit` and Weight V2: see docs/devnode-assumptions.md.
