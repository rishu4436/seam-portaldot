// batch_all rollback on the local dev node: step 2 of 3 fails inside Utility.batch_all.
// 1) SEAM's own path: the signed batch_all's dry run fails, so the submit gate blocks it (nothing sent).
// 2) To see what the chain itself does, the SAME signed extrinsic is then submitted directly (test-only bypass,
//    local dev chain only) and balances/events are compared before and after.
import { compile } from '@seam/compiler';
import { evaluatePolicy } from '@seam/policy';
import { Seam } from '@seam/sdk';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { createPortaldotAdapter, decodeRuntime, storageKey, submitAndWatch, withClient, signBytesOf } from '../../dist/index.js';
import { ENDPOINT, EVIDENCE, TYPES_BUNDLE, DECLARED_TOKEN, ASSET_ID, devFacts, devKeys, saveJson, brief } from './lib.mjs';
import { DEV_BLOCK_TIME_MS, devManifest, devPolicy } from './flow.mjs';

const facts = await devFacts(); // batchAllRollback: 'unknown' (not verified yet)
const k = await devKeys();
const dec = decodeRuntime(facts);
const q = dec.decorated().query;

async function snapshotState() {
  return withClient(ENDPOINT, async (c) => {
    const bal = async (who) => {
      const v = await c.send('state_getStorage', [storageKey(q.assets.account, ASSET_ID, who)]);
      if (!v) return '0';
      const t = dec.registry.lookup.getTypeDef(q.assets.account.meta.type.asMap.value).type;
      return dec.registry.createType(t, hexToU8a(v)).toJSON().balance.toString();
    };
    const supply = await c.send('state_getStorage', [storageKey(q.assets.asset, ASSET_ID)]);
    const t = dec.registry.lookup.getTypeDef(q.assets.asset.meta.type.asMap.value).type;
    return {
      block: await c.send('chain_getHeader', []).then((h) => parseInt(h.number, 16)),
      aliceNonce: await c.send('system_accountNextIndex', [k.alice.address]),
      asset: { alice: await bal(k.alice.address), bob: await bal(k.bob.address), charlie: await bal(k.charlie.address), supply: dec.registry.createType(t, hexToU8a(supply)).toJSON().supply.toString() }
    };
  });
}

const manifest = devManifest({
  alice: k.alice.address, bob: k.bob.address, charlie: k.charlie.address, contract: '', genesis: facts.fingerprint.genesisHash,
  actions: [
    { id: 'pay', kind: 'assets.transfer', args: { assetId: String(ASSET_ID), amount: '5', recipient: k.bob.address }, preferredMode: 'atomic' },
    { id: 'overdraw', kind: 'assets.transfer', args: { assetId: String(ASSET_ID), amount: '900000000000000', recipient: k.bob.address }, preferredMode: 'atomic' },
    { id: 'mint', kind: 'assets.mint', args: { assetId: String(ASSET_ID), amount: '3', recipient: k.charlie.address }, preferredMode: 'atomic' }
  ]
});
const policy = devPolicy({ bob: k.bob.address, charlie: k.charlie.address, contract: k.bob.address, overrides: {
  allowedModes: ['sequential', 'atomic_verified', 'atomic_unverified'], maxAmountPerAsset: { [String(ASSET_ID)]: '1000000000000000' }
} });
const adapter = createPortaldotAdapter(ENDPOINT, { facts, typesBundle: TYPES_BUNDLE, declaredToken: DECLARED_TOKEN, blockTimeMs: DEV_BLOCK_TIME_MS, submitTimeoutMs: 60_000 });
const seam = new Seam(adapter);
const plan = compile(manifest, facts, { allowAtomicUnverified: true });
const { preflight, envelope } = await adapter.preflight(plan);
const policyResult = evaluatePolicy({ policy, plan, facts, preflight, manifest });
const approval = seam.approve({ plan, preflight, envelope, policy, policyResult, facts });
if (!approval.ok) throw new Error(approval.reason + JSON.stringify(policyResult.rules.filter((r) => r.outcome !== 'pass')));
let signedTx;
const wallet = adapter.walletFrom(async (payload) => ({ signature: u8aToHex(k.alice.sign(hexToU8a(signBytesOf(payload, facts)), { withType: true })) }));
const capture = { sign: async (calls, env) => { const s = await wallet.sign(calls, env); signedTx = s[0].signedTx; return s; } };

const before = await snapshotState();
const gated = await seam.execute({ plan, preflight, envelope, policy, policyResult, facts, approval: approval.approval, wallet: capture });
const gateDryRun = adapter.lastDryRun;
const afterGate = await snapshotState();

// Test-only bypass (local dev chain): send the exact signed batch_all the gate refused, to observe the chain's rollback.
const direct = await submitAndWatch(ENDPOINT, signedTx, undefined, { facts, timeoutMs: 60_000 });
const after = await snapshotState();
const ev = direct.inclusion?.events ?? [];
const innerEffects = ev.filter((e) => (e.pallet === 'Assets' && ['Transferred', 'Issued'].includes(e.name)) || (e.pallet === 'Utility' && e.name !== 'BatchInterrupted'));
const rolledBack = direct.inclusion?.success === false && innerEffects.length === 0
  && after.asset.bob === before.asset.bob && after.asset.charlie === before.asset.charlie && after.asset.supply === before.asset.supply
  && after.asset.alice === before.asset.alice;
const result = {
  kind: 'batch_all-rollback', ranAt: new Date().toISOString(), fingerprintDigest: facts.fingerprintDigest, planMode: plan.mode,
  steps: plan.steps.map((s) => ({ actionId: s.actionId, call: s.encodedCall, args: s.decodedArgs })), outerCall: plan.outerCall,
  policyResult: { allowed: policyResult.allowed }, approvalHash: approval.approval.hash,
  seamGate: { stage: gated.stage, ok: gated.ok, reasons: gated.check?.reasons, dryRun: gateDryRun, nothingSent: afterGate.aliceNonce === before.aliceNonce },
  directSubmit: { note: 'test-only bypass of the gate, local dev chain', ...brief(direct) },
  state: { before, afterGate, after },
  innerEffects: innerEffects.map((e) => `${e.pallet}.${e.name}`),
  conclusion: rolledBack
    ? 'ROLLED BACK: batch_all failed as a whole (ExtrinsicFailed, the inner error from step 2); step 1\'s transfer and step 3\'s mint left no events and no balance change. Only the fee was charged (nonce advanced).'
    : 'NOT ROLLED BACK (or inconclusive): see state and events',
  batchAllRollback: rolledBack ? 'verified' : 'unknown'
};
const file = `${EVIDENCE}/runs/rollback-${Date.now()}.json`;
saveJson(file, result);
console.log(file);
console.log(JSON.stringify({ seamGate: result.seamGate, direct: result.directSubmit, state: result.state, conclusion: result.conclusion }, null, 1));
