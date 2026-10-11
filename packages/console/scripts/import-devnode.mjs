// Builds src/demo/devnode.json from Bot 4's REAL runs on the local
// substrate-contracts-node (ws://127.0.0.1:9944), saved under
// /workspace/seam-evidence/devnode/ by packages/chain/scripts/devnode/*.mjs.
// Nothing here is simulated: every hash, block, event, fee and digest is copied
// from the evidence files. The script only reshapes them for the console and
// re-checks the digests with the real @seam/compiler and @seam/sdk.
// Signatures and signing payloads are NOT copied (dev keys, but not needed).
//
// usage: node scripts/import-devnode.mjs [evidenceDir] [--first]
//   default picks the LATEST recorded run of each kind (newest chain code, incl.
//   preflight proof size). --first picks the first runs Bot 4 reported
//   (sequential in blocks 4-6, rollback in block 7, atomic in block 8).
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { computeManifestDigest, computePlanDigest } from '@seam/compiler';
import { checkReceipt, explainPlan, explainPolicy, explainReceipt } from '@seam/sdk';

const args = process.argv.slice(2);
const latest = !args.includes('--first');
const DIR = args.find((a) => !a.startsWith('--')) ?? '/workspace/seam-evidence/devnode';
const RUNS = join(DIR, 'runs');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const files = readdirSync(RUNS).filter((f) => f.endsWith('.json')).sort();
const pick = (prefix) => {
  const all = files.filter((f) => f.startsWith(prefix + '-'));
  if (!all.length) throw new Error(`no ${prefix}-*.json in ${RUNS}`);
  return { file: latest ? all.at(-1) : all[0], count: all.length };
};

const factsSummary = read(join(DIR, 'devnode-facts-summary.json'));
const snapshot = read(join(DIR, 'substrate-contracts-node-spec100-snapshot.json'));
const seqPick = pick('sequential'), atoPick = pick('atomic'), rbPick = pick('rollback'), setupPick = pick('setup');
const seq = read(join(RUNS, seqPick.file));
const ato = read(join(RUNS, atoPick.file));
const rb = read(join(RUNS, rbPick.file));
// The first setup file has the create/mint/instantiate transactions; later ones just say "already exists".
const setupFile = files.filter((f) => f.startsWith('setup-')).map((f) => ({ f, d: read(join(RUNS, f)) })).find((x) => x.d.steps.some((s) => s.txHash)) ?? { f: setupPick.file, d: read(join(RUNS, setupPick.file)) };

const checks = [];
const check = (what, ok, detail = '') => { checks.push({ what, ok, detail }); if (!ok) console.warn('CHECK FAILED:', what, detail); };

// The Manifest itself isn't saved in the evidence. Rebuild it exactly as
// flow.mjs devManifest() does, then prove it with the recorded digest.
function manifestFor(run, atomic) {
  const by = Object.fromEntries(run.plan.steps.map((s) => [s.actionId, s.decodedArgs]));
  const pref = atomic ? { preferredMode: 'atomic' } : {};
  return {
    version: 1,
    chain: { genesisHash: factsSummary.fingerprint.genesisHash, specVersion: factsSummary.fingerprint.specVersion },
    signer: { type: 'ss58', value: run.plan.signer.value },
    actions: [
      { id: 'pay', kind: 'assets.transfer', args: { assetId: by.pay.assetId, amount: by.pay.amount, recipient: by.pay.recipient }, ...pref },
      { id: 'call', kind: 'contracts.call', args: { contract: by.call.contractAccountId, value: by.call.value, gasLimit: by.call.gasLimit, data: by.call.data }, ...pref },
      { id: 'mint', kind: 'assets.mint', args: { assetId: by.mint.assetId, amount: by.mint.amount, recipient: by.mint.recipient }, ...pref },
    ],
  };
}

const safe = (f, ...a) => { try { return f(...a); } catch (e) { return undefined; } };
const stripStep = (s) => ({ index: s.index, actionId: s.actionId, phase: s.phase, detail: s.detail, at: s.at, dryRun: s.dryRun?.map((d) => ({ txHash: d.txHash, outcome: d.outcome, detail: d.detail })) });

