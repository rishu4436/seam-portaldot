import { describe, expect, it, beforeAll } from 'vitest';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { assembleSignedExtrinsic, buildSigningRequests, preflight } from '../src/index.js';
import { FakeNode } from './fakeNode.js';
import { ALICE, CHECKPOINT, atomicPlan, demoPlan, devKeys, snapshotFacts, snapshotInputs } from './helpers.js';

const facts = snapshotFacts();
const node = (o: Partial<ConstructorParameters<typeof FakeNode>[0]> = {}) => new FakeNode({ inputs: snapshotInputs(), facts, ...o });

describe('preflight (fake node replaying the snapshot)', () => {
  it('returns the agreed PreflightResult with node-reported fee and weight, nonce from the node', async () => {
    const n = node({ existingAssets: ['1', '2'] });
    const r = await preflight(n, demoPlan(), facts);
    expect(r.nonce).toBe(0);
    expect(r.nonceSource).toBe('node');
    expect(r.atBlock.number).toBe(2721455);
    expect(r.result.steps.map((s) => s.actionId)).toEqual(['pay', 'call', 'receipt']);
    for (const s of r.result.steps) {
      expect(s.weight).toEqual({ value: '200000000' });
      expect(s.fee).toEqual({ value: '1500000000' });
      expect(s.storageDeposit).toEqual({ unknown: true });
    }
    expect(r.result.totalFee).toEqual({ value: '4500000000' });
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(['unknown', 'ok', 'unknown']);
    expect(r.transactions.map((t) => t.nonce)).toEqual([0, 1, 2]);
    // fee estimation used fake-signed extrinsics with consecutive nonces, never submitted
    expect(n.log.filter((c) => c.method === 'payment_queryInfo')).toHaveLength(3);
    expect(n.submitted).toHaveLength(0);
    const req = n.log.find((c) => c.method === 'contracts_call')!.params[0] as Record<string, string>;
    expect(req).toMatchObject({ origin: ALICE, value: '0x0', gasLimit: '0x12a05f200', inputData: '0x633aa551' });
  });

  it('marks failures from the node: missing assets and a contract dry-run error, decoded', async () => {
    const n = node({ contractsCall: { debugMessage: '', gasConsumed: 0, result: { Err: { Module: { index: 13, error: 12, message: null } } } } });
    const r = await preflight(n, demoPlan(), facts);
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(['failed', 'failed', 'failed']);
    expect(r.result.steps[0]!.note).toMatch(/asset 1 does not exist/);
    expect(r.result.steps[1]!.note).toMatch(/contracts\.ContractNotFound/);
  });

  it('a reverted contract (flags & 1) fails the dry run', async () => {
    const r = await preflight(node({ existingAssets: ['1', '2'], contractsCall: { gasConsumed: 5, result: { Ok: { flags: 1, data: '0x' } } } }), demoPlan(), facts);
    expect(r.result.steps[1]!.dryRun).toBe('failed');
  });

  it('atomic plans: the batch fee is the total; each step gets its standalone weight', async () => {
    const { plan, facts: f } = atomicPlan();
    const n = new FakeNode({ inputs: snapshotInputs(), facts: f, existingAssets: ['1', '2'] });
    const r = await preflight(n, plan, f);
    expect(r.transactions).toHaveLength(1);
    expect(r.result.totalFee).toEqual({ value: '1500000000' });
    expect(r.result.steps.every((s) => s.weight.value === '200000000' && /atomic/.test(s.note!))).toBe(true);
  });

  it('uses system_dryRun only with real signed extrinsics', async () => {
    const keys = await devKeys();
    const plan = demoPlan();
    const reqs = buildSigningRequests(plan, facts, { signer: ALICE, nonce: 0, mortalityBlocks: 64, expiresAt: 'x' }, CHECKPOINT);
    const signed = reqs.map((q) => assembleSignedExtrinsic(q.payload, u8aToHex(keys.alice.sign(hexToU8a(q.signBytesHex), { withType: true })), facts));
    const n = node({ existingAssets: ['1', '2'] });
    const r = await preflight(n, plan, facts, { signedExtrinsics: signed, nonce: 0 });
    expect(r.nonceSource).toBe('caller');
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(['ok', 'ok', 'ok']);
    expect(n.log.filter((c) => c.method === 'system_dryRun')).toHaveLength(3);
  });

  it('refuses when the node runs a different runtime than the facts', async () => {
    const inputs = snapshotInputs();
    const n = new FakeNode({ inputs: { ...inputs, runtimeVersion: { ...inputs.runtimeVersion, specVersion: 1003 } }, facts });
    await expect(preflight(n, demoPlan(), facts)).rejects.toThrow(/RUNTIME_CHANGED/);
  });
});
