// Runs the REAL SEAM packages (compiler, policy, SDK) offline against the saved
// Portaldot node snapshot, and writes every result the console shows to
// src/demo/scenarios.json. Only the chain's replies (fees, tx hashes, events)
// are simulated, because nothing is broadcast yet; the console labels them.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from '@seam/compiler';
import { portaldotPolicy } from '@seam/policy';
import { Seam, defineManifest, action, factsFromSnapshot, explainPlan, explainPolicy, explainReceipt, parseManifest } from '@seam/sdk';

const fixtures = fileURLToPath(new URL('../../../fixtures', import.meta.url));
const facts = factsFromSnapshot(fixtures);
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ALICE_HEX = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const BOB_HEX = '0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48';

const manifest = (nft) => defineManifest({
  signer: { type: 'ss58', value: ALICE, ss58Prefix: 42 },
  actions: [
    action.transfer('pay', { assetId: '1', amount: '2500', recipient: BOB }),
    action.contractCall('settle', { contract: BOB, value: '0', gasLimit: '5000000000', data: '0x633aa551' }),
    ...(nft ? [{ id: 'receipt', kind: 'nfts.mint', args: { collection: '0', item: '1', recipient: BOB } }]
            : [action.mint('receipt', { assetId: '2', amount: '1', recipient: BOB })]),
  ],
});
const policy = portaldotPolicy({ allowedAssets: ['1', '2'], allowedContracts: [BOB], allowedRecipients: [BOB] });

const blk = (n) => ({ number: 2721460 + n, hash: `0x${(0xb10c00 + n).toString(16).padStart(64, '0')}` });
const tx = (s) => `0x${Buffer.from(s).toString('hex').padEnd(64, '0').slice(0, 64)}`;
const ev = (pallet, name, ...args) => ({ pallet, name, args });
const OK = ev('System', 'ExtrinsicSuccess', '{}');
const good = () => [
  { actionId: 'pay', status: 'finalized', txHash: tx('pay'), block: blk(1), events: [ev('Assets', 'Transferred', '1', ALICE_HEX, BOB_HEX, '2500'), OK] },
  { actionId: 'settle', status: 'finalized', txHash: tx('settle'), block: blk(3), events: [ev('Contracts', 'ContractEmitted', BOB_HEX, '0x01'), OK] },
  { actionId: 'receipt', status: 'finalized', txHash: tx('receipt'), block: blk(5), events: [ev('Assets', 'Issued', '2', BOB_HEX, '1'), OK] },
];
// Fees below are Bot 4's real live estimates from the Portaldot node (Oct 11).
// Bot 4's real payment_queryInfo results from the Portaldot mainnet node (Oct 11), base units.
const WEIGHTS = { pay: '567688000', settle: '5811203000', receipt: '295983000' };
const FEES = { pay: '1490125636184', settle: '1520000000000', receipt: '1420000000000' };
const chain = (outcomes, fingerprintAfter) => ({
  discover: async () => facts,
  readFingerprint: async () => fingerprintAfter ?? facts.fingerprint,
  preflight: async (plan) => ({
    preflight: { steps: plan.steps.map((s) => ({ actionId: s.actionId, weight: { value: WEIGHTS[s.actionId] }, fee: { value: FEES[s.actionId] }, storageDeposit: { unknown: true }, dryRun: 'ok' })), totalFee: { value: '4430125636184' } },
    envelope: { signer: ALICE, nonce: 7, mortalityBlocks: 64, checkpoint: { number: 2721455, hash: '0x739ac186fb1c9da824a064361e5b6c533462dfeba1a8e620875d4626c39194e9' }, expiresAt: new Date(Date.now() + 600_000).toISOString() },
  }),
  dryRunSigned: async (txs) => txs.map(() => 'ok'),
  submit: async (_t, id) => outcomes.find((o) => o.actionId === id) ?? { actionId: id, status: 'not_run', events: [] },
});
const wallet = { sign: async (calls) => calls.map((c) => ({ signedTx: c, signedCall: c })) };

async function run(id, { nft = false, outcomes = good(), fingerprintAfter } = {}) {
  const m = manifest(nft);
  const parsed = parseManifest(m);
  const plan = compile(m, facts);
  const seam = new Seam(chain(outcomes, fingerprintAfter));
  const out = { id, manifest: m, manifestDigest: parsed.ok ? parsed.digest : null, plan, planText: explainPlan(plan) };
  if (plan.mode === 'unavailable') return out;
  const p = await seam.prepare(m, facts, policy);
  Object.assign(out, { preflight: p.preflight, envelope: p.envelope, policyResult: p.policyResult, policyText: explainPolicy(p.policyResult) });
  if (!p.policyResult.allowed) return out;
  const a = seam.approve({ ...p, policy, facts });
  if (!a.ok) { out.approvalError = a.reason; return out; }
  out.approval = a.approval;
  const r = await seam.execute({ ...p, policy, facts, approval: a.approval, wallet });
  out.run = r;
  if (r.ok) out.receiptText = explainReceipt(r.receipt);
  if (!r.ok) out.fingerprintNow = fingerprintAfter;
  return out;
}

const failed = good().slice(0, 2);
failed[1] = { actionId: 'settle', status: 'failed', txHash: tx('settle'), block: blk(3), events: [ev('System', 'ExtrinsicFailed', 'Module', '{}')], error: 'Contracts.ContractTrapped' };

const scenarios = {
  generatedAt: new Date().toISOString(),
  facts,
  happy: await run('happy'),
  nft: await run('nft', { nft: true }),
  upgrade: await run('upgrade', { fingerprintAfter: { ...facts.fingerprint, specVersion: 1003 } }),
  fail: await run('fail', { outcomes: failed }),
};
const json = JSON.stringify(scenarios, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v), 2);
writeFileSync(fileURLToPath(new URL('../src/demo/scenarios.json', import.meta.url)), json);
console.log('wrote scenarios.json', (json.length / 1024).toFixed(1), 'KB');
