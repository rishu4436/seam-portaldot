# Manifest Builder

The live console's **New transaction** view builds a Manifest from the selected wallet account, live runtime facts and one or more actions. The builder compiles and prepares the plan; the separate review and signing stages handle approval and submission.

## Build and review an operation

1. Connect a Polkadot wallet and select the intended account. Account discovery and runtime reads do not require a signature.
2. Read live facts for the hosted V3 testnet. The compiler's `supportedKinds(facts)` determines available actions and explains unsupported call shapes.
3. Add actions and enter their arguments. Form fields come from `argFields(kind)`; amounts use the asset's base units. Account and recipient readiness checks describe balance and account-existence requirements.
4. Choose sequential or preferred/required atomic execution. Atomic verification requires rollback evidence for the selected runtime and composition; a local-node result does not establish V3 atomicity.
5. Compile against the observed runtime. `checkManifest` supplies field-level validation; a successful result contains the compiled plan.
6. Review the plan, policy and live preflight estimate. Asset minting also checks the live issuer. An allow-list does not grant on-chain mint authority.
7. Send the plan to review and approve it before the wallet signs. Changes to the draft or policy clear the prior selection and approval. Runtime drift can require recompilation and a new approval.

The live flow is wired through `packages/console/src/App.tsx`, `components/ManifestBuilder.tsx` and `components/BuilderPolicy.tsx`. The signing flow uses an external wallet and performs its own submit-time checks; the builder itself never broadcasts.

## Manifest import and export

Export uses the compiler's `serializeManifest` to produce canonical JSON. Import validates the document and uses the currently selected wallet account as the signer. Invalid JSON, unsupported action kinds and missing or duplicate action IDs produce validation errors.

An imported Manifest is an operation description, not an authorization to send. It must be compiled, checked and approved for the current account and runtime.

## Compiler browser API

`@seam/compiler/browser` provides the compiler and metadata helpers without Node built-ins:

```ts
compile(manifest: Manifest, facts: RuntimeFacts, options?: CompileOptions): Plan
supportedKinds(facts: RuntimeFacts): KindAvailability[]
argFields(kind: ActionKind): ArgField[]
checkManifest(manifest, facts, options?): ManifestCheck
```

`supportedKinds` returns observed pallet/call indexes for supported actions, or a reason and stable cause code for an unsupported kind. Indexes are runtime observations, not constants to copy into an application.

`argFields` derives required and optional fields from the compiler's argument schema. `checkManifest` returns compilation issues with paths such as `actions[0].args.amount` instead of treating an invalid draft as a successful plan.

See the [reference](reference.md) for Manifest fields and [security gates](SECURITY_GATES.md) for the approval and submission boundaries.

## Receipt verification

After submission, the SDK verifies the recorded execution using the expected action, signed call bytes and chain observations. A Revive call remains unknown without sufficient expected event evidence; a finalized extrinsic alone does not prove an arbitrary contract effect.

The [SDK documentation](sdk.md) explains the browser verifier exports, atomic per-step outcomes, receipt integrity and independent chain verification. Native swap archives are handled in the separate [native swap workspace](native-swaps-v3.md).

## Runnable example

After building the packages, run the browser-entry compilation example from the repository root:

```sh
node docs/examples/builder-compile.mjs
```

This example reads recorded V3 facts, inspects supported actions and arguments, compiles a Manifest and exercises policy refusal without a live preflight. It signs and submits nothing. Recorded facts and outputs do not establish current wallet authorization or a new testnet execution.
