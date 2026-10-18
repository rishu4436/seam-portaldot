// The real SEAM path on the local dev node (LOCAL DEV CHAIN ONLY; //Alice is a public dev seed):
// compile (contract step by message name + ABI) -> preflight -> policy -> approve -> sign (signing requests, //Alice) ->
// assemble -> Seam.execute (per-step: fresh fingerprint + dryRunSigned + checkBeforeSubmit, submitAndWatch,
// events) -> buildReceipt.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { compile, computeManifestDigest, computeFingerprintDigest } from '@seam/compiler';
import { InMemoryApprovalStore, checkBeforeSubmit, evaluatePolicy, portaldotPolicy, usageKey } from '@seam/policy';
import { Seam, buildReceipt, checkReceipt } from '@seam/sdk';
import { createPortaldotAdapter, signBytesOf } from '../../dist/index.js';
import { ENDPOINT, TYPES_BUNDLE, DECLARED_TOKEN, ASSET_ID, encodeCall } from './lib.mjs';

/** Instant seal makes a block per transaction; metadata has no block time (no Babe). Declared for envelope expiry. */
export const DEV_BLOCK_TIME_MS = 6000;
/** proof_size half of the Weight V2 gas limit; the manifest's gasLimit is the ref_time half. */
export const GAS_PROOF_SIZE = '1000000';

/** Weight V2 contract-call limits used by the demo flows (manifest values; the compiler binds them on V14). */
export const SETTLE = { orderId: 7, amount: '2500' };
/** Bot 2's ink! ABI (metadata.json) by reference, so the manifest stays small and the plan pins it by hash. */
export const ABIS = { seam_demo: JSON.parse(readFileSync(fileURLToPath(new URL('../../../../contracts/seam-demo/artifacts/metadata.json', import.meta.url)), 'utf8')) };

export function devPolicy({ bob, charlie, contract, overrides = {} }) {
  return portaldotPolicy({
    allowedAssets: [String(ASSET_ID)],
    allowedContracts: [contract],
    allowedSelectors: contract ? { [contract]: ['0x6c337222'] } : undefined,
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
      { id: 'call', kind: 'contracts.call', args: { contract, value: '0', gasLimit: '5000000000', proofSize: GAS_PROOF_SIZE, storageDepositLimit: null, message: 'settle', args: { order_id: SETTLE.orderId, amount: SETTLE.amount }, abiRef: 'seam_demo' }, ...pref },
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
  const compiled = compile(manifest, facts, { abis: ABIS, ...compileOptions });
  const plan = compiled;
  const { preflight, envelope } = await adapter.preflight(plan);
  const policyResult = evaluatePolicy({ policy, plan, facts, preflight, manifest });
  const report = {
    endpoint: ENDPOINT, manifest, manifestDigest: computeManifestDigest(manifest), facts, fingerprint: facts.fingerprint, fingerprintDigest: facts.fingerprintDigest,
    compiledMode: compiled.mode, compiledModeReason: compiled.modeReason,
    plan, preflight, preflightDetail: { nonce: adapter.lastPreflight.nonce, atBlock: adapter.lastPreflight.atBlock, transactions: adapter.lastPreflight.transactions, contractDryRuns: adapter.lastPreflight.contractDryRuns },
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
