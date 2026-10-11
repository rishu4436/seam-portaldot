#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, SeamCompileError } from '@seam/compiler';
import { definePolicy, evaluatePolicy } from '@seam/policy';
import { parseManifest } from './manifest.js';
import { checkReceipt, type Receipt } from './receipt.js';
import { explainManifestIssues, explainPlan, explainPolicy, explainReceipt } from './explain.js';
import { factsFromSnapshot } from './offline.js';

const HELP = `seam <command> [file] [options]

  seam digest  <manifest.json>                    Check a Manifest and print its digest
  seam compile <manifest.json> [--json]           Compile against the runtime snapshot and explain the plan
  seam check   <manifest.json> --policy <p.json>  Compile, then run the policy check
  seam verify  <receipt.json>                     Check a receipt was not edited, and explain it
  seam explain <plan|policy-result|receipt.json>  Explain any SEAM result in plain English

Options:
  --snapshot <dir>  Folder with portaldot-mainnet-metadata.hex and -snapshot.json (default: bundled mainnet snapshot, spec 1002)
  --json            Print raw JSON instead of the explanation`;

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const json = argv.includes('--json');
const [cmd, file] = argv;
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const out = (text: string, data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : text);
const snapshotDir = () => flag('--snapshot') ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function loadManifest() {
  if (!file) throw new Error('missing manifest file');
  const r = parseManifest(readFileSync(file, 'utf8'));
  if (!r.ok) { out(explainManifestIssues(r.issues), r); process.exit(2); }
  return r;
}

function compileOrExit(m: ReturnType<typeof loadManifest> & { ok: true }) {
  try { return { facts: facts(), plan: compile(m.manifest, facts()) }; }
  catch (e) {
    if (e instanceof SeamCompileError) { out(['The Manifest could not be compiled:', ...e.issues.map((i) => `- ${i.path ?? '$'}: ${i.message}`)].join('\n'), e.issues); process.exit(2); }
    throw e;
  }
}
let cached: ReturnType<typeof factsFromSnapshot> | undefined;
const facts = () => (cached ??= factsFromSnapshot(snapshotDir()));

try {
  switch (cmd) {
    case 'digest': { const m = loadManifest(); if (m.ok) out(`Manifest is valid. Digest: ${m.digest}`, { digest: m.digest }); break; }
    case 'compile': {
      const m = loadManifest(); if (!m.ok) break;
      const { plan } = compileOrExit(m);
      out(`${explainPlan(plan)}\nPlan digest: ${plan.planDigest}`, plan);
      process.exit(plan.mode === 'unavailable' ? 3 : 0);
    }
    case 'check': {
      const m = loadManifest(); if (!m.ok) break;
      const p = flag('--policy'); if (!p) throw new Error('check needs --policy <policy.json>');
      const { plan, facts: f } = compileOrExit(m);
      const result = evaluatePolicy({ policy: definePolicy(read(p)), plan, facts: f, manifest: m.manifest });
      out(`${explainPlan(plan)}\n\n${explainPolicy(result)}`, { plan, policyResult: result });
      process.exit(result.allowed ? 0 : 4);
    }
    case 'verify': {
      if (!file) throw new Error('missing receipt file');
      const r = read(file) as Receipt;
      const intact = checkReceipt(r);
      out(`${intact ? 'Receipt is intact (digest matches).' : 'WARNING: this receipt was edited after SEAM produced it (digest does not match).'}\n${explainReceipt(r)}`, { intact, receipt: r });
      process.exit(intact ? 0 : 5);
    }
    case 'explain': {
      if (!file) throw new Error('missing file');
      const d = read(file);
      if (d.receiptVersion) console.log(explainReceipt(d));
      else if (d.planVersion) console.log(explainPlan(d));
      else if (Array.isArray(d.rules)) console.log(explainPolicy(d));
      else throw new Error('not a plan, policy result or receipt');
      break;
    }
    default: console.log(HELP); process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
  }
} catch (e) {
  console.error(`seam: ${(e as Error).message}`);
  process.exit(1);
}
