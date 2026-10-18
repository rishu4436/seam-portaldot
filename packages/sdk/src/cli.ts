#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, SeamCompileError, type RuntimeFacts } from '@seam/compiler';
import { evaluatePolicy, parsePolicy } from '@seam/policy';
import { parseManifest } from './manifest.js';
import { checkReceipt, type Receipt } from './receipt.js';
import { explainManifestIssues, explainPlan, explainPolicy, explainReceipt } from './explain.js';
import { factsFromSnapshot } from './offline.js';
import { parseAbiFlags, parseTokenFlag } from './cliargs.js';

const HELP = `seam <command> [file] [options]

  seam digest  <manifest.json>                    Check a Manifest and print its digest
  seam compile <manifest.json> [--json]           Compile against the runtime snapshot and explain the plan
  seam check   <manifest.json> --policy <p.json>  Compile, then run the policy check
  seam verify  <receipt.json>                     Check a receipt was not edited, and explain it
  seam explain <plan|policy-result|receipt.json>  Explain any SEAM result in plain English
  seam snapshot <ws-endpoint> <out-dir> [--name n]  Save a node's runtime (read-only) for offline use

Which runtime to compile against (pick one; default is the bundled Portaldot mainnet snapshot, spec 1002):
  --snapshot <dir|file>  A saved snapshot: a folder with one <name>-snapshot.json and <name>-metadata.hex, or the snapshot file
  --name <name>          Which snapshot, when the folder holds several
  --endpoint <ws-url>    Read the live runtime from a node instead (read-only)

  --token SYM:DEC        Token symbol and decimals, for a chain whose system_properties doesn't report them (e.g. --token UNIT:12).
                         The node's own value wins; if it differs, SEAM stops instead of guessing.

ink! contract calls written with "abiRef":
  --abi NAME=<file>      Load an ink! metadata.json under NAME (repeatable). A contracts.call with "abiRef": "NAME" uses it.

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

async function compileOrExit(m: ReturnType<typeof loadManifest> & { ok: true }) {
  const facts = await loadFacts();
  try { return { facts, plan: compile(m.manifest, facts, { abis: loadAbis() }) }; }
  catch (e) {
    if (e instanceof SeamCompileError) { out(['The Manifest could not be compiled:', ...e.issues.map((i) => `- ${i.path ?? '$'}: ${i.message}`)].join('\n'), e.issues); process.exit(2); }
    throw e;
  }
}
const flagValues = (n: string) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
const tokenFlag = () => parseTokenFlag(argv.includes('--token') ? argv[argv.indexOf('--token') + 1] ?? '' : undefined);
const loadAbis = () => parseAbiFlags(flagValues('--abi').map((v) => v ?? ''), (f) => JSON.parse(readFileSync(f, 'utf8')));
let cached: RuntimeFacts | undefined;
async function loadFacts(): Promise<RuntimeFacts> {
  if (cached) return cached;
  const endpoint = flag('--endpoint');
  if (endpoint) {
    const chain: any = await import('@seam/chain').catch(() => { throw new Error('--endpoint needs the @seam/chain package installed'); });
    const declaredToken = tokenFlag();
    cached = await chain.discover(endpoint, declaredToken ? { declaredToken } : {});
  } else {
    cached = factsFromSnapshot(snapshotDir(), { name: flag('--name'), declaredToken: tokenFlag() });
  }
  return cached!;
}
function describeRuntime(f: RuntimeFacts): string {
  const fp = f.fingerprint;
  return `Runtime: ${fp.specName} spec ${fp.specVersion} (${fp.tokenSymbol}), ${flag('--endpoint') ? `live from ${flag('--endpoint')}` : `snapshot${f.blockNumber !== undefined ? ` at block ${f.blockNumber}` : ''}`}.`;
}

async function main() {
  switch (cmd) {
    case 'digest': { const m = loadManifest(); if (m.ok) out(`Manifest is valid. Digest: ${m.digest}`, { digest: m.digest }); break; }
    case 'compile': {
      const m = loadManifest(); if (!m.ok) break;
      const { plan, facts } = await compileOrExit(m);
      out(`${describeRuntime(facts)}\n${explainPlan(plan)}\nPlan digest: ${plan.planDigest}`, plan);
      process.exit(plan.mode === 'unavailable' ? 3 : 0);
    }
    case 'check': {
      const m = loadManifest(); if (!m.ok) break;
      const p = flag('--policy'); if (!p) throw new Error('check needs --policy <policy.json>');
      const parsed = parsePolicy(readFileSync(p, 'utf8'));
      if (!parsed.ok) {
        out(['The policy file has problems, so nothing was checked:', ...parsed.issues.map((i) => `- ${i.path}: ${i.message}`)].join('\n'), parsed);
        process.exit(2);
      }
      const warn = parsed.warnings.length ? `\n\nPolicy warnings:\n${parsed.warnings.map((w) => `- ${w.path}: ${w.message}`).join('\n')}` : '';
      const { plan, facts: f } = await compileOrExit(m);
      const result = evaluatePolicy({ policy: parsed.policy, plan, facts: f, manifest: m.manifest });
      // Offline there is no preflight (fees, weight, dry runs need a node). Report everything else, and say so plainly.
      const rest = result.rules.filter((r) => r.rule !== 'preflight');
      const offlineOk = rest.every((r) => r.outcome === 'pass');
      const text = offlineOk && !result.allowed
        ? `Offline check passed: all ${rest.length} rules that don't need a node passed. Fees, weight and dry runs are checked against a live node before approval.`
        : explainPolicy({ ...result, rules: rest });
      out(`${describeRuntime(f)}\n${explainPlan(plan)}\n\n${text}${warn}`, { plan, policyResult: result, warnings: parsed.warnings, offline: true });
      process.exit(offlineOk ? 0 : 4);
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
    case 'snapshot': {
      const [, endpoint, outDir] = argv;
      if (!endpoint || !outDir) throw new Error('usage: seam snapshot <ws-endpoint> <out-dir> [--name n]');
      const chain: any = await import('@seam/chain').catch(() => { throw new Error('snapshot needs the @seam/chain package installed'); });
      const files = await chain.snapshotFromNode(endpoint, outDir, { name: flag('--name') });
      out(`Saved the runtime of ${endpoint} (read-only). Use it with --snapshot ${outDir}`, files);
      break;
    }
    default: console.log(HELP); process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(`seam: ${(e as Error).message}`);
  process.exit(1);
});
