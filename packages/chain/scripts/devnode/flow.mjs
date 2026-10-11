// The real SEAM path on the local dev node (LOCAL DEV CHAIN ONLY; //Alice is a public dev seed):
// compile -> [V14 Contracts.call shim] -> preflight -> policy -> approve -> sign (signing requests, //Alice) ->
// assemble -> Seam.execute (per-step: fresh fingerprint + dryRunSigned + checkBeforeSubmit, submitAndWatch,
// events) -> buildReceipt.
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { compile, computePlanDigest, computeManifestDigest, computeFingerprintDigest } from '@seam/compiler';
import { InMemoryApprovalStore, checkBeforeSubmit, evaluatePolicy, portaldotPolicy, usageKey } from '@seam/policy';
import { Seam, buildReceipt, checkReceipt } from '@seam/sdk';
import { createPortaldotAdapter, signBytesOf } from '../../dist/index.js';
import { ENDPOINT, TYPES_BUNDLE, DECLARED_TOKEN, ASSET_ID, encodeCall } from './lib.mjs';

/** Instant seal makes a block per transaction; metadata has no block time (no Babe). Declared for envelope expiry. */
export const DEV_BLOCK_TIME_MS = 6000;
/** proof_size half of the Weight V2 gas limit; the manifest's gasLimit is the ref_time half. */
export const GAS_PROOF_SIZE = '1000000';

/**
 * WORKAROUND (compiler ARG_BINDINGS as of main 241ac8c): on metadata V14 Contracts.call is
 * call(dest, value, gas_limit: Weight{ref_time, proof_size}, storage_deposit_limit: Option<Compact<u128>>, data)
 * and the compiler marks the step unavailable ("SEAM cannot fill: storageDepositLimit"). This fills the step the
 * way the compiler would need to (gas_limit = {refTime: gasLimit, proofSize: GAS_PROOF_SIZE},
 * storage_deposit_limit = None), re-selects the mode, rebuilds the batch_all, and recomputes the plan digest with
 * the compiler's own computePlanDigest. Every patched step carries decodedArgs.shim so it is visible in receipts' plans.
 * decodedArgs.proofSize uses @seam/policy's name (bot3/policy-file: capped by maxProofSize); storage_deposit_limit
 * None means "no limit", so decodedArgs.storageDepositLimit is left out (the policy only accepts whole numbers there).
 */
export function shimContractsCall(plan, facts, { atomic = false } = {}) {
  const steps = plan.steps.map((s) => {
    if (s.kind !== 'contracts.call' || s.status !== 'unavailable' || !/storageDepositLimit/.test(s.reason ?? '')) return s;
    const cap = facts.capabilities['Contracts.call'];
    const a = s.decodedArgs;
    const encodedCall = encodeCall(facts, 'Contracts', 'call', [
      { Id: a.contractAccountId }, a.value, { refTime: a.gasLimit, proofSize: GAS_PROOF_SIZE }, null, a.data
    ]);
    const { reason: _r, ...rest } = s;
    return {
      ...rest, palletIndex: cap.palletIndex, callIndex: cap.callIndex, encodedCall, status: 'ok',
      decodedArgs: { ...a, proofSize: GAS_PROOF_SIZE, shim: 'devnode V14 Contracts.call shim (compiler cannot fill storage_deposit_limit / Weight V2)' }
    };
  });
  if (steps.some((s) => s.status !== 'ok')) return plan;
  if (steps === plan.steps || steps.every((s, i) => s === plan.steps[i])) return plan;
  const out = { ...plan, steps };
  delete out.outerCall;
  if (atomic) {
    const verified = facts.behaviour.batchAllRollback === 'verified';
    out.mode = verified ? 'atomic_verified' : 'atomic_unverified';
    out.modeReason = `[devnode shim] All steps go in one Utility.batch_all; rollback on failure ${verified ? 'has been verified' : 'has NOT been verified'} on this runtime.`;
    const b = facts.capabilities['Utility.batch_all'];
    out.outerCall = { capability: 'Utility.batch_all', palletIndex: b.palletIndex, callIndex: b.callIndex, encodedCall: encodeCall(facts, 'Utility', 'batch_all', [steps.map((s) => s.encodedCall)]) };
  } else {
    out.mode = 'sequential';
    out.modeReason = '[devnode shim] Steps run one after another; a failure stops later steps.';
  }
  delete out.planDigest;
  return { ...out, planDigest: computePlanDigest(out) };
}

export function devPolicy({ bob, charlie, contract, overrides = {} }) {
  return portaldotPolicy({
    allowedAssets: [String(ASSET_ID)],
    allowedContracts: [contract],
    allowedRecipients: [bob, charlie],
    maxAmountPerAsset: { [String(ASSET_ID)]: '1000000000000' },
    maxNativeValue: '0',
    maxGasLimit: '50000000000',
    allowedModes: ['sequential', 'atomic_verified'],
    ...overrides
  });
}