function runScenario(id, run, pickInfo, atomic) {
  const manifest = manifestFor(run, atomic);
  const md = computeManifestDigest(manifest);
  const manifestVerified = md === run.manifestDigest;
  check(`${id}: rebuilt Manifest digest matches the recorded one`, manifestVerified, `${md} vs ${run.manifestDigest}`);
  const { planDigest, ...planBody } = run.plan;
  const pd = safe(computePlanDigest, planBody);
  check(`${id}: plan digest recomputes`, pd === planDigest, `${pd} vs ${planDigest}`);
  const intact = safe(checkReceipt, run.run.receipt);
  check(`${id}: receipt digest intact (checkReceipt)`, intact === true || intact?.ok === true, JSON.stringify(intact));
  // Proof size actually used, from each transaction's System.ExtrinsicSuccess event.
  const usedProof = Object.fromEntries(run.run.receipt.steps.map((s) => {
    const ev = (s.events ?? []).find((e) => e.startsWith('System.ExtrinsicSuccess('));
    const m = ev && /"proofSize":(\d+)/.exec(ev);
    return [s.actionId, m ? { value: m[1], txHash: s.txHash } : null];
  }));
  const { signature: _s, ...firstReq } = run.signingRequests?.[0] ?? {};
  return {
    id, kind: run.kind, ranAt: run.ranAt, evidenceFile: `runs/${pickInfo.file}`, runsOfThisKind: pickInfo.count,
    endpoint: run.endpoint, requireSignedDryRun: run.requireSignedDryRun,
    compiledMode: run.compiledMode, compiledModeReason: run.compiledModeReason, shimmed: run.shimmed,
    manifest, manifestDigest: run.manifestDigest, manifestRebuilt: true, manifestVerified,
    plan: run.plan, planText: safe(explainPlan, run.plan),
    preflight: run.preflight, usedProofSize: usedProof, preflightDetail: run.preflightDetail,
    envelope: run.envelope, policy: run.policy, policyResult: run.policyResult, policyText: safe(explainPolicy, run.policyResult),
    approval: run.approval.approval,
    signing: { count: run.signingRequests?.length ?? 0, specVersion: firstReq.payload?.specVersion, transactionVersion: firstReq.payload?.transactionVersion, era: firstReq.payload?.era, signedExtensions: firstReq.payload?.signedExtensions, genesisHash: firstReq.payload?.genesisHash },
    timeline: run.stepLog.map(stripStep),
    statuses: run.statuses,
    run: { ok: run.run.ok, stoppedReason: run.run.stoppedReason, receipt: run.run.receipt },
    receiptText: safe(explainReceipt, run.run.receipt),
    receiptIntact: run.receiptIntact,
  };
}

const rollback = {
  id: 'rollback', kind: rb.kind, ranAt: rb.ranAt, evidenceFile: `runs/${rbPick.file}`, runsOfThisKind: rbPick.count,
  planMode: rb.planMode, steps: rb.steps, outerCall: rb.outerCall, policyAllowed: rb.policyResult?.allowed, approvalHash: rb.approvalHash,
  seamGate: { ...rb.seamGate, dryRun: rb.seamGate.dryRun.map((d) => ({ txHash: d.txHash, outcome: d.outcome, detail: d.detail, raw: d.raw })) },
  directSubmit: rb.directSubmit, state: rb.state, innerEffects: rb.innerEffects, conclusion: rb.conclusion, batchAllRollback: rb.batchAllRollback,
};
const unchanged = JSON.stringify(rb.state.before.asset) === JSON.stringify(rb.state.after.asset);
check('rollback: asset balances and supply identical before and after the bypass', unchanged);
check('rollback: bypass finalized as a failed extrinsic', rb.directSubmit.status === 'finalized' && rb.directSubmit.success === false);
check('rollback: no Assets events in the failed block', !rb.directSubmit.events.some((e) => e.startsWith('Assets.')));

const out = {
  importedAt: new Date().toISOString(),
  source: { dir: DIR, picked: latest ? 'latest' : 'first', files: [seqPick.file, rbPick.file, atoPick.file, setupFile.f, 'devnode-facts-summary.json', basename(join(DIR, 'substrate-contracts-node-spec100-snapshot.json'))] },
  node: { endpoint: snapshot.endpoint, binary: 'substrate-contracts-node v0.42.0 (local, instant seal)', rpcSnapshotAt: snapshot.fetchedAt, declaredToken: snapshot.declaredToken, signedExtensions: snapshot.signedExtensions, pallets: factsSummary.pallets },
  facts: { fingerprint: factsSummary.fingerprint, fingerprintDigest: factsSummary.fingerprintDigest, metadataVersion: factsSummary.metadataVersion, behaviour: factsSummary.behaviour, capabilities: factsSummary.capabilities },
  setup: { file: `runs/${setupFile.f}`, steps: setupFile.d.steps.map((s) => ({ what: s.what, txHash: s.txHash, block: s.block, success: s.success, events: s.events })), state: setupFile.d.state },
  sequential: runScenario('sequential', seq, seqPick, false),
  atomic: { ...runScenario('atomic', ato, atoPick, true), rollbackEvidence: ato.rollbackEvidence ? basename(ato.rollbackEvidence) : undefined },
  rollback,
  checks,
};
const dst = fileURLToPath(new URL('../src/demo/devnode.json', import.meta.url));
const json = JSON.stringify(out, null, 1);
if (/"signature"\s*:|\/\/Alice|secretSeed|mnemonic/i.test(json)) throw new Error('refusing to write: looks like key material');
writeFileSync(dst, json);
console.log('wrote', dst, (json.length / 1024).toFixed(1), 'KB;', checks.filter((c) => c.ok).length, '/', checks.length, 'checks pass');
