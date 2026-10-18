#!/usr/bin/env node
// READ-ONLY. Shows the submit gate refusing a plan that was prepared for the Portaldot MAINNET runtime lock
// (the committed spec-1002 snapshot) when the node in front of it is a different chain: the local Portaldot dev node.
//
//   node scripts/gate-mainnet-plan.mjs [ws://127.0.0.1:9966] [--token POT:14] [--out FILE]
//
// Signs nothing, sends nothing, never contacts mainnet (the plan comes from files in this repo; the only network
// access is read-only RPC to the local node, and a mainnet URL is refused). No keys or signatures are produced or
// recorded: the "signed calls" the gate compares are the plan's own approved call bytes, only to isolate the
// runtime check. The preflight and signing envelope are offline placeholders (no node reachable for the plan's runtime).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { compile, computeManifestDigest, computeFingerprintDigest } from '@seam/compiler';
import { parsePolicy, evaluatePolicy, createApproval, checkBeforeSubmit, callsToSign, InMemoryApprovalStore } from '@seam/policy';
import { factsFromSnapshot, parseManifest } from '@seam/sdk';
import { refetchFingerprint } from '../dist/index.js';
import { assertNotMainnetUrl } from './seam-run.mjs';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const url = argv.find((a, i) => !a.startsWith('--') && !['--token', '--out'].includes(argv[i - 1])) ?? 'ws://127.0.0.1:9966';
if (!/^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) { console.error('refusing: this script only reads from a local node'); process.exit(2); }
assertNotMainnetUrl(url);
const tok = flag('--token')?.match(/^([^:]+):(\d+)$/);
const declaredToken = tok ? { tokenSymbol: tok[1], tokenDecimals: Number(tok[2]) } : { tokenSymbol: 'POT', tokenDecimals: 14 };
const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const out = flag('--out') ?? root('evidence/portaldot-local-node/mainnet-plan-blocked.json');

// 1. Prepare a plan against the committed mainnet snapshot / lock (offline, no network).
const snapDir = fileURLToPath(new URL('../fixtures', import.meta.url));
const mainnet = factsFromSnapshot(snapDir, { name: 'portaldot-mainnet' });
const manifest = parseManifest(readFileSync(root('docs/examples/demo-manifest.json'), 'utf8'));
if (!manifest.ok) throw new Error('demo manifest invalid');
const plan = compile(manifest.manifest, mainnet);
const parsedPolicy = parsePolicy({ ...JSON.parse(readFileSync(root('docs/examples/demo-policy.json'), 'utf8')), requireSignedDryRun: false, allowUnknown: { storageDeposit: true } });
if (!parsedPolicy.ok) throw new Error('demo policy invalid');
const policy = parsedPolicy.policy;
const preflight = { steps: plan.steps.map((s) => ({ actionId: s.actionId, weight: { value: '1' }, fee: { value: '1' }, storageDeposit: { unknown: true }, dryRun: 'ok' })), totalFee: { value: '3' } };
const policyResult = evaluatePolicy({ policy, plan, facts: mainnet, preflight, manifest: manifest.manifest });
const now = new Date();
const envelope = { signer: manifest.manifest.signer.value, nonce: 0, mortalityBlocks: 64, checkpoint: { number: mainnet.blockNumber ?? 0, hash: mainnet.fingerprint.genesisHash }, expiresAt: new Date(now.getTime() + 600_000).toISOString() };
const approved = createApproval({ plan, envelope, policy, policyResult, fingerprint: mainnet.fingerprint, preflight, now, manifestDigest: plan.manifestDigest });
if (!approved.ok) throw new Error(`could not build the approval for the mainnet-locked plan: ${approved.reason}`);

// 2. Read the live fingerprint of the local node (read-only RPC) and run the submit gate.
const local = await refetchFingerprint(url, { declaredToken });
const check = checkBeforeSubmit({
  manifestDigest: plan.manifestDigest, plan, envelope, preflight, policy, policyResult, approval: approved.approval,
  preparedFingerprint: mainnet.fingerprint, currentFingerprint: local, signedCalls: callsToSign(plan), signedDryRun: undefined,
  now, store: new InMemoryApprovalStore()
});
const diff = Object.keys(mainnet.fingerprint).filter((k) => JSON.stringify(mainnet.fingerprint[k]) !== JSON.stringify(local[k])).map((k) => ({ field: k, planned: mainnet.fingerprint[k], local: local[k] }));
const record = {
  kind: 'gate-blocks-mainnet-plan-on-local-node',
  label: 'local Portaldot dev node, spec 1002, not V3 testnet, not mainnet',
  recordedAt: now.toISOString(),
  readOnly: { signed: false, sent: false, mainnetContacted: false, note: 'plan from committed files; only read-only RPC to the local node; the gate was fed the plan\'s own call bytes, nothing was signed' },
  localNode: url,
  plan: { source: 'docs/examples/demo-manifest.json compiled against packages/chain/fixtures/portaldot-mainnet-snapshot.json', mode: plan.mode, steps: plan.steps.map((s) => s.actionId), planDigest: plan.planDigest, manifestDigest: plan.manifestDigest, calls: callsToSign(plan) },
  policy: 'docs/examples/demo-policy.json with requireSignedDryRun false (so the signed dry run is not what is being shown)',
  policyAllowed: policyResult.allowed,
  placeholders: 'preflight and signing envelope are offline placeholders (the plan\'s runtime is not reachable); approval is a real createApproval over them',
  plannedFingerprint: mainnet.fingerprint, plannedFingerprintDigest: computeFingerprintDigest(mainnet.fingerprint),
  localFingerprint: local, localFingerprintDigest: computeFingerprintDigest(local),
  fingerprintFieldsThatDiffer: diff.map((d) => d.field), differences: diff,
  gate: { ok: check.ok, reasonCodes: check.reasons.map((r) => r.code), reasons: check.reasons, passed: check.passed },
  conclusion: check.ok ? 'UNEXPECTED: the gate did not block' : `BLOCKED by the submit gate: ${check.reasons.map((r) => r.code).join(', ')}`
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(record, null, 1) + '\n');
console.log(`${out}\n${record.conclusion}\nplanned ${record.plannedFingerprintDigest}\nlocal   ${record.localFingerprintDigest}`);
process.exit(check.ok ? 1 : 0);
