// One-time dev-chain setup as //Alice (LOCAL DEV CHAIN ONLY): create asset 1, mint to Alice,
// upload + instantiate the seam_emitter contract. Idempotent: skips what already exists.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { u8aToHex, hexToU8a } from '@polkadot/util';
import { withClient, decodeRuntime, storageKey, signBytesOf } from '../../dist/index.js';
import { deployThroughSeam } from '../seam-run.mjs';
import { ENDPOINT, ASSET_ID, devFacts, devKeys, encodeCall, sendSigned, saveEvidence, loadState, brief } from './lib.mjs';

const facts = await devFacts();
const { alice } = await devKeys();
const state = loadState();
const log = { setupAt: new Date().toISOString(), genesis: facts.fingerprint.genesisHash, steps: [] };
const dec = decodeRuntime(facts);

async function storage(key) { return withClient(ENDPOINT, (c) => c.send('state_getStorage', [key])); }
const assetKey = storageKey(dec.decorated().query.assets.asset, ASSET_ID);

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

// Bot 2's demo ink! contract (contracts/seam-demo/artifacts/seam_demo.contract, ink! 5.1.1). Constructor `new` = 0x9bae9d5e.
const CONTRACT_FILE = fileURLToPath(new URL('../../../../contracts/seam-demo/artifacts/seam_demo.contract', import.meta.url));
const bundle = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));
const ctor = bundle.spec.constructors.find((c) => c.label === 'new');
const wasmHex = bundle.source.wasm;
const codeHash = bundle.source.hash;
const stillThere = state.contract && state.contractCodeHash === codeHash && state.genesis === facts.fingerprint.genesisHash
  && (await storage(storageKey(dec.decorated().query.contracts.contractInfoOf, state.contract)));
if (!stillThere) {
  if (state.contract && state.contractCodeHash !== codeHash) state.previousContract = { address: state.contract, note: 'seam_emitter.wat test contract, replaced by seam_demo' };
  // Same deployment helper testnet-run.mjs uses: signing request -> signer -> verified assemble -> signed dry run -> submit.
  const signPayload = async (payload) => ({ signature: u8aToHex(alice.sign(hexToU8a(signBytesOf(payload, facts)), { withType: true })) });
  const d = await deployThroughSeam({ endpoint: ENDPOINT, facts, signPayload, address: alice.address, bundlePath: CONTRACT_FILE });
  log.steps.push({ what: `Contracts.instantiate_with_code(seam_demo.contract, constructor new ${ctor.selector}, storage_deposit_limit null), via deployThroughSeam`, codeHash, txHash: d.txHash, status: d.status, success: d.success, dryRun: d.dryRun, events: d.events });
  if (!d.ok) throw new Error('instantiate failed: ' + JSON.stringify({ refused: d.refused, error: d.error, dispatchError: d.dispatchError }));
  const r = { txHash: d.txHash, inclusion: { number: d.block?.number, hash: d.block?.hash } };
  const ev = { args: [null, d.contract] };
  state.contract = ev.args[1];
  state.contractName = 'seam_demo';
  state.contractCodeHash = codeHash;
  state.contractAbi = 'contracts/seam-demo/artifacts/metadata.json';
  state.contractInstantiatedIn = { txHash: r.txHash, block: r.inclusion.number, blockHash: r.inclusion.hash };
} else log.steps.push({ what: `contract ${state.contract} (seam_demo) already deployed, skipped` });

state.genesis = facts.fingerprint.genesisHash;
state.assetId = ASSET_ID;
saveEvidence('state.json', state);
saveEvidence(`runs/setup-${Date.now()}.json`, { ...log, state });
console.log(JSON.stringify({ state, log }, null, 1));
