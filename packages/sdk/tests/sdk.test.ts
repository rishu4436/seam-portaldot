import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { compile, type Hex, type Plan, type RuntimeFacts } from '@seam/compiler';
import { definePolicy, type SignedDryRun, type SigningEnvelope } from '@seam/policy';
import {
  Seam, buildReceipt, checkReceipt, defineManifest, action, explainPlan, explainPolicy, explainReceipt, factsFromSnapshot,
  parseManifest, toBaseUnits, type ChainAdapter, type ChainEvent, type StepOutcome, type WalletSigner,
} from '../src/index.js';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ALICE_HEX = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const BOB_HEX = '0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48';
const facts = factsFromSnapshot(fileURLToPath(new URL('./fixtures', import.meta.url)));

const demo = () => defineManifest({
  signer: { type: 'ss58', value: ALICE, ss58Prefix: 42 },
  actions: [
    action.transfer('pay', { assetId: '1', amount: '2500', recipient: BOB }),
    action.contractCall('call', { contract: BOB, value: '0', gasLimit: '5000000000', data: '0x633aa551' }),
    action.mint('receipt', { assetId: '2', amount: '1', recipient: BOB }),
  ],
});

const ok = (n: number): StepOutcome['block'] => ({ number: n, hash: (`0x${n.toString(16).padStart(64, '0')}`) as Hex });
const ev = (pallet: string, name: string, ...args: string[]): ChainEvent => ({ pallet, name, args });
const SUCCESS = ev('System', 'ExtrinsicSuccess', '{}');
const goodOutcomes = (): StepOutcome[] => [
  { actionId: 'pay', status: 'finalized', txHash: '0xaa', block: ok(1), events: [ev('Assets', 'Transferred', '1', ALICE_HEX, BOB_HEX, '2500'), SUCCESS] },
  { actionId: 'call', status: 'finalized', txHash: '0xbb', block: ok(2), events: [ev('Contracts', 'ContractEmitted', BOB_HEX, '0x01'), SUCCESS] },
  { actionId: 'receipt', status: 'finalized', txHash: '0xcc', block: ok(3), events: [ev('Assets', 'Issued', '2', BOB_HEX, '1'), SUCCESS] },
];

describe('Manifest', () => {
  it('accepts the demo Manifest and gives a stable digest', () => {
    const a = parseManifest(JSON.stringify(demo()));
    const b = parseManifest(demo());
    expect(a.ok && b.ok && a.digest === b.digest).toBe(true);
  });
  it('gives the same digest regardless of key order', () => {
    const m = demo();
    const reordered = { actions: m.actions, signer: m.signer, version: 1 };
    const a = parseManifest(m), b = parseManifest(reordered);
    expect(a.ok && b.ok && a.digest === b.digest).toBe(true);
  });
  it('rejects float and number amounts, duplicate ids, unknown kinds and stray fields with plain messages', () => {
    const r = parseManifest({ version: 1, signer: { type: 'ss58', value: ALICE }, extra: 1, actions: [
      { id: 'a', kind: 'assets.transfer', args: { assetId: '1', amount: 2.5, recipient: BOB } },
      { id: 'a', kind: 'assets.burn', args: {} },
    ] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['$.extra', '$.actions[0].args.amount', '$.actions[1].id', '$.actions[1].kind']));
  });
  it('rejects bad JSON and an empty action list', () => {
    expect(parseManifest('{nope').ok).toBe(false);
    expect(parseManifest({ version: 1, signer: { type: 'ss58', value: ALICE }, actions: [] }).ok).toBe(false);
  });
  it('converts human amounts to base units without floats', () => {
    expect(toBaseUnits('2.5', 14)).toBe('250000000000000');
    expect(toBaseUnits('0.00000000000001', 14)).toBe('1');
    expect(toBaseUnits('7', 0)).toBe('7');
    expect(() => toBaseUnits('0.000000000000001', 14)).toThrow(/decimal places/);
    expect(() => toBaseUnits('-1', 14)).toThrow();
  });
});

