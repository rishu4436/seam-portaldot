# SEAM architecture

> **Evidence scope:** the hosted Portaldot V3 testnet (spec 3002) has finalized SEAM runs, each indexed with its verification file in [evidence-manifest.md](evidence-manifest.md): the funded run of 2026-10-19 (18 transactions, local keystore signer) and later console runs signed through the polkadot.js extension (#118310, #119634, #119996, #120936, #121390/#121394). Local chains (a `substrate-contracts-node` dev chain and a local Portaldot dev node, spec 1002) are recorded separately and show nothing about V3. Not shown anywhere: a per-call Revive effect, a fresh account mapping, ink!/PolkaVM on V3, or cross-VM atomicity. Portaldot mainnet is only read (snapshot); nothing has been submitted to it.

## Pipeline

```mermaid
flowchart TB
  subgraph PKG["Packages (import direction: compiler <- policy <- chain <- sdk; console uses the */browser entries)"]
    direction LR
    PC["@seam/compiler<br/>compile, supportedKinds,<br/>computePlanDigest, rebindPlan"]
    PP["@seam/policy (+ /browser)<br/>evaluatePolicy, assertPolicyAllows,<br/>createApproval, checkRuntimeLock,<br/>checkBeforeSubmit"]
    PH["@seam/chain (+ /browser)<br/>discover, preflight, buildSigningRequests,<br/>signedExtrinsicDecoder, submitAndWatch"]
    PS["@seam/sdk (+ /browser) and seam CLI<br/>parseManifest, Seam.execute, buildReceipt,<br/>verifyStep, seam verify"]
    PU["packages/console<br/>React + Vite, LIVE V3 / recorded / offline"]
    PP --> PC
    PH --> PC
    PS --> PC
    PS --> PP
    PS -. "optional, for --endpoint" .-> PH
    PU --> PC
    PU --> PP
    PU --> PH
    PU --> PS
  end

  M["Manifest (JSON, manifestDigest)<br/><i>sdk parseManifest / console builder</i>"]
  D["Runtime facts + fingerprint<br/>live node (read-only) or snapshot<br/><i>chain discover / factsFromChainInputs</i>"]
  C{"compile<br/><i>@seam/compiler</i>"}
  PL["Plan + planDigest<br/>atomic_verified / atomic_unverified /<br/>sequential / unavailable"]
  P["Preflight<br/>fees (payment_queryInfo), asset balance + minBalance,<br/>pre-sign dry run (may be unknown = weaker proof)<br/><i>@seam/chain preflight</i>"]
  PO["Policy gate + approval<br/>allow-lists, caps, modes, expiry;<br/>approvalHash binds plan, policy, preflight, envelope<br/><i>@seam/policy assertPolicyAllows, createApproval</i>"]
  W["Wallet signing<br/>polkadot.js extension (console) or external signer (SDK);<br/>nonce n+i per step; SEAM never holds keys<br/><i>@seam/chain buildSigningRequests</i>"]
  G["Submit gate (per step)<br/>signed bytes decoded = approved calls,<br/>runtime lock (raw or layout_hash), signed dry run,<br/>single use, earlier steps verified<br/><i>@seam/policy checkBeforeSubmit</i>"]
  S["Submit + finalization<br/><i>@seam/chain submitAndWatch</i>"]
  CH[("Portaldot chain<br/>V3 testnet (spec 3002) or local dev node")]
  R["Receipt<br/>per-step tx, block, fee, events, nonce + nonceSource,<br/>approvalInputs, runtimeLock<br/><i>sdk buildReceipt / verifyStep; console receipts</i>"]
  V["Verify<br/>offline: integrity, planDigest, approvalHash<br/>--endpoint: read-only chain re-check<br/><i>seam verify, independent scripts -> evidence/</i>"]

  M --> C
  D --> C
  C --> PL --> P --> PO --> W --> G
  G -- "allowed" --> S --> CH
  G -. "blocked: nothing sent" .-> R
  CH --> R --> V
  V -. "reads" .-> CH

  classDef pkg fill:#e8eefc,stroke:#4a6fa5,color:#000;
  class PC,PP,PH,PS,PU pkg;
```

Images for slides and the README: [architecture.png](img/architecture.png), [architecture.svg](img/architecture.svg). Mermaid sources: `docs/img/*.mmd`. The package edges follow the real `import` statements in `packages/*/src` (on `7a551e3`): policy imports only `@seam/compiler/browser`; chain imports only the compiler; the SDK imports compiler and policy and loads `@seam/chain` dynamically for `--endpoint`; the console imports the `*/browser` entries of all four.

**In plain words.** A Manifest (written by hand, by the SDK, or in the console's Manifest Builder) is compiled against runtime facts read from the live node or a snapshot. The compiler builds exact calls from the chain's own metadata and picks a plan mode: `atomic_verified`, `atomic_unverified` (opt-in only), `sequential` (the default), or `unavailable`. The plan has a deterministic `planDigest`. Preflight estimates fees, checks the signer's asset balance against the asset's `minBalance` for `assets.transfer`, and reports a pre-sign dry run, which may be `unknown` (allowed only as weaker proof). The policy gate then runs fail-closed right before the wallet, and `createApproval` binds plan, policy, preflight and signing envelope into one `approvalHash`. The user's wallet signs (the console uses the polkadot.js extension; SEAM never holds keys), one transaction per step with nonce `n + i`. Before each send, `checkBeforeSubmit` decodes the signed bytes and compares them with the approved calls, re-checks the runtime lock (`lockBasis` `raw`, or `layout_hash` when only the raw metadata hash drifted and the layout is unchanged), requires the signed dry run, enforces single use and stops a sequential run unless every earlier step is finalized and verified. The receipt records what the chain shows; `seam verify` and the independent scripts behind `evidence/` re-check it. A Revive contract deploy done as a setup script (as at #102843) stays an **unchecked setup step** outside policy; the compiler's `revive.instantiate_with_code` kind is policy-checked (code-hash allow-list), but no deploy through policy has been run on V3.

| Stage | Package |
| --- | --- |
| Manifest | `packages/sdk` (`parseManifest`) |
| Discovery, fingerprint, preflight (incl. balance/`minBalance`), signing requests, signed-extrinsic decoding, submit and track | `packages/chain` |
| Compile and plan modes | `packages/compiler` |
| Policy, approval, runtime lock, submit gate | `packages/policy` |
| Receipt, explanations, `seam` CLI | `packages/sdk` |
| LIVE V3 signing, recorded and offline modes | `packages/console` |

## Per-step submit gate

```mermaid
flowchart LR
  IN["Signed step<br/>from wallet"] --> K1["Order + earlier steps ok<br/>step_order, previous_steps_ok"]
  K1 --> K2["Approval valid<br/>unused, in time, intact, matches"]
  K2 --> K3["Runtime unchanged<br/>lockBasis raw or layout_hash"]
  K3 --> K4["Signed bytes ==<br/>approved calls"]
  K4 --> K5["Signed dry run ok"]
  K5 --> OK["Send"]
  K1 & K2 & K3 & K4 & K5 -. "any fails" .-> NO["Blocked, plain reason<br/>(sequential: run stops, receipt partial)"]
  classDef ok fill:#e3f6e8,stroke:#2e7d32,color:#000;
  classDef no fill:#fde8e8,stroke:#c62828,color:#000;
  class OK ok; class NO no;
```

Gate check codes and block reasons: [reference.md](reference.md#submit-gate-block-reasons). Image: [gate.png](img/gate.png).
