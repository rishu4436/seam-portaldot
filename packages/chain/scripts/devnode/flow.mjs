// The real SEAM path on the local dev node (LOCAL DEV CHAIN ONLY; //Alice is a public dev seed):
// compile (contract step by message name + ABI) -> preflight -> policy -> approve -> sign (signing requests, //Alice) ->
// assemble -> Seam.execute (per-step: fresh fingerprint + dryRunSigned + checkBeforeSubmit, submitAndWatch,
// events) -> buildReceipt.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bnToU8a, hexToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";
import { compile, computeManifestDigest, computeAbiHash } from "@seam/compiler";
import { evaluatePolicy, portaldotPolicy } from "@seam/policy";
import { Seam, buildReceipt, checkReceipt } from "@seam/sdk";
import { createPortaldotAdapter, signBytesOf } from "../../dist/index.js";
import { ENDPOINT, TYPES_BUNDLE, DECLARED_TOKEN, ASSET_ID, encodeCall } from "./lib.mjs";

/** Instant seal makes a block per transaction; metadata has no block time (no Babe). Declared for envelope expiry. */
export const DEV_BLOCK_TIME_MS = 6000;
/** proof_size half of the Weight V2 gas limit; the manifest's gasLimit is the ref_time half. */
export const GAS_PROOF_SIZE = "1000000";

/** Weight V2 contract-call limits used by the demo flows (manifest values; the compiler binds them on V14). */
export const SETTLE = { orderId: 7, amount: "2500" };
/** Bot 2's ink! ABI (metadata.json) by reference, so the manifest stays small and the plan pins it by hash. */
export const ABIS = {
  seam_demo: JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../../contracts/seam-demo/artifacts/metadata.json", import.meta.url),
      ),
      "utf8",
    ),
  ),
};

/**
 * What the `settle` step must have done, committed before the run (SEAM-004: a bare ContractEmitted proves nothing).
 * The exact `data` of seam_demo's Settled event, SCALE-encoded in ABI field order from the manifest's own values:
 * caller (AccountId, the signer), order_id (u64 LE), amount (Balance = u128 LE). Not read from the chain.
 */
export function settleEffect(caller, { orderId = SETTLE.orderId, amount = SETTLE.amount } = {}) {
  const abi = ABIS.seam_demo;
  const ev = abi.spec.events.find((e) => e.label === "Settled");
  const def = (id) => abi.types.find((t) => t.id === id)?.type.def;
  const shape = (id) => {
    const d = def(id);
    if (d?.primitive) return d.primitive;
    const f = d?.composite?.fields;
    const inner = f?.length === 1 ? def(f[0].type)?.array : undefined;
    return inner?.len === 32 && def(inner.type)?.primitive === "u8" ? "[u8;32]" : JSON.stringify(d);
  };
  const layout = ev?.args.map((a) => `${a.label}:${shape(a.type.type)}`).join(",");
  if (layout !== "caller:[u8;32],order_id:u64,amount:u128")
    throw new Error(`seam_demo Settled event layout changed (${layout}); update settleEffect`);
  return {
    emittedData: u8aToHex(
      u8aConcat(
        decodeAddress(caller),
        bnToU8a(BigInt(orderId), { bitLength: 64, isLe: true }),
        bnToU8a(BigInt(amount), { bitLength: 128, isLe: true }),
      ),
    ),
  };
}

/**
 * The batch run-rollback.mjs sends to observe Utility.batch_all rollback: the same kinds as devManifest (transfer,
 * seam_demo settle, mint) all succeed inside the batch, then a last transfer overdraws and fails it. The rollback
 * proof's composition is these kinds, so it covers every kind of the atomic demo plan (SEAM-012).
 */
/** Largest u128: minting it on top of any non-zero supply overflows. */
export const U128_MAX = ((1n << 128n) - 1n).toString();

export function rollbackActions({
  bob,
  charlie,
  contract,
  callData,
  assetId = ASSET_ID,
  gas = { gasLimit: "5000000000", proofSize: GAS_PROOF_SIZE },
}) {
  const atomic = { preferredMode: "atomic" };
  return [
    {
      id: "pay",
      kind: "assets.transfer",
      args: { assetId: String(assetId), amount: "5", recipient: bob },
      ...atomic,
    },
    { ...contractCallAction({ contract, gas, callData }), ...atomic },
    {
      id: "mint",
      kind: "assets.mint",
      args: { assetId: String(assetId), amount: "3", recipient: charlie },
      ...atomic,
    },
    {
      // Fails on chain inside batch_all on a state check preflight cannot see: Assets.mint adds to the asset's
      // supply with checked_add, and u128::MAX on top of the supply (which step 3 just raised) overflows
      // (Arithmetic(Overflow)). Preflight only checks that the asset exists for mints and the signer's own running
      // balance for transfers, so the plan passes preflight and policy and only the signed dry run sees it.
      id: "overflow",
      kind: "assets.mint",
      args: { assetId: String(assetId), amount: U128_MAX, recipient: charlie },
      ...atomic,
    },
  ];
}

