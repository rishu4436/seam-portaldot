# Manifest Builder

How the console's Manifest Builder works on `main` at `dbe8e3b`, and the browser-safe APIs it is meant to sit on.
Everything below is read from the code and tests at that commit. Parts that are **not wired yet** are listed at the end.

## Console flow (`packages/console/src/components/ManifestBuilder.tsx`, Pixel `39b2bf6`)

`App.tsx` renders `<ManifestBuilder />` when the wallet demo is off. The component never signs or submits.

1. **Wallet connect and account pick.** `listWalletAccounts()` (`lib/manifestbuilder.ts`) calls `enable("SEAM console")`
   on every extension in `globalThis.injectedWeb3` and lists their accounts. No extension, a wallet error, or zero
   accounts gives a plain message and no signer. The picked account becomes `signer: { type: "ss58", value }`; there is
   no hardcoded signer.
2. **Network pick.** "V3 HTTPS" (`V3_HTTPS_RPC` from `lib/v3facts.ts`) or a custom RPC URL.
3. **Live facts.** "Read live runtime facts" runs `liveFactsStep` (from `components/Modes.tsx`) over the
   `lib/browserChain` transport. Read-only; an RPC error becomes `{ ok: false, reason: "rpc_error" }`.
4. **Action support.** `actionSupport(facts)` marks each of the 7 kinds supported only when
   `facts.capabilities["Pallet.call"].status === "observed"`; otherwise it shows the status as the reason. With no facts
   nothing is supported. (This reads the facts directly; it does not call `readLiveCapabilities` or `supportedKinds`, see below.)
5. **Steps.** Add, edit and remove actions (`emptyAction` gives ids `step1`, `step2`, ...). Form fields come from the
   console's own `FORM_FIELDS` table, which mirrors the compiler's argument names. Values stay strings; the compiler
   validates them.
6. **Atomicity.** `"preferred"` (default, may fall back to sequential), `"required"` (sets `atomicRequired: true`) or
   `"sequential"`. `buildManifest(signer, actions, atomicity, chain?)` builds the Manifest and drops empty optional fields.
7. **JSON export and import.** Export downloads `seam-manifest.json`. `parseManifestJson(text)` refuses invalid JSON,
   `version !== 1`, no actions, a missing or duplicate id, or an unknown kind. An imported signer is replaced by the
   connected account.
8. **Compile.** Only through an injected `compile?: CompileFn` prop. `App.tsx` passes none, so on `dbe8e3b` the button
   reports _"The browser compiler is not wired in this build, so nothing was compiled."_

Compile stays disabled until an account is picked, facts are read, at least one action exists and every action is supported.

## `@seam/compiler/browser` (Forge `559581e`)

No node built-ins; same function objects as the main entry. Exports (from `packages/compiler/src/browser.ts`):
everything in `@seam/compiler/facts`, `compile`, `computePlanDigest`, `computeManifestDigest`, `KIND_TO_CAPABILITY`,
`BATCH_CAPABILITY`, `evaluateRollbackProof`, `supportedKinds`, `argFields`, `checkManifest`, `canonicalJson`,
`digestJson`, `domainHash`, `DOMAIN`, `parseNativeAddress`, `parseH160`, and the types `KindAvailability`, `ArgField`,
`ArgFieldType`, `ManifestCheck`, `NativeAddress`.

```ts
compile(manifest: Manifest, facts: RuntimeFacts, options?: CompileOptions): Plan
supportedKinds(facts: RuntimeFacts): KindAvailability[]   // throws SeamCompileError on invalid facts
argFields(kind: ActionKind): ArgField[]                   // { name, type: ArgFieldType, required, description }
checkManifest(manifest, facts, options?): ManifestCheck   // never throws a SeamCompileError
```

- `KindAvailability` is `{ kind, capability, supported: true, palletIndex, callIndex }` or
  `{ kind, capability, supported: false, reason, reasonCode? }`.
- `ArgFieldType` is one of `amount`, `id`, `accountAddress`, `contractAddress`, `hexBytes`, `weight`, `salt`, `json`.
  `argFields` is derived from the compiler's own `ARG_SCHEMA`, required fields first.
- `ManifestCheck` is `{ ok, issues: CompileIssue[], unavailable: { step, actionId, reason, reasonCode? }[], plan? }`.
  It runs `compile()` itself; issues carry paths such as `actions[0].args.amount`.

