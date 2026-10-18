// Builds src/demo/devnode.json from Bot 4's REAL runs on the local
// substrate-contracts-node (ws://127.0.0.1:9944), committed in this repo under
// evidence/devnode/ (see evidence/README.md). Nothing here is simulated: every
// Manifest, fact, policy, rule result, hash, block, event, fee and digest is
// copied from the run files. The script only trims them for the console and
// re-checks the digests with the real @seam/compiler and @seam/sdk.
// Not copied: signatures (none are recorded), sign bytes, raw metadata.
//
// usage: node scripts/import-devnode.mjs [evidenceDir]
//   default evidenceDir is <repo>/evidence/devnode. Picks the newest run of each
//   kind that has recordingVersion >= 2 (full Manifest, facts, policy, gate checks).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { computeManifestDigest, computePlanDigest } from '@seam/compiler';
import { checkReceipt, explainPlan, explainPolicy, explainReceipt } from '@seam/sdk';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DIR = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(REPO, 'evidence/devnode');
const RUNS = join(DIR, 'runs');
const repoPath = (p) => relative(REPO, p) || p;
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const files = readdirSync(RUNS).filter((f) => f.endsWith('.json')).sort();
const pick = (prefix) => {
  const all = files.filter((f) => f.startsWith(prefix + '-')).map((f) => ({ f, d: read(join(RUNS, f)) })).filter((x) => (x.d.recordingVersion ?? 0) >= 2);
  if (!all.length) throw new Error(`no ${prefix}-*.json with recordingVersion >= 2 in ${RUNS}`);
  const last = all.at(-1);
  return { file: last.f, run: last.d, count: all.length };
};

const factsSummary = read(join(DIR, 'devnode-facts-summary.json'));
const snapshot = read(join(DIR, 'substrate-contracts-node-spec100-snapshot.json'));
const seq = pick('sequential'), ato = pick('atomic'), rb = pick('rollback');
// The first setup file holds the create/mint/deploy transactions; later ones just say "already exists".
const setupFile = files.filter((f) => f.startsWith('setup-')).map((f) => ({ f, d: read(join(RUNS, f)) })).find((x) => x.d.steps.some((s) => s.txHash));

const checks = [];
const check = (what, ok, detail = '') => { checks.push({ what, ok, detail }); if (!ok) console.warn('CHECK FAILED:', what, detail); };
const safe = (f, ...a) => { try { return f(...a); } catch { return undefined; } };

const stripStep = (s) => ({ index: s.index, actionId: s.actionId, phase: s.phase, detail: s.detail, at: s.at, dryRun: s.dryRun?.map((d) => ({ txHash: d.txHash, outcome: d.outcome, detail: d.detail })) });
const stripGate = (g) => ({
  index: g.index, actionId: g.actionId, sendIndex: g.sendIndex, checkedAt: g.checkedAt, sdkOutcome: g.sdkOutcome, result: g.result, agreesWithSdk: g.agreesWithSdk,
  checksPerformed: g.checksPerformed, note: g.note,
  inputs: { preparedFingerprintDigest: g.inputs?.preparedFingerprintDigest, currentFingerprintDigest: g.inputs?.currentFingerprintDigest, runtimeUnchanged: g.inputs?.runtimeUnchanged, signedDryRun: g.inputs?.signedDryRun, dryRunDetails: g.inputs?.dryRunDetails?.map((d) => ({ txHash: d.txHash, outcome: d.outcome, detail: d.detail })), previousSteps: g.inputs?.previousSteps?.map((p) => ({ actionId: p.actionId, status: p.status, block: p.block?.number })) },
});
const usedProofOf = (receipt) => Object.fromEntries((receipt?.steps ?? []).map((s) => {
  const ev = (s.events ?? []).find((e) => e.startsWith('System.ExtrinsicSuccess('));
  const m = ev && /"proofSize":(\d+)/.exec(ev);
  return [s.actionId, m ? { value: m[1], txHash: s.txHash } : null];
}));

