#!/usr/bin/env node
// One command for the V3 testnet. It works on any node, so it is tested on the local dev node.
//
//   node scripts/testnet-run.mjs RPC_URL
//       Read-only: discover, refetch the fingerprint, write a plain runtime report. Signs nothing.
//   SEAM_SIGNER=<seed | file> node scripts/testnet-run.mjs RPC_URL --yes
//       The report, then deploys the demo contract through SEAM, then runs sequential, rollback and atomic,
//       writing sanitized recordings (addresses, tx hashes, events) under --out.
//
// Options: --yes (required before anything is signed or sent)   --out DIR (default evidence/testnet-v3)
//   --asset-id N (default: a free id is picked and created)     --contract 0x.. (use a deployed seam_demo)
//   --external SS58_ADDRESS [--port N]   sign in a browser wallet (polkadot.js extension) instead of SEAM_SIGNER: opens a local
//     page on 127.0.0.1, prints its URL, and every transaction waits for your approval in the extension
//   --no-deploy   --only sequential,rollback,atomic   --types FILE   --block-time-ms N
//   --token SYMBOL:DECIMALS (only if the node reports no token; same flag as `seam compile`)
// Env: SEAM_SIGNER (seed phrase, secret URI, or path to a file / polkadot-js JSON keystore; never printed or saved),
//   SEAM_SIGNER_PASSWORD (keystore password), SEAM_SIGNER_SCHEME (sr25519 default | ed25519 | ecdsa).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startBridge } from './external-signer/bridge-server.mjs';
import {
  assertNotMainnetUrl, assertNotMainnetFacts, loadSigner, payloadSigner, runtimeReport, deployThroughSeam, ensureAsset,
  freshRecipients, fundRecipients, runAllFlows, makeGuard, makeSaver
} from './seam-run.mjs';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);
const FLAGS_WITH_VALUE = new Set(['--out', '--asset-id', '--contract', '--only', '--types', '--block-time-ms', '--token', '--external', '--port']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !FLAGS_WITH_VALUE.has(argv[i - 1]));
const rpc = positional[0];
if (!rpc || has('--help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(rpc ? 0 : 2); }
if (!/^wss?:\/\//.test(rpc)) { console.error('RPC_URL must start with ws:// or wss://'); process.exit(2); }
assertNotMainnetUrl(rpc);

const outDir = flag('--out') ?? fileURLToPath(new URL('../../../evidence/testnet-v3', import.meta.url));
const tok = flag('--token')?.match(/^([^:]+):(\d+)$/);
if (flag('--token') && !tok) { console.error('--token must look like SYMBOL:DECIMALS, e.g. UNIT:12'); process.exit(2); }
const declaredToken = tok ? { tokenSymbol: tok[1], tokenDecimals: Number(tok[2]) } : undefined;
const discoverOpts = { ...(flag('--types') ? { typesBundle: readFileSync(flag('--types'), 'utf8') } : {}), ...(declaredToken ? { declaredToken } : {}) };
const env = { ...(flag('--types') ? { typesBundle: discoverOpts.typesBundle } : {}), ...(declaredToken ? { declaredToken } : {}), ...(flag('--block-time-ms') ? { blockTimeMs: Number(flag('--block-time-ms')) } : {}) };

const externalAddress = flag('--external');
const signer = externalAddress ? undefined : await loadSigner();
if (externalAddress && process.env.SEAM_SIGNER) { console.error('Use either --external or SEAM_SIGNER, not both.'); process.exit(2); }
const guard = makeGuard(signer?.secrets ?? []);
const save = makeSaver(outDir, guard);
const log = (m) => console.log(m);

const { facts, report } = await runtimeReport(rpc, discoverOpts);
report.endpoint = rpc;
console.log(report.summary);
console.log(`runtime report: ${save('runtime-report.json', report)}`);

if (!signer && !externalAddress) { console.log('SEAM_SIGNER is not set (and no --external): read-only run, nothing signed.'); process.exit(0); }
if (!has('--yes')) { console.error('A signer is configured but --yes is missing. Nothing was signed or sent. Re-run with --yes to deploy and run the flows.'); process.exit(3); }

const ss58 = facts.fingerprint.ss58Prefix;
const address = signer ? signer.addressFor(ss58) : externalAddress;
log(`signer address (public): ${address}`);
let bridge;
if (externalAddress) {
  bridge = await startBridge({ address, port: flag('--port') ? Number(flag('--port')) : 0 });
  console.log(`\nOpen this page in the browser that has the polkadot.js extension (unlocked, with ${address}):\n  ${bridge.url}\nClick "Connect extension and start", then approve each request in the extension popup.\n`);
  await bridge.waitForWallet();
  log('wallet page connected');
}
const signPayloadFor = (f) => (bridge ? (payload) => bridge.signPayload(payload) : payloadSigner(signer, f));
const summary = { kind: 'testnet-run', signedBy: externalAddress ? 'external wallet via local bridge' : 'SEAM_SIGNER (local key)', startedAt: new Date().toISOString(), endpoint: rpc, genesisHash: facts.fingerprint.genesisHash, specVersion: facts.fingerprint.specVersion, signer: address };

const assetId = flag('--asset-id') ? Number(flag('--asset-id')) : 100000 + Math.floor(Math.random() * 900000);
summary.assetId = assetId;
summary.assetSetup = (await ensureAsset({ endpoint: rpc, facts, signPayload: signPayloadFor(facts), address, assetId, log })).map(({ what, txHash, status, success, events }) => ({ what, txHash, status, success, events }));

let contract = flag('--contract');
if (!contract && !has('--no-deploy')) {
  const d = await deployThroughSeam({ endpoint: rpc, facts, signPayload: signPayloadFor(facts), address });
  summary.deploy = { ok: d.ok, contract: d.contract, txHash: d.txHash, block: d.block, status: d.status, dryRun: d.dryRun, refused: d.refused, error: d.error, dispatchError: d.dispatchError, codeHash: d.codeHash, constructor: d.constructor };
  save(`runs/deploy-${Date.now()}.json`, { kind: 'deploy', ranAt: new Date().toISOString(), signer: address, ...summary.deploy, events: d.events });
  if (!d.ok) { save('testnet-summary.json', summary); console.error('deploy failed:', JSON.stringify(summary.deploy)); process.exit(1); }
  contract = d.contract;
  log(`deployed seam_demo at ${contract} (tx ${d.txHash})`);
}
if (!contract) { save('testnet-summary.json', summary); console.error('no contract: pass --contract 0x.. or drop --no-deploy'); process.exit(1); }
summary.contract = contract;

const recipients = await freshRecipients(ss58);
summary.recipients = recipients;
summary.recipientFunding = (await fundRecipients({ endpoint: rpc, facts, signPayload: signPayloadFor(facts), address, recipients })).map(({ what, txHash, status, success }) => ({ what, txHash, status, success }));
summary.flows = await runAllFlows({ endpoint: rpc, discoverOpts, signer, signPayloadFor, address, assetId, contract, recipients, env, save, log, only: flag('--only')?.split(',') });
summary.finishedAt = new Date().toISOString();
console.log(`summary: ${save('testnet-summary.json', summary)}`);
console.log(JSON.stringify(summary.flows, null, 1));
await bridge?.close();
