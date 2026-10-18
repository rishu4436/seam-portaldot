#!/usr/bin/env node
// Read-only discovery of a hosted Portaldot V3 RPC. Sends no transaction and needs no key.
//
//   node scripts/v3-discover.mjs WS_RPC_URL [--out evidence/v3-discovery] [--types FILE]
//
// Reads state_getMetadata, state_getRuntimeVersion, system_chain, genesis and head, rpc_methods and Metadata_metadata_versions,
// then writes <out>/<name>-snapshot.json + -metadata.hex (same format as the mainnet snapshot), v3-capabilities.json and v3-capabilities.md.
// Each capability is `observed`, `absent` or `NOT VERIFIED`. The Portaldot mainnet endpoint is always refused (no override).
// V3 is NOT VERIFIED until this has been run against a real V3 RPC.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertNotMainnetUrl } from './seam-run.mjs';
import { discoverV3 } from '../dist/index.js';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const FLAGS_WITH_VALUE = new Set(['--out', '--types']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !FLAGS_WITH_VALUE.has(argv[i - 1]));
const rpc = positional[0];
if (!rpc || argv.includes('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(rpc ? 0 : 2);
}
if (!/^wss?:\/\//.test(rpc)) { console.error('WS_RPC_URL must start with ws:// or wss://'); process.exit(2); }
try { assertNotMainnetUrl(rpc); } catch (e) { console.error(e.message); process.exit(2); }

const outDir = flag('--out') ?? fileURLToPath(new URL('../../../evidence/v3-discovery', import.meta.url));
let result;
try { result = await discoverV3(rpc, outDir, flag('--types') ? { typesBundle: readFileSync(flag('--types'), 'utf8') } : {}); } catch (e) { console.error(e.message); process.exit(1); }
const { capabilities, files } = result;
const count = (s) => capabilities.capabilities.filter((c) => c.status === s).length;
console.log(`observed ${count('observed')}, absent ${count('absent')}, NOT VERIFIED ${count('NOT VERIFIED')}`);
console.log(`wrote ${files.json}\n      ${files.md}`);
console.log('This is what one node reported. V3 stays NOT VERIFIED until the output has been reviewed against the intended V3 RPC.');
