// Real atomic SEAM run on the local dev node: one Utility.batch_all [transfer, contract call, mint].
// batchAllRollback is 'verified' only because run-rollback.mjs showed the rollback on this runtime (pass its file).
import { readFileSync } from 'node:fs';
import { devFacts, devKeys, loadState, saveEvidence } from './lib.mjs';
import { devManifest, devPolicy, runFlow } from './flow.mjs';

const evidenceFile = process.argv[2];
const evidence = evidenceFile ? JSON.parse(readFileSync(evidenceFile, 'utf8')) : undefined;
if (evidence?.kind !== 'batch_all-rollback' || evidence.batchAllRollback !== 'verified') throw new Error('pass a rollback evidence file that shows batchAllRollback verified');
const facts = await devFacts('verified');
const k = await devKeys();
const st = loadState();
const manifest = devManifest({ alice: k.alice.address, bob: k.bob.address, charlie: k.charlie.address, contract: st.contract, genesis: facts.fingerprint.genesisHash, atomic: true });
const policy = devPolicy({ bob: k.bob.address, charlie: k.charlie.address, contract: st.contract });
const out = await runFlow({ facts, manifest, policy, alice: k.alice, atomic: true });
const file = saveEvidence(`runs/atomic-${Date.now()}.json`, { kind: 'atomic', recordingVersion: 2, ranAt: new Date().toISOString(), rollbackEvidence: `runs/${evidenceFile.split('/').pop()}`, requireSignedDryRun: policy.requireSignedDryRun, ...out });
const r = out.run?.receipt;
console.log(file, out.plan.mode, out.stage ?? '', out.approval?.reason ?? '');
if (r) console.log(r.result, JSON.stringify(r.steps.map((s) => [s.actionId, s.status, s.verification, s.txHash, s.block?.number, s.reason]), null, 1));
else console.log(JSON.stringify(out.run ?? out.policyResult.rules.filter((x) => x.outcome !== 'pass'), null, 1)?.slice(0, 3000));
