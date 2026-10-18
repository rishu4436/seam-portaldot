#!/usr/bin/env node
// Read-only runtime shape check. Reads metadata (file or `state_getMetadata` over RPC), builds RuntimeFacts, compiles a
// small built-in sample Manifest and reports pallet/call indices, the Contracts.call argument shape and unavailable steps.
// It never signs or submits anything and does not touch the chain beyond one metadata read.
//
// usage: node scripts/v3-shape-check.mjs <metadata.hex | metadata.json | ws(s)/http(s) RPC url> [--json]
//   JSON file: a hex string, or {"metadataHex"|"metadata"|"result": "0x..."} optionally with genesis, tokenSymbol, tokenDecimals.
// Needs `npm run build` first (imports ../dist).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile, factsFromMetadata, loadRuntime, needsPinnedTypes, readPinnedTypes, SeamCompileError } from '../dist/index.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const src = argv.find((a) => !a.startsWith('--'));
if (!src) {
  console.error('usage: node scripts/v3-shape-check.mjs <metadata.hex | metadata.json | rpc url> [--json]');
  process.exit(2);
}

async function rpc(url, method, params = []) {
  const http = url.replace(/^ws/, 'http'); // JSON-RPC over HTTP; same method polkadot.js calls over WS
  const res = await fetch(http, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function load() {
  const extra = {};
  if (/^(wss?|https?):\/\//.test(src)) {
    // Read-only methods only.
    const metadataHex = await rpc(src, 'state_getMetadata');
    extra.genesisHash = await rpc(src, 'chain_getBlockHash', [0]);
    try {
      const p = await rpc(src, 'system_properties');
      const first = (v) => (Array.isArray(v) ? v[0] : v);
      extra.tokenSymbol = first(p.tokenSymbol);
      extra.tokenDecimals = first(p.tokenDecimals);
    } catch { /* optional */ }
    return { metadataHex, extra, from: src };
  }
  if (!existsSync(src)) throw new Error(`no such file: ${src}`);
  const text = readFileSync(src, 'utf8').trim();
  if (text.startsWith('{') || text.startsWith('"')) {
    const j = JSON.parse(text);
    if (typeof j === 'string') return { metadataHex: j, extra, from: src };
    const hex = j.metadataHex ?? j.metadata ?? j.result;
    if (typeof hex !== 'string') throw new Error('JSON file has no metadataHex / metadata / result string');
    if (j.genesis ?? j.genesisHash) extra.genesisHash = j.genesis ?? j.genesisHash;
    if (j.tokenSymbol) extra.tokenSymbol = j.tokenSymbol;
    if (j.tokenDecimals !== undefined) extra.tokenDecimals = j.tokenDecimals;
    return { metadataHex: hex, extra, from: src };
  }
  return { metadataHex: text, extra, from: src };
}

// Well-known dev accounts (SS58 prefix 42).
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const { metadataHex, extra, from } = await load();
const hex = metadataHex.trim();
const probe = loadRuntime(hex, needsPinnedTypes(hex) ? readPinnedTypes() : undefined);
const facts = factsFromMetadata({
  metadataHex: hex,
  ...(needsPinnedTypes(hex) ? { typesBundle: readPinnedTypes() } : {}),
  genesisHash: extra.genesisHash ?? `0x${'00'.repeat(32)}`,
  tokenSymbol: extra.tokenSymbol ?? 'UNIT',
  tokenDecimals: extra.tokenDecimals ?? 12
});

const out = {
  source: from,
  metadataVersion: probe.metadataVersion,
  runtime: `${facts.fingerprint.specName} spec ${facts.fingerprint.specVersion} (tx ${facts.fingerprint.transactionVersion}, ss58 ${facts.fingerprint.ss58Prefix})`,
  genesisIsPlaceholder: extra.genesisHash === undefined,
  capabilities: {},
  contractsCallShape: null,
  steps: [],
  mode: null
};
for (const [name, c] of Object.entries(facts.capabilities)) {
  if (!['Assets.transfer_keep_alive', 'Assets.mint', 'Contracts.call', 'Revive.call', 'Nfts.mint', 'Utility.batch_all'].includes(name)) continue;
  out.capabilities[name] = c.status === 'observed' ? { pallet: c.palletIndex, call: c.callIndex, args: c.args.map((a) => `${a.name}: ${a.type}`) } : c.status;
}
const cc = facts.capabilities['Contracts.call'];
if (cc?.status === 'observed') {
  const names = cc.args.map((a) => a.name);
  const gas = cc.args.find((a) => a.name === 'gas_limit')?.type ?? '?';
  const weight = /Weight/i.test(gas) && !/^(Compact<)?u64>?$/.test(gas);
  out.contractsCallShape = {
    args: names,
    shape: weight && names.includes('storage_deposit_limit')
      ? 'V14: Weight { ref_time, proof_size } + storage_deposit_limit'
      : names.includes('storage_deposit_limit') ? 'storage_deposit_limit present, gas_limit is not a Weight' : 'V13: single gas_limit (no storage_deposit_limit)',
    gasLimitType: gas
  };
}

const sample = {
  version: 1,
  signer: { type: 'ss58', value: ALICE, ...(facts.fingerprint.ss58Prefix === 42 ? { ss58Prefix: 42 } : {}) },
  actions: [
    { id: 'pay', kind: 'assets.transfer', args: { assetId: '1', amount: '1000', recipient: BOB } },
    { id: 'mint', kind: 'assets.mint', args: { assetId: '2', amount: '1', recipient: BOB } },
    { id: 'call', kind: 'contracts.call', args: { contract: BOB, value: '0', gasLimit: '5000000000', proofSize: '131072', storageDepositLimit: null, data: '0x633aa551' } }
  ]
};
const tryCompile = (m) => {
  try { return compile(m, facts, { allowAtomicUnverified: false }); } catch (e) { if (e instanceof SeamCompileError) return e; throw e; }
};
let plan = tryCompile(sample);
if (plan instanceof SeamCompileError && cc?.status === 'observed') {
  // Runtime may not take proofSize / storageDepositLimit (V13 shape): retry with the single gas_limit form.
  const alt = structuredClone(sample);
  delete alt.actions[2].args.proofSize;
  delete alt.actions[2].args.storageDepositLimit;
  const p2 = tryCompile(alt);
  if (!(p2 instanceof SeamCompileError)) { plan = p2; out.note = 'sample retried without proofSize/storageDepositLimit (runtime has the single gas_limit shape)'; }
}
if (plan instanceof SeamCompileError) {
  out.compileError = plan.issues.map((i) => `${i.code}${i.path ? ` at ${i.path}` : ''}: ${i.message}`);
} else {
  out.mode = `${plan.mode}: ${plan.modeReason}`;
  out.steps = plan.steps.map((s) => ({ id: s.actionId, capability: s.capability, pallet: s.palletIndex, call: s.callIndex, status: s.status, ...(s.reason ? { reason: s.reason } : {}), ...(s.encodedCall ? { encodedCall: s.encodedCall } : {}) }));
  out.unavailable = plan.steps.filter((s) => s.status === 'unavailable').map((s) => `${s.actionId}: ${s.reason}`);
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`source:    ${out.source}\nmetadata:  V${out.metadataVersion}\nruntime:   ${out.runtime}${out.genesisIsPlaceholder ? '  (genesis is a placeholder: not read from a chain)' : ''}\n\ncapabilities:`);
  for (const [n, c] of Object.entries(out.capabilities)) console.log(typeof c === 'string' ? `  ${n.padEnd(28)} ${c}` : `  ${n.padEnd(28)} pallet ${c.pallet} call ${c.call}  (${c.args.join(', ')})`);
  console.log(`\nContracts.call shape: ${out.contractsCallShape ? `${out.contractsCallShape.shape}\n  args: ${out.contractsCallShape.args.join(', ')}; gas_limit: ${out.contractsCallShape.gasLimitType}` : 'not on this runtime'}`);
  if (out.note) console.log(`note: ${out.note}`);
  if (out.compileError) console.log(`\nsample manifest did not compile:\n  ${out.compileError.join('\n  ')}`);
  else {
    console.log(`\nsample plan: ${out.mode}`);
    for (const s of out.steps) console.log(`  ${s.id.padEnd(5)} ${s.capability.padEnd(28)} ${s.status === 'ok' ? `ok  [${s.pallet},${s.call}]` : `UNAVAILABLE: ${s.reason}`}`);
    console.log(out.unavailable.length ? `\nunavailable steps: ${out.unavailable.length}` : '\nunavailable steps: none');
  }
}