export function devManifest({ alice, bob, charlie, contract, genesis, atomic = false, actions }) {
  const pref = atomic ? { preferredMode: 'atomic' } : {};
  return {
    version: 1,
    chain: { genesisHash: genesis, specVersion: 100 },
    signer: { type: 'ss58', value: alice },
    actions: actions ?? [
      { id: 'pay', kind: 'assets.transfer', args: { assetId: String(ASSET_ID), amount: '2500', recipient: bob }, ...pref },
      { id: 'call', kind: 'contracts.call', args: { contract, value: '0', gasLimit: '5000000000', data: '0x5345414d' }, ...pref },
      { id: 'mint', kind: 'assets.mint', args: { assetId: String(ASSET_ID), amount: '7', recipient: charlie }, ...pref }
    ]
  };
}

/** Every check checkBeforeSubmit can block on (@seam/policy approval.ts). It reports only failing ones. */
export const GATE_CHECKS = [
  'approval_reused', 'approval_expired', 'approval_tampered', 'approval_mismatch', 'runtime_changed', 'signed_bytes_mismatch',
  'signed_dry_run_failed', 'signed_dry_run_missing', 'send_index_invalid', 'out_of_order', 'previous_steps_missing', 'previous_step_failed'
];

/**
 * Wraps the adapter the SDK talks to, so the exact inputs of each gate check (fresh fingerprint, dry run, clock,
 * outcomes so far) are captured. The SDK's execute() doesn't return passing gate results, so each one is
 * recomputed with checkBeforeSubmit from those same inputs and a store holding the same usage keys, and
 * checked against what the SDK did (sent = ok, blocked = same reasons).
 */
export function gateRecorder(adapter) {
  const rec = { fingerprint: undefined, dry: undefined, outcomes: [], now: undefined, signedCalls: undefined };
  const chain = {
    discover: () => adapter.discover(),
    preflight: (plan) => adapter.preflight(plan),
    async readFingerprint() { rec.fingerprint = await adapter.readFingerprint(); return rec.fingerprint; },
    async dryRunSigned(txs) { const results = await adapter.dryRunSigned(txs); rec.dry = { results, details: adapter.lastDryRun }; return results; },
    async submit(tx, id) { const o = await adapter.submit(tx, id); rec.outcomes.push(o); return o; }
  };
  const now = () => (rec.now = new Date());
  return { rec, chain, now };
}

function gateCheckRecord({ rec, e, ctx, sdkOutcome }) {
  const { plan, preflight, envelope, policy, policyResult, facts, approval } = ctx;
  const atomic = plan.mode === 'atomic_verified' || plan.mode === 'atomic_unverified';
  const n = rec.signedCalls.length;
  const sendIndex = atomic || n === 1 ? (atomic ? undefined : 0) : e.index;
  const signedDryRun = atomic || n === 1 ? rec.dry.results : rec.signedCalls.map((_, j) => (j === e.index ? (rec.dry.results[0] ?? 'unknown') : 'unknown'));
  const previousSteps = atomic ? undefined : buildReceipt({ plan, outcomes: rec.outcomes }).steps.slice(0, e.index);
  const store = new InMemoryApprovalStore();
  for (let j = 0; j < e.index; j++) store.markUsed(usageKey(approval.hash, j));
  const check = checkBeforeSubmit({
    manifestDigest: plan.manifestDigest, plan, envelope, preflight, policy, policyResult, approval,
    preparedFingerprint: facts.fingerprint, currentFingerprint: rec.fingerprint, signedCalls: rec.signedCalls,
    signedDryRun, sendIndex, previousSteps, now: rec.now, store
  });
  const agreesWithSdk = sdkOutcome === 'sent' ? check.ok : !check.ok && (!e.detail || e.detail === check.reasons.map((r) => r.message).join(' '));
  return {
    index: e.index, actionId: e.actionId, sendIndex: sendIndex ?? null, checkedAt: rec.now.toISOString(), sdkOutcome,
    result: check, agreesWithSdk,
    checksPerformed: GATE_CHECKS,
    note: 'checkBeforeSubmit lists only failing checks; ok with no reasons means every check above passed. Recomputed from the exact inputs the SDK used.',
    inputs: {
      preparedFingerprintDigest: facts.fingerprintDigest,
      currentFingerprint: rec.fingerprint,
      currentFingerprintDigest: computeFingerprintDigest(rec.fingerprint),
      runtimeUnchanged: computeFingerprintDigest(rec.fingerprint) === facts.fingerprintDigest,
      signedCalls: rec.signedCalls,
      signedDryRun, dryRunDetails: rec.dry.details,
      previousSteps: previousSteps ?? null,
      policyDigest: policyResult.policyDigest, policyResultAllowed: policyResult.allowed,
      approvalHash: approval.hash, approvalExpiresAt: approval.expiresAt
    }
  };
}

