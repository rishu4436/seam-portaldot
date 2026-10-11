// The real SEAM path on the local dev node (LOCAL DEV CHAIN ONLY; //Alice is a public dev seed):
// compile -> [V14 Contracts.call shim] -> preflight -> policy -> approve -> sign (signing requests, //Alice) ->
// assemble -> Seam.execute (per-step: fresh fingerprint + dryRunSigned + checkBeforeSubmit, submitAndWatch,
// events) -> buildReceipt.
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { compile, computePlanDigest, computeManifestDigest } from '@seam/compiler';
import { evaluatePolicy, portaldotPolicy } from '@seam/policy';
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

/** Full run. Returns everything needed for the evidence file. */
export async function runFlow({ facts, manifest, policy, alice, atomic = false, compileOptions = {}, executeRaw }) {
  const statuses = [];
  const adapter = createPortaldotAdapter(ENDPOINT, {
    facts, typesBundle: TYPES_BUNDLE, declaredToken: DECLARED_TOKEN, blockTimeMs: DEV_BLOCK_TIME_MS, submitTimeoutMs: 60_000,
    onStatus: (id, u) => statuses.push({ actionId: id, status: u.status, txHash: u.txHash, blockHash: u.blockHash, at: new Date().toISOString() })
  });
  await adapter.discover(); // re-checks the live node against the given facts
  const seam = new Seam(adapter);
  const compiled = compile(manifest, facts, compileOptions);
  const plan = shimContractsCall(compiled, facts, { atomic });
  const { preflight, envelope } = await adapter.preflight(plan);
  const policyResult = evaluatePolicy({ policy, plan, facts, preflight, manifest });
  const report = {
    endpoint: ENDPOINT, manifestDigest: computeManifestDigest(manifest), compiledMode: compiled.mode, compiledModeReason: compiled.modeReason,
    shimmed: compiled !== plan, plan, preflight, preflightDetail: { nonce: adapter.lastPreflight.nonce, atBlock: adapter.lastPreflight.atBlock, transactions: adapter.lastPreflight.transactions, contractDryRuns: adapter.lastPreflight.contractDryRuns },
    envelope, policy, policyResult
  };
  if (!policyResult.allowed) return { ...report, stage: 'policy', ok: false };
  const approval = seam.approve({ plan, preflight, envelope, policy, policyResult, facts });
  report.approval = approval;
  if (!approval.ok) return { ...report, stage: 'approve', ok: false };

  const signingRequests = [];
  // The user's wallet. TEST ONLY: //Alice on the local dev chain; SEAM itself never holds keys.
  const wallet = adapter.walletFrom(async (payload) => {
    const sig = u8aToHex(alice.sign(hexToU8a(signBytesOf(payload, facts)), { withType: true }));
    signingRequests.push({ payload, signature: sig });
    return { signature: sig };
  });
  const steps = [];
  const run = await (executeRaw ?? ((a) => seam.execute(a)))({
    plan, preflight, envelope, policy, policyResult, facts, approval: approval.approval, wallet,
    onStep: (e) => steps.push({ ...e, at: new Date().toISOString(), dryRun: e.phase === 'sending' || e.phase === 'blocked' ? adapter.lastDryRun : undefined })
  }, { adapter, seam, wallet });
  return {
    ...report, signingRequests, stepLog: steps, statuses, run,
    receiptIntact: run.receipt ? checkReceipt(run.receipt) : undefined,
    lastSubmit: adapter.lastSubmit
  };
}
export { buildReceipt };