/** Interface hash of the seam_demo ABI. The policy pins it independently of the manifest. */
export const SEAM_DEMO_ABI_HASH = computeAbiHash(ABIS.seam_demo);

/** `demo: false` (rollback flow, no contract step) leaves out the seam_demo message and ABI rules. No maxStorageDeposit: the step sets storageDepositLimit: null. */
export function devPolicy({
  bob,
  charlie,
  contract,
  demo = true,
  rawSelector,
  assetId = ASSET_ID,
  overrides = {},
}) {
  return portaldotPolicy({
    allowedAssets: [String(assetId)],
    allowedContracts: [contract],
    allowedSelectors: demo
      ? { [contract]: ["0x6c337222"] }
      : rawSelector
        ? { [contract]: [rawSelector] }
        : undefined,
    allowedMessages: demo ? { [contract]: ["settle"] } : undefined,
    pinnedAbiHashes: demo ? { [contract]: SEAM_DEMO_ABI_HASH } : undefined,
    allowedRecipients: [bob, charlie],
    maxAmountPerAsset: { [String(assetId)]: "1000000000000" },
    maxNativeValue: "0",
    maxGasLimit: "50000000000",
    allowedModes: ["sequential", "atomic_verified"],
    ...overrides,
  });
}

/** The demo contracts.call action (seam_demo settle by ABI, or raw `callData` where the ABI path cannot serve). */
export function contractCallAction({
  contract,
  callData,
  gas = { gasLimit: "5000000000", proofSize: GAS_PROOF_SIZE },
}) {
  return {
    id: "call",
    kind: "contracts.call",
    args: callData
      ? {
          contract,
          value: "0",
          gasLimit: gas.gasLimit,
          ...(gas.proofSize !== undefined ? { proofSize: gas.proofSize } : {}),
          ...(gas.v13 ? {} : { storageDepositLimit: null }),
          data: callData,
        } // raw data: runtimes the ink! ABI path cannot serve
      : {
          contract,
          value: "0",
          gasLimit: gas.gasLimit,
          ...(gas.proofSize !== undefined ? { proofSize: gas.proofSize } : {}),
          ...(gas.v13 ? {} : { storageDepositLimit: null }),
          message: "settle",
          args: { order_id: SETTLE.orderId, amount: SETTLE.amount },
          abiRef: "seam_demo",
        },
  };
}

export function devManifest({
  alice,
  bob,
  charlie,
  contract,
  genesis,
  atomic = false,
  actions,
  callData,
  assetId = ASSET_ID,
  gas = { gasLimit: "5000000000", proofSize: GAS_PROOF_SIZE },
  specVersion = 100,
}) {
  const pref = atomic ? { preferredMode: "atomic" } : {};
  return {
    version: 1,
    chain: { genesisHash: genesis, specVersion },
    signer: { type: "ss58", value: alice },
    actions: actions ?? [
      {
        id: "pay",
        kind: "assets.transfer",
        args: { assetId: String(assetId), amount: "2500", recipient: bob },
        ...pref,
      },
      { ...contractCallAction({ contract, gas, callData }), ...pref },
      {
        id: "mint",
        kind: "assets.mint",
        args: { assetId: String(assetId), amount: "7", recipient: charlie },
        ...pref,
      },
    ],
  };
}

/**
 * Full run. Returns everything needed for the evidence file. Never returns signatures, signed extrinsics or keys.
 * effects (optional): per actionId, what a contracts.call must have done (see settleEffect); without it the SDK
 * cannot verify a contract step and a sequential run stops after it.
 * onSigned (optional) receives the signed extrinsics in memory only (the rollback script resends one); not recorded.
 */
