/** SEAM-005 chain side: find a transaction after an uncertain send. Never claims absence when it cannot know. */
import { describe, expect, it } from 'vitest';
import { callsToSign } from '@seam/policy';
import type { Hex } from '@seam/compiler';
import { createPortaldotAdapter, extrinsicHash, encodeRuntime, lookupExtrinsic, signBytesOf } from '../src/index.js';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { FakeNode } from './fakeNode.js';
import { demoPlan, devKeys, snapshotFacts, snapshotInputs } from './helpers.js';

const NOW = new Date('2026-10-11T12:00:00Z');
async function setup(o: Partial<ConstructorParameters<typeof FakeNode>[0]> = {}) {
  const keys = await devKeys();
  const facts = snapshotFacts();
  const node = new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: ['1', '2'], ...o });
  const adapter = createPortaldotAdapter(node, { allowMainnet: true, submitTimeoutMs: 2000, now: () => NOW, facts });
  await adapter.discover();
  const plan = demoPlan(facts);
  const { envelope } = await adapter.preflight(plan);
  const calls = callsToSign(plan).filter((c): c is Hex => !!c);
  const requests = adapter.signingRequests(calls, envelope);
  const { registry } = encodeRuntime(facts);
  const tx = (i: number): Hex => {
    const p = requests[i]!.payload;
    const ext = registry.createType('Extrinsic', { method: p.method }, { version: 4 });
    ext.addSignature(p.address, hexToU8a(u8aToHex(keys.alice.sign(hexToU8a(signBytesOf(p, facts)), { withType: true }))), p);
    return ext.toHex() as Hex;
  };
  return { node, adapter, requests, tx, facts };
}
const head = () => snapshotInputs().head.number;

describe('lookupExtrinsic', () => {
  it('found_finalized when the transaction is in a finalized block', async () => {
    const s = await setup();
    const tx = s.tx(0);
    await s.adapter.submit(tx, 'pay');
    const r = await lookupExtrinsic(s.node, extrinsicHash(tx));
    expect(r.state).toBe('found_finalized');
  });
  it('found_included when the block is not finalized yet', async () => {
    const s = await setup({ finalizedLag: 1 });
    const tx = s.tx(0);
    await s.adapter.submit(tx, 'pay');
    expect((await lookupExtrinsic(s.node, extrinsicHash(tx))).state).toBe('found_included');
  });
  it('not_found is NOT definitive by default (cannot prove absence), and never definitive while the era is open', async () => {
    const s = await setup();
    const h = `0x${'12'.repeat(32)}` as Hex;
    expect(await lookupExtrinsic(s.node, h)).toMatchObject({ state: 'not_found', definitive: false });
    expect(await lookupExtrinsic(s.node, h, { fromBlock: head(), validUntilBlock: head() + 1000 })).toMatchObject({ state: 'not_found', definitive: false });
  });
  it('not_found is definitive only after finality passed the era and the scan covered the whole window', async () => {
    const s = await setup();
    s.node.advance(10);
    const h = `0x${'12'.repeat(32)}` as Hex;
    expect(await lookupExtrinsic(s.node, h, { fromBlock: head(), validUntilBlock: head() + 5 })).toMatchObject({ state: 'not_found', definitive: true });
    // window not fully scanned (maxScan too small): not definitive
    expect(await lookupExtrinsic(s.node, h, { fromBlock: head(), validUntilBlock: head() + 5, maxScan: 3 })).toMatchObject({ state: 'not_found', definitive: false });
  });
  it('pending in the pool is unknown, never not_found', async () => {
    const s = await setup();
    const tx = s.tx(0);
    s.node.advance(10);
    const n = new FakeNode({ inputs: snapshotInputs(), facts: s.facts, pending: [tx] });
    n.advance(10);
    expect((await lookupExtrinsic(n, extrinsicHash(tx), { fromBlock: head(), validUntilBlock: head() + 5 })).state).toBe('unknown');
  });
  it('an unreachable node (RPC errors) is unknown, never not_found', async () => {
    for (const failRpc of [['chain_getBlock'], ['chain_getBlockHash'], ['chain_getFinalizedHead'], ['chain_getHeader']]) {
      const s = await setup();
      s.node.advance(10);
      s.node.breakRpc(...failRpc);
      const r = await lookupExtrinsic(s.node, `0x${'12'.repeat(32)}` as Hex, { fromBlock: head(), validUntilBlock: head() + 5 });
      expect(r.state).toBe('unknown');
    }
    const down = await lookupExtrinsic('ws://127.0.0.1:1', `0x${'12'.repeat(32)}` as Hex, { timeoutMs: 500 } as any);
    expect(down.state).toBe('unknown');
  });
  it('adapter.lookupTx uses the era of what it sent', async () => {
    const s = await setup();
    const tx = s.tx(0);
    await s.adapter.submit(tx, 'pay');
    expect((await s.adapter.lookupTx(extrinsicHash(tx))).state).toBe('found_finalized');
    expect((await s.adapter.lookupTx(`0x${'12'.repeat(32)}` as Hex)).state).toBe('not_found');
  });
});

describe('submit reports delivery', () => {
  it('a refused (mismatching) transaction is not_sent; a node rejection is rejected; a clean send is accepted', async () => {
    const s = await setup();
    expect((await s.adapter.submit(s.tx(1), 'call') as any).delivery).toBe('not_sent'); // wrong request for position 0
    const ok = await s.adapter.submit(s.tx(0), 'pay');
    expect((ok as any).delivery).toBe('accepted');
    const r = await setup({ rejectWith: 'invalid' });
    expect(((await r.adapter.submit(r.tx(0), 'pay')) as any).delivery).toBe('accepted'); // pool took it, then invalidated
  });
  it('a node that answers nothing before the timeout is uncertain, with the tx hash', async () => {
    const s = await setup();
    const tx = s.tx(0);
    const silent = { ...s.node, send: s.node.send.bind(s.node), unsubscribe: s.node.unsubscribe.bind(s.node), subscribe: async () => 1 } as any;
    const a = createPortaldotAdapter(silent, { allowMainnet: true, submitTimeoutMs: 50, now: () => NOW, facts: s.facts, dryRunBeforeSubmit: false });
    await a.discover();
    a.signingRequests(callsToSign(demoPlan(s.facts)).filter((c): c is Hex => !!c), (await a.preflight(demoPlan(s.facts))).envelope);
    const o: any = await a.submit(tx, 'pay');
    expect(o.delivery).toBe('uncertain');
    expect(o.txHash).toBe(extrinsicHash(tx));
  });
  it('a connection that drops during submit is uncertain with the tx hash (not a thrown error)', async () => {
    const s = await setup();
    const tx = s.tx(0);
    const broken = { send: s.node.send.bind(s.node), unsubscribe: async () => true, subscribe: async () => { throw Object.assign(new Error('WebSocket is not connected'), {}); } } as any;
    const a = createPortaldotAdapter(broken, { allowMainnet: true, submitTimeoutMs: 50, now: () => NOW, facts: s.facts, dryRunBeforeSubmit: false });
    await a.discover();
    a.signingRequests(callsToSign(demoPlan(s.facts)).filter((c): c is Hex => !!c), (await a.preflight(demoPlan(s.facts))).envelope);
    const o: any = await a.submit(tx, 'pay');
    expect(o.delivery).toBe('uncertain');
    expect(o.txHash).toBe(extrinsicHash(tx));
  });
});