/**
 * Full run. Returns everything needed for the evidence file. Never returns signatures, signed extrinsics or keys.
 * onSigned (optional) receives the signed extrinsics in memory only (the rollback script resends one); not recorded.
 */
export async function runFlow({ facts, manifest, policy, alice, atomic = false, compileOptions = {}, onSigned }) {
  const statuses = [];
  const adapter = createPortaldotAdapter(ENDPOINT, {
    facts, typesBundle: TYPES_BUNDLE, declaredToken: DECLARED_TOKEN, blockTimeMs: DEV_BLOCK_TIME_MS, submitTimeoutMs: 60_000,
    onStatus: (id, u) => statuses.push({ actionId: id, status: u.status, txHash: u.txHash, blockHash: u.blockHash, at: new Date().toISOString() })
  });
  await adapter.discover(); // re-checks the live node against the given facts
  const { rec, chain, now } = gateRecorder(adapter);
  const seam = new Seam(chain);
  const compiled = compile(manifest, facts, compileOptions);
  const plan = shimContractsCall(compiled, facts, { atomic });
  const { preflight, envelope } = await adapter.preflight(plan);
  const policyResult = evaluatePolicy({ policy, plan, facts, preflight, manifest });
  const report = {
    endpoint: ENDPOINT, manifest, manifestDigest: computeManifestDigest(manifest), facts, fingerprint: facts.fingerprint, fingerprintDigest: facts.fingerprintDigest,
    compiledMode: compiled.mode, compiledModeReason: compiled.modeReason,
    shimmed: compiled !== plan, plan, preflight, preflightDetail: { nonce: adapter.lastPreflight.nonce, atBlock: adapter.lastPreflight.atBlock, transactions: adapter.lastPreflight.transactions, contractDryRuns: adapter.lastPreflight.contractDryRuns },
    envelope, policy, policyResult
  };
  if (!policyResult.allowed) return { ...report, stage: 'policy', ok: false };
  const approval = seam.approve({ plan, preflight, envelope, policy, policyResult, facts });
  report.approval = approval;
  if (!approval.ok) return { ...report, stage: 'approve', ok: false };

  // What the wallet was asked to sign (payload and exact sign bytes). Signatures are never recorded.
  const signingRequests = [];
  // The user's wallet. TEST ONLY: //Alice on the local dev chain; SEAM itself never holds keys.
  const inner = adapter.walletFrom(async (payload) => {
    signingRequests.push({ payload, signBytesHex: signBytesOf(payload, facts) });
    return { signature: u8aToHex(alice.sign(hexToU8a(signBytesOf(payload, facts)), { withType: true })) };
  });
  const wallet = { async sign(calls, env) { const out = await inner.sign(calls, env); rec.signedCalls = out.map((o) => o.signedCall); onSigned?.(out.map((o) => o.signedTx)); return out; } };
  const ctx = { plan, preflight, envelope, policy, policyResult, facts, approval: approval.approval };
  const steps = [];
  const gateChecks = [];
  const run = await seam.execute({
    ...ctx, wallet, now,
    onStep: (e) => {
      steps.push({ ...e, at: new Date().toISOString(), dryRun: e.phase === 'sending' || e.phase === 'blocked' ? rec.dry?.details : undefined });
      if (e.phase === 'sending' || e.phase === 'blocked') gateChecks.push(gateCheckRecord({ rec, e, ctx, sdkOutcome: e.phase === 'sending' ? 'sent' : 'blocked' }));
    }
  });
  // Blocked at the first check: execute() returns before onStep('blocked') for atomic/first steps.
  if (!run.ok && run.stage === 'submit_gate' && !gateChecks.some((g) => g.sdkOutcome === 'blocked')) {
    gateChecks.push(gateCheckRecord({ rec, e: { index: 0, actionId: atomic ? 'batch' : plan.steps[0].actionId, detail: run.reason }, ctx, sdkOutcome: 'blocked' }));
  }
  const last = adapter.lastSubmit;
  return {
    ...report, signingRequests, gateChecks, stepLog: steps, statuses, run,
    receiptIntact: run.receipt ? checkReceipt(run.receipt) : undefined,
    lastSubmit: last ? { txHash: last.txHash, status: last.status, history: last.history, timedOut: last.timedOut, error: last.error, inclusion: last.inclusion } : undefined,
    signedForSubmission: rec.signedCalls ? rec.signedCalls.length : 0
  };
}
export { buildReceipt };
