// One-time dev-chain setup as //Alice (LOCAL DEV CHAIN ONLY): create asset 1, mint to Alice,
// upload + instantiate the seam_emitter contract. Idempotent: skips what already exists.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { u8aToHex } from '@polkadot/util';
import { withClient, decodeRuntime } from '../../dist/index.js';
import { ENDPOINT, EVIDENCE, ASSET_ID, STATE_FILE, devFacts, devKeys, encodeCall, sendSigned, saveJson, loadState, brief } from './lib.mjs';

const facts = await devFacts();
const { alice } = await devKeys();
const state = loadState();
const log = { setupAt: new Date().toISOString(), genesis: facts.fingerprint.genesisHash, steps: [] };
const dec = decodeRuntime(facts);

async function storage(key) { return withClient(ENDPOINT, (c) => c.send('state_getStorage', [key])); }
const assetKey = u8aToHex(dec.decorated().query.assets.asset(ASSET_ID));

if (!(await storage(assetKey))) {
  const create = encodeCall(facts, 'Assets', 'create', [ASSET_ID, { Id: alice.address }, 1]);
  const r = await sendSigned(facts, alice, create);
  log.steps.push({ what: `Assets.create(${ASSET_ID}, Alice, min_balance 1)`, ...brief(r) });
  if (r.status !== 'finalized' || !r.inclusion?.success) throw new Error('create failed: ' + JSON.stringify(brief(r)));
  const mint = encodeCall(facts, 'Assets', 'mint', [ASSET_ID, { Id: alice.address }, '1000000000000']);
  const m = await sendSigned(facts, alice, mint);
  log.steps.push({ what: `Assets.mint(${ASSET_ID}, Alice, 1000000000000)`, ...brief(m) });
  if (m.status !== 'finalized' || !m.inclusion?.success) throw new Error('mint failed');
} else log.steps.push({ what: `asset ${ASSET_ID} already exists, skipped create/mint` });

if (!state.contract || state.genesis !== facts.fingerprint.genesisHash || !(await storage(u8aToHex(dec.decorated().query.contracts.contractInfoOf(state.contract))))) {
  const wasm = readFileSync(fileURLToPath(new URL('../../fixtures/devnode/seam_emitter.wasm', import.meta.url)));
  const inst = encodeCall(facts, 'Contracts', 'instantiate_with_code', [
    0, { refTime: 50_000_000_000n, proofSize: 1_000_000n }, null, u8aToHex(wasm), '0x', u8aToHex(new TextEncoder().encode(`seam-${Date.now()}`))
  ]);
  const r = await sendSigned(facts, alice, inst);
  log.steps.push({ what: 'Contracts.instantiate_with_code(seam_emitter.wasm)', ...brief(r) });
  const ev = r.inclusion?.events.find((e) => e.pallet === 'Contracts' && e.name === 'Instantiated');
  if (!ev) throw new Error('instantiate failed: ' + JSON.stringify(brief(r)));
  state.contract = ev.args[1];
  state.contractInstantiatedIn = { txHash: r.txHash, block: r.inclusion.number, blockHash: r.inclusion.hash };
} else log.steps.push({ what: `contract ${state.contract} already deployed, skipped` });

state.genesis = facts.fingerprint.genesisHash;
state.assetId = ASSET_ID;
saveJson(STATE_FILE, state);
saveJson(`${EVIDENCE}/runs/setup-${Date.now()}.json`, { ...log, state });
console.log(JSON.stringify({ state, log }, null, 1));