function common(id, { file, run, count }) {
  const md = computeManifestDigest(run.manifest);
  check(`${id}: saved Manifest hashes to the recorded digest`, md === run.manifestDigest, `${md} vs ${run.manifestDigest}`);
  const { planDigest, ...planBody } = run.plan;
  const pd = safe(computePlanDigest, planBody);
  check(`${id}: plan digest recomputes`, pd === planDigest, `${pd} vs ${planDigest}`);
  const req = run.signingRequests?.[0]?.payload ?? {};
  const { source: _s, ...factsRest } = run.facts; // source holds the raw metadata hex and types bundle
  const facts = { ...factsRest, capabilities: Object.fromEntries(Object.entries(factsRest.capabilities).map(([k, c]) => [k, { status: c.status, palletIndex: c.palletIndex, callIndex: c.callIndex, argTypesConfidence: c.argTypesConfidence }])) };
  return {
    id, kind: run.kind, recordingVersion: run.recordingVersion, ranAt: run.ranAt, evidenceFile: repoPath(join(RUNS, file)), runsOfThisKind: count,
    endpoint: run.endpoint, requireSignedDryRun: run.requireSignedDryRun,
    compiledMode: run.compiledMode, compiledModeReason: run.compiledModeReason, shimmed: run.shimmed,
    manifest: run.manifest, manifestDigest: run.manifestDigest, facts,
    plan: run.plan, planText: safe(explainPlan, run.plan),
    preflight: run.preflight, preflightAt: run.preflightDetail?.atBlock,
    envelope: run.envelope, policy: run.policy, policyResult: run.policyResult, policyText: safe(explainPolicy, run.policyResult),
    approval: run.approval?.approval,
    signing: { count: run.signingRequests?.length ?? 0, specVersion: req.specVersion, era: req.era, signedExtensions: req.signedExtensions, genesisHash: req.genesisHash },
    gateChecks: (run.gateChecks ?? []).map(stripGate),
    timeline: (run.stepLog ?? []).map(stripStep),
    statuses: run.statuses ?? [],
  };
}
function executed(id, pickInfo) {
  const run = pickInfo.run;
  const intact = safe(checkReceipt, run.run.receipt);
  check(`${id}: receipt digest intact (checkReceipt)`, intact === true || intact?.ok === true, JSON.stringify(intact));
  return { ...common(id, pickInfo), run: { ok: run.run.ok, stoppedReason: run.run.stoppedReason, receipt: run.run.receipt }, receiptText: safe(explainReceipt, run.run.receipt), usedProofSize: usedProofOf(run.run.receipt) };
}

const r = rb.run;
const rollback = {
  ...common('rollback', rb),
  run: { ok: r.run.ok, stage: r.run.stage, reason: r.run.reason },
  seamGate: { ...r.seamGate, dryRun: r.seamGate.dryRun.map((d) => ({ txHash: d.txHash, outcome: d.outcome, detail: d.detail, raw: d.raw })) },
  directSubmit: { note: r.directSubmit.note, txHash: r.directSubmit.txHash, status: r.directSubmit.status, history: r.directSubmit.history, statuses: r.directSubmit.statuses, block: r.directSubmit.block, extrinsicIndex: r.directSubmit.extrinsicIndex, success: r.directSubmit.success, dispatchError: r.directSubmit.dispatchError, events: r.directSubmit.events },
  state: r.state, innerEffects: r.innerEffects, conclusion: r.conclusion, batchAllRollback: r.batchAllRollback,
};
check('rollback: asset balances and supply identical before and after the bypass', JSON.stringify(r.state.before.asset) === JSON.stringify(r.state.after.asset));
check('rollback: bypass finalized as a failed extrinsic', r.directSubmit.status === 'finalized' && r.directSubmit.success === false);
check('rollback: no Assets events in the failed block', !r.directSubmit.events.some((e) => e.startsWith('Assets.')));

const out = {
  importedAt: new Date().toISOString(),
  source: { dir: repoPath(DIR), readme: 'evidence/README.md', files: [seq.file, rb.file, ato.file, setupFile?.f].filter(Boolean) },
  node: { endpoint: snapshot.endpoint, binary: 'substrate-contracts-node v0.42.0 (local --dev, instant seal)', rpcSnapshotAt: snapshot.fetchedAt, declaredToken: snapshot.declaredToken, pallets: factsSummary.pallets, metadataVersion: factsSummary.metadataVersion },
  setup: setupFile && { file: repoPath(join(RUNS, setupFile.f)), steps: setupFile.d.steps.map((s) => ({ what: s.what, txHash: s.txHash, block: s.block, success: s.success })), state: setupFile.d.state },
  sequential: executed('sequential', seq),
  atomic: { ...executed('atomic', ato), rollbackEvidence: ato.run.rollbackEvidence },
  rollback,
  checks,
};
const dst = fileURLToPath(new URL('../src/demo/devnode.json', import.meta.url));
const json = JSON.stringify(out, null, 1);
if (/"signature"\s*:|"signBytesHex"|"metadataHex"|\/\/Alice|secretSeed|mnemonic|"seed"/i.test(json)) throw new Error('refusing to write: looks like key material or raw signing data');
writeFileSync(dst, json);
console.log('wrote', dst, (json.length / 1024).toFixed(1), 'KB;', checks.filter((c) => c.ok).length, '/', checks.length, 'checks pass;', out.source.files.join(', '));
