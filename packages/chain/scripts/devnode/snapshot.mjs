// Snapshot the local dev node (read-only) into $SEAM_EVIDENCE_DIR (default /workspace/seam-evidence/devnode).
import { snapshotFromNode, metadataVersionOf } from '../../dist/index.js';
import { ENDPOINT, EVIDENCE, TYPES_BUNDLE, DECLARED_TOKEN, devFacts, saveJson } from './lib.mjs';

const files = await snapshotFromNode(ENDPOINT, EVIDENCE, { typesBundle: TYPES_BUNDLE, declaredToken: DECLARED_TOKEN });
const facts = await devFacts();
saveJson(`${EVIDENCE}/devnode-facts-summary.json`, {
  fingerprint: facts.fingerprint,
  fingerprintDigest: facts.fingerprintDigest,
  metadataVersion: metadataVersionOf(facts.source.metadataHex),
  behaviour: facts.behaviour,
  capabilities: Object.fromEntries(['Assets.create', 'Assets.mint', 'Assets.transfer_keep_alive', 'Contracts.call', 'Contracts.instantiate_with_code', 'Revive.call', 'Utility.batch_all', 'Nfts.mint'].map((k) => [k, facts.capabilities[k]])),
  pallets: Object.keys(facts.capabilities).map((k) => k.split('.')[0]).filter((v, i, a) => a.indexOf(v) === i)
});
console.log(files.metadataPath, files.snapshotPath, files.snapshot.fingerprintDigest);