## `@seam/chain/browser` live capabilities (Chainsmith `1d678a0`)

From `packages/chain/src/live-capabilities.ts`:

```ts
readLiveCapabilities(send: RpcSend, opts?: FactsOptions & { endpoint?: string }): Promise<LiveCapabilities>
liveCapabilities(inputs: ChainInputs, opts?: FactsOptions): LiveCapabilities
type RpcSend = (method: string, params: unknown[]) => Promise<unknown>
```

`readLiveCapabilities` reads only: genesis hash, finalized head and header, runtime version and metadata at that head,
and `system_properties`. It never signs or submits.

`LiveCapabilities` is `{ version: 1, fingerprint, fingerprintDigest, metadataVersion, metadataLayoutHash, atBlock,
endpoint?, actions, facts }`. `facts` is `RuntimeFacts`, ready for `compile` / `supportedKinds`.
`actions[kind]` is an `ActionCapability`:

```ts
{ kind, capability /* "Pallet.call_name" */, presence /* "observed" | "pallet_missing" | "call_missing" | "unreadable" */,
  supported, reasonCode? /* "NO_OBSERVED_V3_METADATA" | "V3_ARG_SHAPE_MISMATCH" */, reason,
  palletIndex: number | null, callIndex: number | null, args: { name, type, rawType: string | null }[] }
```

Also exported: `shapeMismatch`, `argMatchesClass`, `isWeightV2RawType`, `SEAM_ACTION_KINDS`, `ACTION_CAPABILITY`,
`ACTION_SHAPES`, `V3_ACTION_KINDS`.

**Live V3 run** (read-only): `evidence/testnet-v3/capabilities-1792508589179.json`, spec 3002, block #118808,
`metadataLayoutHash` `0x221ba8f7dd81e0341fca9f0074a3e433659c97300cbbb2f874dbd5f0d998b304`. All 7 kinds `supported`:
`assets.transfer` 39/9, `assets.mint` 39/6, `nfts.mint` 47/3, `contracts.call` 21/6, `revive.call` 80/1,
`revive.instantiate_with_code` 80/3, `revive.map_account` 80/7.

## SDK / Node example

[`docs/examples/builder-compile.mjs`](examples/builder-compile.mjs) uses the browser entries from Node. Run it from
the repo root after `npm run build`:

```sh
node docs/examples/builder-compile.mjs
```

It takes `facts` from the capabilities evidence, prints `supportedKinds` and `argFields("assets.transfer")`, runs
`checkManifest` and `compile` on the V3 wallet-demo Manifest, then calls `assertPolicyAllows` with no preflight.
Output on `dbe8e3b` (run 2026-10-20):

```
assets.transfer 39/9
...
revive.map_account 80/7
assets.transfer fields: assetId, amount, recipient
checkManifest ok: true issues: 0
mode: sequential planDigest: 0xb7a80ae632f164d2f6f611718f0648f668e9cf90d51db4dbb49fa6462c941176
same metadataHash as the demo plan's facts: false
same call bytes as the demo plan: true
gate blocked: PREFLIGHT_UNKNOWN
  Preflight ran: Unknown, so blocked. No preflight result was given, so fees, weight and dry runs are unknown.
```

The call bytes equal the committed demo plan, but the plan digest does not: the #118808 read saw a different raw
`metadataHash` than the facts the demo plan was compiled from, and the digest binds the fingerprint. The layout hash is
the same (layout hash v2 blanks `Revive.EthBlockBuilderIR`).

## Not wired yet on `dbe8e3b`

- **Compiler in the console.** No `compile` prop is passed, so the builder does not compile. It also does not use
  `argFields`, `checkManifest`, `supportedKinds` or `readLiveCapabilities` yet; it uses its own `FORM_FIELDS` and
  `actionSupport`. (Pixel's wiring commit is pending.)
- **Compile-to-signing handoff.** `onCompiled` exists but nothing consumes it; a built plan cannot reach the signer.
- **Browser preflight.** `@seam/chain/browser` has no `preflight` export (Chainsmith, pending). Without a full
  `PreflightResult` the policy gate blocks with `PREFLIGHT_UNKNOWN`, as the example shows.
- **Policy gate in the console.** `@seam/policy/browser` is not imported anywhere in `packages/console` yet. See
  [SECURITY_GATES.md, Browser policy flow](SECURITY_GATES.md#browser-policy-flow).