describe('Receipt', () => {
  const plan = compile(demo(), facts);

  it('is verified when every step finalized with exactly the planned events', () => {
    const r = buildReceipt({ plan, outcomes: goodOutcomes(), policyDigest: '0x01', approvalHash: '0x02' });
    expect(r.result).toBe('verified');
    expect(r.coverage).toEqual({ verified: 3, expected: 3 });
    expect(r.approvalHash).toBe('0x02');
    expect(checkReceipt(r)).toBe(true);
  });
  it('attack 9: step 2 fails, step 3 never runs, the receipt is partial', () => {
    const o = goodOutcomes().slice(0, 2);
    o[1] = { actionId: 'call', status: 'failed', txHash: '0xbb', block: ok(2), events: [ev('System', 'ExtrinsicFailed', 'Module', '{}')], error: 'Contracts.ContractTrapped' };
    const r = buildReceipt({ plan, outcomes: o });
    expect(r.result).toBe('partial');
    expect(r.steps.map((s) => s.status)).toEqual(['finalized', 'failed', 'not_run']);
    expect(r.steps[1]!.reason).toContain('ContractTrapped');
  });
  it('attack 11: success with a missing or different event is not verified', () => {
    const wrongAmount = goodOutcomes();
    wrongAmount[0]!.events = [ev('Assets', 'Transferred', '1', ALICE_HEX, BOB_HEX, '9999'), SUCCESS];
    expect(buildReceipt({ plan, outcomes: wrongAmount }).steps[0]!.verification).toBe('not_verified');
    const noEvent = goodOutcomes();
    noEvent[2]!.events = [SUCCESS];
    const r = buildReceipt({ plan, outcomes: noEvent });
    expect(r.steps[2]!.verification).toBe('not_verified');
    expect(r.result).toBe('not_verified');
  });
  it('a contract call with no event is unknown, not verified', () => {
    const o = goodOutcomes();
    o[1]!.events = [SUCCESS];
    expect(buildReceipt({ plan, outcomes: o }).steps[1]!.verification).toBe('unknown');
  });
  it('a step only included, not finalized, is not counted as verified', () => {
    const o = goodOutcomes();
    o[0]!.status = 'included';
    const r = buildReceipt({ plan, outcomes: o });
    expect(r.steps[0]!.verification).toBe('unknown');
    expect(r.result).toBe('not_verified');
  });
  it('detects a receipt edited after the fact', () => {
    const r = buildReceipt({ plan, outcomes: goodOutcomes() });
    expect(checkReceipt({ ...r, result: 'verified', coverage: { verified: 3, expected: 3 } })).toBe(true);
    const failed = buildReceipt({ plan, outcomes: goodOutcomes().slice(0, 1) });
    expect(checkReceipt({ ...failed, result: 'verified' })).toBe(false);
  });
});

describe('Explanations', () => {
  it('say why a plan cannot run, in plain words', () => {
    const m = demo();
    m.actions.push({ id: 'nft', kind: 'nfts.mint', args: { collection: '0', item: '1', recipient: BOB } });
    const text = explainPlan(compile(m, facts));
    expect(text).toContain('cannot run on this chain');
    expect(text).toContain("nft: can't run, because Nfts.mint is not on this runtime (spec 1002)");
  });
  it('list each policy block', () => {
    const plan = compile(demo(), facts);
    const text = explainPolicy({ allowed: false, policyDigest: '0x00', rules: [{ rule: 'recipient', outcome: 'block', reason: 'recipient not allowed', actionId: 'pay' }] });
    expect(text).toMatch(/Blocked by policy/);
    expect(text).toContain('pay: recipient not allowed');
    expect(plan.mode).toBe('sequential');
  });
  it('summarise a receipt', () => {
    const plan = compile(demo(), facts);
    expect(explainReceipt(buildReceipt({ plan, outcomes: goodOutcomes() }))).toMatch(/^Verified: all 3 steps/);
  });
});