export async function runFlow({
  facts,
  manifest,
  policy,
  alice,
  signPayload,
  env = {},
  atomic = false,
  compileOptions = {},
  onSigned,
  effects,
}) {
  // env overrides the dev-node defaults (testnet-run.mjs). signPayload(payload) -> { signature } is any external signer.
  const endpoint = env.endpoint ?? ENDPOINT;
  const statuses = [];
  const adapter = createPortaldotAdapter(endpoint, {
    facts,
    typesBundle: env.typesBundle ?? TYPES_BUNDLE,
    declaredToken: env.declaredToken ?? DECLARED_TOKEN,
    blockTimeMs: env.blockTimeMs ?? DEV_BLOCK_TIME_MS,
    submitTimeoutMs: 60_000,
    onStatus: (id, u) =>
      statuses.push({
        actionId: id,
        status: u.status,
        txHash: u.txHash,
        blockHash: u.blockHash,
        at: new Date().toISOString(),
      }),
  });
  await adapter.discover(); // re-checks the live node against the given facts
  const seam = new Seam(adapter);
  const compiled = compile(manifest, facts, { abis: env.abis ?? ABIS, ...compileOptions });
  const plan = compiled;
  const { preflight, envelope } = await adapter.preflight(plan);
  const policyResult = evaluatePolicy({ policy, plan, facts, preflight, manifest });
  const report = {
    endpoint,
    manifest,
    manifestDigest: computeManifestDigest(manifest),
    facts,
    fingerprint: facts.fingerprint,
    fingerprintDigest: facts.fingerprintDigest,
    compiledMode: compiled.mode,
    compiledModeReason: compiled.modeReason,
    plan,
    preflight,
    preflightDetail: {
      nonce: adapter.lastPreflight.nonce,
      atBlock: adapter.lastPreflight.atBlock,
      transactions: adapter.lastPreflight.transactions,
      contractDryRuns: adapter.lastPreflight.contractDryRuns,
    },
    envelope,
    policy,
    policyResult,
  };
  if (!policyResult.allowed) return { ...report, stage: "policy", ok: false };
  const approval = seam.approve({ plan, preflight, envelope, policy, policyResult, facts });
  report.approval = approval;
  if (!approval.ok) return { ...report, stage: "approve", ok: false };

  // What the wallet was asked to sign (payload and exact sign bytes). Signatures are never recorded.
  const signingRequests = [];
  // The user's wallet. TEST ONLY: //Alice on the local dev chain; SEAM itself never holds keys.
  const inner = adapter.walletFrom(async (payload) => {
    signingRequests.push({ payload, signBytesHex: signBytesOf(payload, facts) });
    if (signPayload) return signPayload(payload);
    return {
      signature: u8aToHex(alice.sign(hexToU8a(signBytesOf(payload, facts)), { withType: true })),
    };
  });
  let signedCount = 0;
  const wallet = {
    async sign(calls, env) {
      const out = await inner.sign(calls, env);
      signedCount = out.length;
      onSigned?.(out.map((o) => o.signedTx));
      return out;
    },
  };
  const ctx = {
    plan,
    preflight,
    envelope,
    policy,
    policyResult,
    facts,
    approval: approval.approval,
  };
  const steps = [];
  // Gate results come straight from the SDK: onStep carries SubmitCheck (ok, reasons, passed) on sending, done and blocked.
  const gateChecks = [];
  const run = await seam.execute({
    ...ctx,
    wallet,
    ...(effects ? { effects } : {}),
    onStep: (e) => {
      const at = new Date().toISOString();
      steps.push({ index: e.index, actionId: e.actionId, phase: e.phase, detail: e.detail, at });
      if (e.check)
        gateChecks.push({
          index: e.index,
          actionId: e.actionId,
          phase: e.phase,
          at,
          check: e.check,
          dryRun: e.phase !== "done" ? adapter.lastDryRun : undefined,
        });
    },
  });
  // Atomic and first-step refusals return before any onStep with a check; the result carries the same SubmitCheck.
  if (
    !run.ok &&
    run.stage === "submit_gate" &&
    run.check &&
    !gateChecks.some((g) => g.phase === "blocked")
  ) {
    gateChecks.push({
      index: 0,
      actionId: atomic ? "batch" : plan.steps[0].actionId,
      phase: "blocked",
      at: new Date().toISOString(),
      check: run.check,
      dryRun: adapter.lastDryRun,
      source: "run.check",
    });
  }
  const last = adapter.lastSubmit;
  return {
    ...report,
    signingRequests,
    gateChecks,
    stepLog: steps,
    statuses,
    run,
    receiptIntact: run.receipt ? checkReceipt(run.receipt) : undefined,
    lastSubmit: last
      ? {
          txHash: last.txHash,
          status: last.status,
          history: last.history,
          timedOut: last.timedOut,
          error: last.error,
          inclusion: last.inclusion,
        }
      : undefined,
    signedForSubmission: signedCount,
  };
}
export { buildReceipt };
