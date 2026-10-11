// batch_all rollback on the local dev node: step 2 of 3 fails inside Utility.batch_all.
// 1) SEAM's own path, fully recorded (compile, preflight, signing envelope, policy rule by rule, approval, signing
//    requests, gate check): the signed batch_all's dry run fails, so the submit gate blocks it (nothing sent).
// 2) To see what the chain itself does, the SAME signed extrinsic is then submitted directly (test-only bypass,
//    local dev chain only); its status history, events and before/after balances are recorded.
//    The signed extrinsic is held in memory only; it is never written to evidence.
import { hexToU8a } from '@polkadot/util';
import { decodeRuntime, storageKey, submitAndWatch, withClient } from '../../dist/index.js';
import { ENDPOINT, ASSET_ID, devFacts, devKeys, saveEvidence, brief } from './lib.mjs';
import { devManifest, devPolicy, runFlow } from './flow.mjs';

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
    const head = await c.send('chain_getHeader', []);
    return {
      block: parseInt(head.number, 16),
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

const before = await snapshotState();
let signed; // in memory only
const seam = await runFlow({ facts, manifest, policy, alice: k.alice, atomic: true, compileOptions: { allowAtomicUnverified: true }, onSigned: (txs) => { signed = txs; } });
const afterGate = await snapshotState();
if (seam.run?.ok !== false || seam.run.stage !== 'submit_gate') throw new Error(`expected SEAM's gate to block, got ${JSON.stringify(seam.run ?? seam.stage)}`);

// Test-only bypass (local dev chain): send the exact signed batch_all the gate refused, to observe the chain's rollback.
const directStatuses = [];
const direct = await submitAndWatch(ENDPOINT, signed[0], (u) => directStatuses.push({ status: u.status, txHash: u.txHash, blockHash: u.blockHash, at: new Date().toISOString() }), { facts, timeoutMs: 60_000 });
signed = undefined;
const after = await snapshotState();
const ev = direct.inclusion?.events ?? [];
const innerEffects = ev.filter((e) => (e.pallet === 'Assets' && ['Transferred', 'Issued'].includes(e.name)) || (e.pallet === 'Utility' && e.name !== 'BatchInterrupted'));
const rolledBack = direct.inclusion?.success === false && innerEffects.length === 0
  && JSON.stringify(after.asset) === JSON.stringify(before.asset);
const gate = seam.gateChecks.find((g) => g.sdkOutcome === 'blocked');
const result = {
  kind: 'batch_all-rollback', recordingVersion: 2, ranAt: new Date().toISOString(),
  ...seam,
  planMode: seam.plan.mode,
  steps: seam.plan.steps.map((s) => ({ actionId: s.actionId, call: s.encodedCall, args: s.decodedArgs })), outerCall: seam.plan.outerCall,
  approvalHash: seam.approval?.approval?.hash,
  seamGate: { stage: seam.run.stage, ok: seam.run.ok, reason: seam.run.reason, reasons: gate?.result.reasons ?? seam.run.check?.reasons, dryRun: gate?.inputs.dryRunDetails, nothingSent: afterGate.aliceNonce === before.aliceNonce },
  directSubmit: { note: 'test-only bypass of the gate, local dev chain; the same signed bytes the gate refused', statuses: directStatuses, decodedEvents: direct.inclusion?.events, ...brief(direct) },
  state: { before, afterGate, after },
  innerEffects: innerEffects.map((e) => `${e.pallet}.${e.name}`),
  conclusion: rolledBack
    ? 'ROLLED BACK: batch_all failed as a whole (ExtrinsicFailed, the inner error from step 2); step 1\'s transfer and step 3\'s mint left no events and no balance change. Only the fee was charged (nonce advanced).'
    : 'NOT ROLLED BACK (or inconclusive): see state and events',
  batchAllRollback: rolledBack ? 'verified' : 'unknown'
};
const file = saveEvidence(`runs/rollback-${Date.now()}.json`, result);
console.log(file);
console.log(JSON.stringify({ seamGate: result.seamGate, direct: { ...result.directSubmit, decodedEvents: undefined }, state: result.state, conclusion: result.conclusion }, null, 1));