// ---- End-to-end flow with a fake chain and wallet ----
const policy = definePolicy({
  allowedAssets: ['1', '2'], allowedContracts: [BOB], allowedRecipients: [BOB],
  allowUnknown: { storageDeposit: true },
});

function fakeChain(f: RuntimeFacts, opts: { outcomes?: StepOutcome[]; fingerprintAfter?: RuntimeFacts['fingerprint']; changeAfterSubmits?: number; dryRun?: SignedDryRun } = {}) {
  const submitted: string[] = [];
  const outs = opts.outcomes ?? goodOutcomes();
  const chain: ChainAdapter = {
    discover: async () => f,
    readFingerprint: async () => (opts.fingerprintAfter && submitted.length >= (opts.changeAfterSubmits ?? 0) ? opts.fingerprintAfter : f.fingerprint),
    preflight: async (plan: Plan) => ({
      preflight: { steps: plan.steps.map((s) => ({ actionId: s.actionId, weight: { value: '1000' }, fee: { value: '10' }, storageDeposit: { unknown: true }, dryRun: 'ok' as const })), totalFee: { value: '30' } },
      envelope: { signer: ALICE, nonce: 7, mortalityBlocks: 64, expiresAt: new Date(Date.now() + 300_000).toISOString(), checkpoint: { number: 100, hash: `0x${'ab'.repeat(32)}` } } satisfies SigningEnvelope,
    }),
    dryRunSigned: async (txs: Hex[]) => txs.map((_, i) => (i === 0 ? (opts.dryRun ?? 'ok') : 'unknown')),
    submit: async (tx: Hex, id: string) => { submitted.push(id); return outs.find((o) => o.actionId === id) ?? { actionId: id, status: 'not_run', events: [] }; },
  };
  return { chain, submitted };
}
const honestWallet: WalletSigner = { sign: async (calls) => calls.map((c) => ({ signedTx: c, signedCall: c })) };

async function prepared(seam: Seam, f: RuntimeFacts = facts) {
  const p = await seam.prepare(demo(), f, policy);
  const a = seam.approve({ ...p, policy, facts: f });
  if (!a.ok) throw new Error(a.reason);
  return { ...p, approval: a.approval };
}

