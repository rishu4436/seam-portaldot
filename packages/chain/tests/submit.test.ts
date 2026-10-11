import { describe, expect, it, beforeAll } from 'vitest';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import type { RuntimeFacts } from '@seam/compiler';
import {
  assembleSignedExtrinsic, buildSigningRequests, readEvents, submitAndWatch, waitFinalized, extrinsicHash,
  type Hex, type StatusUpdate
} from '../src/index.js';
import { FakeNode } from './fakeNode.js';
import { ALICE, ALICE_HEX, BOB_HEX, CHECKPOINT, atomicPlan, demoPlan, devKeys, snapshotFacts, snapshotInputs } from './helpers.js';

const facts = snapshotFacts();
let keys: Awaited<ReturnType<typeof devKeys>>;
beforeAll(async () => { keys = await devKeys(); });

function signedPlan(plan = demoPlan(), f: RuntimeFacts = facts, nonce = 0): Hex[] {
  return buildSigningRequests(plan, f, { signer: ALICE, nonce, mortalityBlocks: 64, checkpoint: CHECKPOINT, expiresAt: 'x' })
    .map((q) => assembleSignedExtrinsic(q.payload, u8aToHex(keys.alice.sign(hexToU8a(q.signBytesHex), { withType: true })), f));
}
const node = (o: Partial<ConstructorParameters<typeof FakeNode>[0]> = {}, f = facts) => new FakeNode({ inputs: snapshotInputs(), facts: f, ...o });
// The fake node replays the MAINNET snapshot, so tests must opt in; nothing leaves the process.
const opts = (f = facts) => ({ facts: f, allowMainnet: true, timeoutMs: 2000 });

describe('submitAndWatch and event reading (fake node)', () => {
  it('reports submitted -> in_block -> finalized and returns this extrinsic\'s decoded events', async () => {
    const n = node();
    const [tx] = signedPlan();
    const seen: StatusUpdate[] = [];
    const r = await submitAndWatch(n, tx!, (u) => seen.push(u), opts());
    expect(seen.map((u) => u.status)).toEqual(['submitted', 'in_block', 'finalized']);
    expect(r).toMatchObject({ status: 'finalized', txHash: extrinsicHash(tx!), timedOut: false, history: ['submitted', 'in_block', 'finalized'] });
    expect(r.inclusion).toMatchObject({ number: 2721456, extrinsicIndex: 1, success: true });
    expect(r.inclusion!.events.map(({ pallet, name, args }) => ({ pallet, name, args }))).toEqual([
      { pallet: 'Assets', name: 'Transferred', args: ['1', ALICE_HEX, BOB_HEX, '2500000000000000'] },
      { pallet: 'System', name: 'ExtrinsicSuccess', args: ['{"class":"Normal","paysFee":"Yes","weight":200000000}'] }
    ]);
    // readEvents gives the same answer for Bot 5's receipt check
    const again = await readEvents(n, r.inclusion!.hash, 1, facts);
    expect(again.events).toEqual(r.inclusion!.events);
  });

  it('decodes a dispatch failure', async () => {
    const n = node({ failCall: () => ({ index: 26, error: 0 }) });
    const r = await submitAndWatch(n, signedPlan()[0]!, undefined, opts());
    expect(r.status).toBe('finalized');
    expect(r.inclusion!.success).toBe(false);
    expect(r.inclusion!.dispatchError).toMatch(/^assets\.BalanceLow/);
  });

  it('atomic: one batch_all transaction with every step\'s events', async () => {
    const { plan, facts: f } = atomicPlan();
    const r = await submitAndWatch(node({}, f), signedPlan(plan, f)[0]!, undefined, opts(f));
    expect(r.inclusion!.events.map((e) => `${e.pallet}.${e.name}`)).toEqual(['Assets.Transferred', 'Contracts.ContractEmitted', 'Assets.Issued', 'System.ExtrinsicSuccess']);
  });

  it('a node rejection (bad signature) is reported as invalid with the node\'s reason', async () => {
    const tx = signedPlan()[0]!;
    const tampered = (tx.slice(0, -2) + (tx.endsWith('09') ? '0a' : '09')) as Hex;
    const r = await submitAndWatch(node(), tampered, undefined, opts());
    expect(r.status).toBe('invalid');
    expect(r.error).toMatch(/bad signature/);
  });

  it('dropped and usurped are terminal', async () => {
    for (const s of ['dropped', 'invalid'] as const) {
      const r = await submitAndWatch(node({ rejectWith: s }), signedPlan()[0]!, undefined, opts());
      expect(r.status).toBe(s);
      expect(r.error).toMatch(s);
    }
    const r = await submitAndWatch(node({ rejectWith: { usurped: '0x00' } as never }), signedPlan()[0]!, undefined, opts());
    expect(r.status).toBe('usurped');
  });

  it('times out after inclusion with the in-block result', async () => {
    const r = await submitAndWatch(node({ stopAfterInBlock: true }), signedPlan()[0]!, undefined, { ...opts(), timeoutMs: 50 });
    expect(r).toMatchObject({ status: 'in_block', timedOut: true });
    expect(r.inclusion!.success).toBe(true);
  });

  it('refuses Portaldot mainnet unless allowMainnet is set, and a node from another chain', async () => {
    const n = node();
    await expect(submitAndWatch(n, signedPlan()[0]!, undefined, { facts })).rejects.toThrow(/MAINNET_SUBMIT_REFUSED/);
    expect(n.submitted).toHaveLength(0);
    const inputs = snapshotInputs();
    const other = new FakeNode({ inputs: { ...inputs, genesisHash: `0x${'22'.repeat(32)}` }, facts });
    await expect(submitAndWatch(other, signedPlan()[0]!, undefined, opts())).rejects.toThrow(/FACTS_MISMATCH: node genesis/);
  });

  it('refuses something that is not a signed extrinsic for this runtime', async () => {
    await expect(submitAndWatch(node(), '0x280403000b00a08429a101', undefined, opts())).rejects.toThrow(/NOT_SIGNED/);
  });

  it('waitFinalized resolves for a finalized canonical block', async () => {
    const n = node();
    const r = await submitAndWatch(n, signedPlan()[0]!, undefined, opts());
    await expect(waitFinalized(n, r.inclusion!.hash, { timeoutMs: 1000 })).resolves.toEqual({ finalized: true, block: { number: 2721456, hash: r.inclusion!.hash } });
    expect(await waitFinalized(n, CHECKPOINT.hash, { timeoutMs: 1000 })).toMatchObject({ finalized: true });
  });
});
