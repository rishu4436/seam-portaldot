// One-off: copy evidence recorded before recordingVersion 2 from /workspace/seam-evidence/devnode into
// <repo>/evidence/devnode. Those files kept the dev-key signatures of the signing requests; they are removed in the
// repo copy (and the copy is marked). Every file passes the same no-secrets check as new evidence.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { EVIDENCE, REPO_EVIDENCE, evidenceJson } from './lib.mjs';

const SIG = /^(signature|signatures)$/;
function redact(v, path = '', removed = []) {
  if (Array.isArray(v)) return [v.map((x, i) => redact(x, `${path}[${i}]`, removed)[0]), removed];
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (SIG.test(k)) { removed.push(`${path}.${k}`.replace(/^\./, '')); continue; }
      out[k] = redact(x, `${path}.${k}`, removed)[0];
    }
    return [out, removed];
  }
  return [v, removed];
}

const copied = [];
for (const rel of ['runs', 'runs/failed-attempts']) {
  const src = `${EVIDENCE}/${rel}`;
  if (!existsSync(src)) continue;
  mkdirSync(`${REPO_EVIDENCE}/${rel}`, { recursive: true });
  for (const f of readdirSync(src).filter((x) => x.endsWith('.json')).sort()) {
    const dst = `${REPO_EVIDENCE}/${rel}/${f}`;
    if (existsSync(dst)) continue;
    const [json, removed] = redact(JSON.parse(readFileSync(`${src}/${f}`, 'utf8')));
    if (removed.length) json.redacted = { removed: `${removed.length} signature field(s) (signingRequests[].signature) when copied into the repo`, at: new Date().toISOString() };
    writeFileSync(dst, evidenceJson(json));
    copied.push(`${rel}/${f}${removed.length ? ` (${removed.length} signatures removed)` : ''}`);
  }
}
for (const f of ['ASSUMPTIONS.md', 'substrate-contracts-node-spec100-metadata.hex', 'substrate-contracts-node-spec100-snapshot.json', 'devnode-facts-summary.json', 'state.json']) {
  if (existsSync(`${EVIDENCE}/${f}`) && !existsSync(`${REPO_EVIDENCE}/${f}`)) { copyFileSync(`${EVIDENCE}/${f}`, `${REPO_EVIDENCE}/${f}`); copied.push(f); }
}
console.log(copied.join('\n'));