describe('Seam flow', () => {
  it('runs the demo flow end to end and returns a verified receipt', async () => {
    const { chain, submitted } = fakeChain(facts);
    const seam = new Seam(chain);
    const p = await prepared(seam);
    expect(p.policyResult.allowed).toBe(true);
    const run = await seam.execute({ ...p, policy, facts, wallet: honestWallet });
    expect(run.ok && run.receipt.result).toBe('verified');
    expect(submitted).toEqual(['pay', 'call', 'receipt']);
  });
  it('refuses to reuse an approval', async () => {
    const { chain } = fakeChain(facts);
    const seam = new Seam(chain);
    const p = await prepared(seam);
    await seam.execute({ ...p, policy, facts, wallet: honestWallet });
    const again = await seam.execute({ ...p, policy, facts, wallet: honestWallet });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toMatch(/already (used|sent)/);
  });
  it('blocks when the runtime changed after approval, and submits nothing', async () => {
    const { chain, submitted } = fakeChain(facts, { fingerprintAfter: { ...facts.fingerprint, specVersion: 1003 } });
    const seam = new Seam(chain);
    const p = await prepared(seam);
    const run = await seam.execute({ ...p, policy, facts, wallet: honestWallet });
    expect(run.ok).toBe(false);
    expect(submitted).toEqual([]);
  });
  it('blocks when the wallet signs different bytes', async () => {
    const { chain, submitted } = fakeChain(facts);
    const seam = new Seam(chain);
    const p = await prepared(seam);
    const evil: WalletSigner = { sign: async (calls) => calls.map((c, i) => ({ signedTx: c, signedCall: (i === 0 ? c.slice(0, -2) + '00' : c) as Hex })) };
    const run = await seam.execute({ ...p, policy, facts, wallet: evil });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toMatch(/signed different call data/);
    expect(submitted).toEqual([]);
  });
  it('blocks when the signed transaction fails its dry run, and submits nothing', async () => {
    const { chain, submitted } = fakeChain(facts, { dryRun: 'failed' });
    const seam = new Seam(chain);
    const run = await seam.execute({ ...(await prepared(seam)), policy, facts, wallet: honestWallet });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toMatch(/dry run of the signed transaction failed/);
    expect(submitted).toEqual([]);
  });
  it('blocks when the dry run result is unknown (policy requires one)', async () => {
    const { chain, submitted } = fakeChain(facts, { dryRun: 'unknown' });
    const seam = new Seam(chain);
    const run = await seam.execute({ ...(await prepared(seam)), policy, facts, wallet: honestWallet });
    expect(run.ok).toBe(false);
    expect(submitted).toEqual([]);
  });
  it('dry-runs and gates each sequential step just before sending it, in order', async () => {
    const { chain } = fakeChain(facts);
    const seam = new Seam(chain);
    const p = await prepared(seam);
    const log: string[] = [];
    const run = await seam.execute({ ...p, policy: { ...policy, requireSignedDryRun: true }, facts, wallet: honestWallet, onStep: (e) => log.push(`${e.actionId}:${e.phase}`) });
    expect(run.ok && run.receipt.result).toBe('verified');
    expect(log).toEqual(['pay:checking', 'pay:sending', 'pay:done', 'call:checking', 'call:sending', 'call:done', 'receipt:checking', 'receipt:sending', 'receipt:done']);
  });
  it('a runtime upgrade between steps stops the run with a partial receipt', async () => {
    const { chain, submitted } = fakeChain(facts, { fingerprintAfter: { ...facts.fingerprint, specVersion: 1003 }, changeAfterSubmits: 1 });
    const seam = new Seam(chain);
    const run = await seam.execute({ ...(await prepared(seam)), policy, facts, wallet: honestWallet });
    expect(submitted).toEqual(['pay']);
    expect(run.ok && run.receipt.result).toBe('partial');
    if (run.ok) { expect(run.stoppedReason).toMatch(/stopped before sending it/); expect(run.receipt.steps[1]!.reason).toMatch(/^Not run\. SEAM stopped before sending it: .*runtime/i); }
  });
  it('a step whose own dry run fails is never sent, and the receipt says why', async () => {
    let n = 0;
    const { chain, submitted } = fakeChain(facts);
    chain.dryRunSigned = async (txs) => txs.map(() => (n++ === 1 ? 'failed' : 'ok'));
    const seam = new Seam(chain);
    const run = await seam.execute({ ...(await prepared(seam)), policy, facts, wallet: honestWallet });
    expect(submitted).toEqual(['pay']);
    expect(run.ok && run.receipt.result).toBe('partial');
    if (run.ok) expect(run.receipt.steps[1]!.reason).toMatch(/dry run of the signed transaction failed/);
  });
  it('stops after a failed step and never submits the next one', async () => {
    const o = goodOutcomes();
    o[1] = { actionId: 'call', status: 'failed', txHash: '0xbb', block: ok(2), events: [ev('System', 'ExtrinsicFailed', 'Module', '{}')] };
    const { chain, submitted } = fakeChain(facts, { outcomes: o });
    const seam = new Seam(chain);
    const p = await prepared(seam);
    const run = await seam.execute({ ...p, policy, facts, wallet: honestWallet });
    expect(submitted).toEqual(['pay', 'call']);
    expect(run.ok && run.receipt.result).toBe('partial');
  });
  it('stops when a step succeeded but did the wrong thing', async () => {
    const o = goodOutcomes();
    o[0]!.events = [ev('Assets', 'Transferred', '1', ALICE_HEX, ALICE_HEX, '2500'), SUCCESS];
    const { chain, submitted } = fakeChain(facts, { outcomes: o });
    const seam = new Seam(chain);
    const p = await prepared(seam);
    const run = await seam.execute({ ...p, policy, facts, wallet: honestWallet });
    expect(submitted).toEqual(['pay']);
    expect(run.ok && run.receipt.result).toBe('partial');
  });
});
