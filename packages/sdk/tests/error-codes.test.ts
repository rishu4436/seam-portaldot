import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type Hex } from '@seam/compiler';
import {
  action, buildReceipt, classifyError, classifyReceipt, defineManifest, EXIT, factsFromSnapshot, GATE_CODES, receiptDigest, SeamCode, NEXT_ACTION,
  type ChainEvent, type StepOutcome,
} from '../src/index.js';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ALICE_HEX = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const BOB_HEX = '0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48';
const facts = factsFromSnapshot(fileURLToPath(new URL('./fixtures', import.meta.url)));
const manifest = defineManifest({ signer: { type: 'ss58', value: ALICE, ss58Prefix: 42 }, actions: [
  action.transfer('pay', { assetId: '1', amount: '2500', recipient: BOB }), action.mint('receipt', { assetId: '2', amount: '1', recipient: BOB })] });
const plan = compile(manifest, facts);
const ev = (pallet: string, name: string, ...args: string[]): ChainEvent => ({ pallet, name, args });
const SUCCESS = ev('System', 'ExtrinsicSuccess', '{}');
const blk = { number: 1, hash: ('0x' + '01'.repeat(32)) as Hex };
const pay: StepOutcome = { actionId: 'pay', status: 'finalized', txHash: '0xaa', block: blk, events: [ev('Assets', 'Transferred', '1', ALICE_HEX, BOB_HEX, '2500'), SUCCESS] };
const mint: StepOutcome = { actionId: 'receipt', status: 'finalized', txHash: '0xbb', block: blk, events: [ev('Assets', 'Issued', '2', BOB_HEX, '1'), SUCCESS] };

describe('SEAM-022 outcome classification: no ambiguous success', () => {
  it('verified run is the only one with exit 0 among execution outcomes', () => {
    expect(classifyReceipt(buildReceipt({ plan, outcomes: [pay, mint] })).code).toBe(SeamCode.Verified);
    const codes = [
      classifyReceipt(buildReceipt({ plan, outcomes: [pay] })),                                              // partial
      classifyReceipt(buildReceipt({ plan, outcomes: [pay, { ...mint, status: 'included' }] })),             // not verified
      classifyReceipt(buildReceipt({ plan, outcomes: [pay, { ...mint, status: 'uncertain', events: [] }] })), // uncertain
      classifyReceipt(buildReceipt({ plan, outcomes: [pay, { ...mint, status: 'failed', events: [] }] })),    // failed
    ];
    expect(codes.map((c) => c.code)).toEqual([SeamCode.Partial, SeamCode.NotVerified, SeamCode.Uncertain, SeamCode.TxFailed]);
    expect(codes.every((c) => c.exitCode !== 0)).toBe(true);
    expect(codes.every((c) => c.nextAction.length > 10)).toBe(true);
  });
  it('uncertain says never to retry', () => {
    expect(NEXT_ACTION[SeamCode.Uncertain]).toMatch(/do not retry/i);
  });
  it('every code has an exit code and a next action; only the ok family exits 0', () => {
    for (const c of Object.values(SeamCode)) {
      expect(EXIT[c]).toBeTypeOf('number');
      expect(NEXT_ACTION[c]).toBeTruthy();
    }
    const zero = Object.values(SeamCode).filter((c) => EXIT[c] === 0).sort();
    expect(zero).toEqual(['chain_verified', 'integrity_checked', 'ok', 'verified']);
  });
  it('lists the policy gate codes', () => {
    expect(GATE_CODES).toEqual(expect.arrayContaining(['signed_signer_mismatch', 'signed_nonce_mismatch', 'signed_chain_mismatch', 'trusted_decoder_required', 'signed_dry_run_not_checked']));
  });
  it('sorts thrown errors', () => {
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:9944'))).toBe(SeamCode.RpcTransport);
    expect(classifyError(new Error('missing manifest file'))).toBe(SeamCode.UsageError);
    expect(classifyError(new Error('boom'))).toBe(SeamCode.InternalError);
  });
});

describe('SEAM-022 receipts: finalized needs a tx hash and block', () => {
  it('a finalized step without them is not verified', () => {
    const r = buildReceipt({ plan, outcomes: [{ ...pay, txHash: undefined }, mint] });
    expect(r.steps[0]!.verification).toBe('not_verified');
    expect(r.steps[0]!.code).toBe('no_trace');
  });
});

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'seam-golden-'));
const file = (name: string, v: unknown) => { const f = join(tmp, name); writeFileSync(f, JSON.stringify(v)); return f; };
const run = (...a: string[]) => spawnSync('node', [cli, ...a], { encoding: 'utf8' });
const asReceipt = (r: unknown) => { const x = r as { receiptDigest: string }; x.receiptDigest = receiptDigest(x as never); return x; };

describe.skipIf(!existsSync(cli))('SEAM-022 golden CLI scenarios (needs a built dist)', () => {
  it('invalid manifest: exit 2, code manifest_invalid in --json', () => {
    const o = run('digest', file('bad.json', { version: 1, actions: [] }), '--json');
    expect(o.status).toBe(2);
    expect(JSON.parse(o.stdout).code).toBe('manifest_invalid');
  });
  it('unavailable plan: exit 3 and code plan_unavailable', () => {
    const m = file('nft.json', { version: 1, signer: { type: 'ss58', value: ALICE }, actions: [{ id: 'nft', kind: 'nfts.mint', args: { collection: '0', item: '1', recipient: BOB } }] });
    const o = run('compile', m, '--json');
    expect(o.status).toBe(3);
    expect(JSON.parse(o.stdout).code).toBe('plan_unavailable');
  });
  it('verified receipt exits 0; partial exits 7; uncertain exits 6; edited exits 5', () => {
    const v = run('verify', file('v.json', buildReceipt({ plan, outcomes: [pay, mint] })), '--json');
    expect([v.status, JSON.parse(v.stdout).outcome.code]).toEqual([0, 'verified']);
    const p = run('verify', file('p.json', buildReceipt({ plan, outcomes: [pay] })), '--json');
    expect([p.status, JSON.parse(p.stdout).outcome.code]).toEqual([7, 'partial']);
    const u = run('verify', file('u.json', buildReceipt({ plan, outcomes: [pay, { ...mint, status: 'uncertain', events: [] }] })), '--json');
    expect([u.status, JSON.parse(u.stdout).outcome.code]).toEqual([6, 'uncertain']);
    const e = run('verify', file('e.json', { ...buildReceipt({ plan, outcomes: [pay, mint] }), result: 'partial' }), '--json');
    expect([e.status, JSON.parse(e.stdout).code]).toEqual([5, 'integrity_failed']);
    expect(asReceipt).toBeTypeOf('function');
  });
  it('unreachable node: exit 9 rpc_transport', () => {
    const o = run('compile', file('m.json', manifest), '--endpoint', 'ws://127.0.0.1:1', '--json');
    expect(o.status).toBe(9);
  });
});
