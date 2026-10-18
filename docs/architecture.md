# SEAM architecture

> **Evidence scope:** two local chains were used: a `substrate-contracts-node` dev chain and a local Portaldot dev node (spec 1002). Neither is the hosted Portaldot V3 testnet or mainnet, and local success does not show V3 or Revive support. Portaldot mainnet is only read (snapshot). Nothing has been submitted to the V3 testnet or mainnet.

## Pipeline

```mermaid
flowchart TB
  M["Manifest<br/>(JSON, deterministic digest)<br/><i>sdk: parseManifest</i>"]
  D["Runtime discovery<br/>(live node or snapshot)<br/><i>chain: discover</i>"]
  F["Fingerprint + lock<br/>(runtime must not change)<br/><i>chain / policy: checkRuntimeLock</i>"]
  C{"Compiler<br/><i>compiler: compile</i>"}
  A1["atomic_verified<br/>batch_all, rollback proven"]
  A2["atomic_unverified<br/>opt-in only, default policy refuses"]
  A3["sequential<br/>one tx per step (default)"]
  A4["unavailable<br/>nothing can run"]
  P["Preflight<br/>fees, weight, dry run<br/><i>chain: preflight</i>"]
  PO["Policy + approval<br/>allowed messages, pinned ABI hashes,<br/>approval hash<br/><i>policy: evaluatePolicy, createApproval</i>"]
  W["Wallet signing<br/>external signer / extension<br/>SEAM never holds keys<br/><i>chain: buildSigningRequests</i>"]
  G["Per-step gate<br/>checkBeforeSubmit<br/><i>policy</i>"]
  S["Submit + finalization<br/><i>chain: submitAndWatch</i>"]
  V["Verification<br/>events must match the plan<br/><i>sdk: buildReceipt</i>"]
  R["Execution Receipt<br/>verified / partial / not_verified<br/><i>sdk: seam verify</i>"]
  CON["Console (React + Vite)<br/>replays recorded runs, no live node"]
  EV[("evidence/devnode<br/>local test chain recordings")]
  SETUP["Contract deploy<br/>UNCHECKED SETUP STEP<br/>outside the plan, not policy-evaluated"]

  M --> D --> F --> C
  C --> A1 & A2 & A3 & A4
  A1 & A2 & A3 --> P --> PO --> W --> G --> S --> V --> R
  A4 -. "stop, reason shown" .-> R
  G -. "blocked: no send" .-> R
  SETUP -.-> S
  EV --> CON
  R -. "recorded into" .-> EV

  classDef warn fill:#fff3cd,stroke:#b58900,color:#000;
  classDef store fill:#e8eefc,stroke:#4a6fa5,color:#000;
  class SETUP warn;
  class EV,CON store;
```

Images for slides and the README: [architecture.png](img/architecture.png), [architecture.svg](img/architecture.svg). Mermaid sources: `docs/img/*.mmd`.

**In plain words.** A developer writes a Manifest. SEAM reads the live runtime, fingerprints it and locks it, then the compiler builds exact calls from the chain's own metadata and picks a plan mode: `atomic_verified`, `atomic_unverified` (opt-in only), `sequential` (the default), or `unavailable` when the runtime can't do it. A preflight estimates fees and dry-runs, then the policy checks allowed messages, pinned ABI hashes and limits, and the approval hash binds everything together. The user's external wallet signs; SEAM never holds keys. Right before each step is sent, the gate re-checks the approval, the runtime and the signed bytes. After finalization, SEAM checks that the on-chain events match the plan and produces a Receipt. The contract deploy used by the demo is a one-time **unchecked setup step** that sits outside the plan and is not evaluated by policy. The console doesn't talk to a node: it replays recorded runs from `evidence/devnode`.

| Stage | Package |
| --- | --- |
| Manifest | `packages/sdk` (`parseManifest`) |
| Discovery, fingerprint, preflight, signing handoff, submit and track | `packages/chain` |
| Compile and plan modes | `packages/compiler` |
| Policy, approval, runtime lock, submit gate | `packages/policy` |
| Receipt, explanations, `seam` CLI | `packages/sdk` |
| Walkthrough UI | `packages/console` |

## Per-step submit gate

```mermaid
flowchart LR
  IN["Signed step<br/>from wallet"] --> K1["Order + earlier steps ok<br/>step_order, previous_steps_ok"]
  K1 --> K2["Approval valid<br/>unused, in time, intact, matches"]
  K2 --> K3["Runtime unchanged<br/>fresh fingerprint"]
  K3 --> K4["Signed bytes ==<br/>approved calls"]
  K4 --> K5["Signed dry run ok"]
  K5 --> OK["Send"]
  K1 & K2 & K3 & K4 & K5 -. "any fails" .-> NO["Blocked, plain reason<br/>(sequential: run stops, receipt partial)"]
  classDef ok fill:#e3f6e8,stroke:#2e7d32,color:#000;
  classDef no fill:#fde8e8,stroke:#c62828,color:#000;
  class OK ok; class NO no;
```

Gate check codes and block reasons: [reference.md](reference.md#submit-gate-block-reasons). Image: [gate.png](img/gate.png).
