// Builds src/demo/portaldot-local.json from the committed recordings in
// evidence/portaldot-local-node/ (local Portaldot dev node, spec 1002). Every
// value is copied from those files; nothing is invented or recomputed.
// usage: node scripts/import-local-node.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DIR = join(REPO, 'evidence/portaldot-local-node');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const summary = read(join(DIR, 'testnet-summary.json'));
const report = read(join(DIR, 'runtime-report.json'));
const runFile = (p) => readdirSync(join(DIR, 'runs')).filter((f) => f.startsWith(p + '-')).sort().at(-1);
const run = (p) => ({ file: `evidence/portaldot-local-node/runs/${runFile(p)}`, d: read(join(DIR, 'runs', runFile(p))) });
const seq = run('sequential'), ato = run('atomic'), rb = run('rollback'), dep = run('deploy');
const gates = (d) => d.gateChecks.map((g) => ({ actionId: g.actionId ?? g.index, phase: g.phase, ok: g.check.ok, reasons: g.check.reasons.map((r) => r.code), passed: (g.check.passed ?? []).map((p) => p.code) }));
const mb = read(join(DIR, 'mainnet-plan-blocked.json'));
const fail = (m) => { throw new Error('evidence check failed: ' + m); };
if (summary.deploy.txHash !== dep.d.txHash) fail('deploy tx differs between summary and deploy run');
if (summary.flows.rollback.dispatchError == null) fail('no rollback dispatch error');

const out = {
  source: 'evidence/portaldot-local-node',
  node: { endpoint: summary.endpoint, specName: report.chain.specName, specVersion: report.chain.specVersion, transactionVersion: report.chain.transactionVersion, metadataVersion: report.metadataVersion, genesisHash: report.chain.genesisHash, fingerprintDigest: report.fingerprintDigest, fingerprintStableOnRefetch: report.fingerprintStableOnRefetch, token: report.token, hasContracts: report.has.Contracts, hasRevive: report.has.Revive, hasAssets: report.has.Assets, hasUtility: report.has.Utility, palletCount: report.pallets.length },
  signer: summary.signer, startedAt: summary.startedAt, finishedAt: summary.finishedAt,
  deploy: { txHash: summary.deploy.txHash, block: summary.deploy.block.number, blockHash: summary.deploy.block.hash, contract: summary.deploy.contract, codeHash: summary.deploy.codeHash, status: summary.deploy.status, dryRun: summary.deploy.dryRun, file: dep.file },
  sequential: { file: seq.file, result: summary.flows.sequential.result, compiledMode: seq.d.compiledMode, steps: summary.flows.sequential.steps, gate: gates(seq.d), receipt: seq.d.run.receipt.result },
  atomic: { file: ato.file, result: summary.flows.atomic.result, compiledMode: ato.d.compiledMode, steps: summary.flows.atomic.steps, gate: gates(ato.d), receipt: ato.d.run.receipt.result },
  rollback: {
    file: rb.file, result: summary.flows.rollback.result, directTx: summary.flows.rollback.directTx, dispatchError: summary.flows.rollback.dispatchError,
    gateReasons: rb.d.seamGate.reasons.map((r) => ({ code: r.code, message: r.message })), gatePassed: rb.d.seamGate.passed.map((p) => p.code), nothingSent: rb.d.seamGate.nothingSent, dryRun: rb.d.seamGate.dryRun[0].detail,
    bypassNote: rb.d.directSubmit.note, bypassStatuses: rb.d.directSubmit.statuses.map((s) => s.status), state: rb.d.state, batchAllRollback: rb.d.batchAllRollback,
  },
  mainnetBlocked: {
    file: 'evidence/portaldot-local-node/mainnet-plan-blocked.json', label: mb.label, recordedAt: mb.recordedAt, localNode: mb.localNode, plan: mb.plan.source, steps: mb.plan.steps,
    plannedDigest: mb.plannedFingerprintDigest, localDigest: mb.localFingerprintDigest, differs: mb.fingerprintFieldsThatDiffer, differences: mb.differences,
    reasons: mb.gate.reasons, passed: mb.gate.passed.map((p) => p.code), placeholders: mb.placeholders, policy: mb.policy, conclusion: mb.conclusion,
    signed: mb.readOnly.signed, sent: mb.readOnly.sent, mainnetContacted: mb.readOnly.mainnetContacted,
  },
  contractCall: seq.d.manifest.actions.find((a) => a.kind === 'contracts.call').args.data,
};
writeFileSync(join(import.meta.dirname, '../src/demo/portaldot-local.json'), JSON.stringify(out, null, 1) + '\n');
console.log('wrote src/demo/portaldot-local.json');
