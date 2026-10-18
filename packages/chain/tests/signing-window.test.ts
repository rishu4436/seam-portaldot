/** SEAM-016: right before broadcasting, the checkpoint, nonce and era of the approved request must still hold. Otherwise nothing is sent. */
import { describe, expect, it } from 'vitest';
import { callsToSign } from '@seam/policy';
import type { Hex } from '@seam/compiler';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { createPortaldotAdapter, encodeRuntime, signBytesOf } from '../src/index.js';
import { FakeNode } from './fakeNode.js';
import { demoPlan, devKeys, snapshotFacts, snapshotInputs } from './helpers.js';

const NOW = new Date('2026-10-11T12:00:00Z');
async function setup() {
  const keys = await devKeys();
  const facts = snapshotFacts();
  const node = new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: ['1', '2'] });
  const adapter = createPortaldotAdapter(node, { allowMainnet: true, submitTimeoutMs: 2000, now: () => NOW, facts });
  await adapter.discover();
  const plan = demoPlan(facts);
  const { envelope } = await adapter.preflight(plan);
  const requests = adapter.signingRequests(callsToSign(plan).filter((c): c is Hex => !!c), envelope);
  const { registry } = encodeRuntime(facts);
  const tx = (i: number): Hex => {
    const p = requests[i]!.payload;
    const ext = registry.createType('Extrinsic', { method: p.method }, { version: 4 });
    ext.addSignature(p.address, hexToU8a(u8aToHex(keys.alice.sign(hexToU8a(signBytesOf(p, facts)), { withType: true }))), p);
    return ext.toHex() as Hex;
  };
  const sends = () => node.submitted.length + node.log.filter((l) => /submit/i.test(l.method)).length;
  return { node, adapter, tx, requests, keys, sends };
}
const refused = (o: any, re: RegExp) => { expect(o.status).toBe('failed'); expect(o.delivery).toBe('not_sent'); expect(o.error).toMatch(re); };

describe('SEAM-016: signing window is rechecked before submit', () => {
  it('a still-valid request is sent', async () => {
    const s = await setup();
    expect((await s.adapter.submit(s.tx(0), 'pay')).status).toBe('finalized');
  });
  it('era expired (chain moved past checkpoint + period): not sent', async () => {
    const s = await setup();
    s.node.advance(80);
    refused(await s.adapter.submit(s.tx(0), 'pay'), /era_expired/);
    expect(s.sends()).toBe(0);
  });
  it('nonce already used on chain (stale): not sent', async () => {
    const s = await setup();
    s.node.setNonce(s.keys.alice.address, 5);
    refused(await s.adapter.submit(s.tx(0), 'pay'), /nonce_stale/);
    expect(s.sends()).toBe(0);
  });
  it('nonce ahead of the chain (an earlier transaction has not landed): not sent', async () => {
    const s = await setup();
    s.node.setNonce(s.keys.alice.address, 0);
    const first = await s.adapter.submit(s.tx(0), 'pay');
    expect(first.status).toBe('finalized');
    s.node.setNonce(s.keys.alice.address, 0); // chain forgot it: request 1 (nonce 1) is now in the future
    refused(await s.adapter.submit(s.tx(1), 'call'), /nonce_not_next/);
  });
  it('checkpoint block no longer on the chain (reorg): not sent', async () => {
    const s = await setup();
    s.node.forkAt(snapshotInputs().head.number);
    refused(await s.adapter.submit(s.tx(0), 'pay'), /checkpoint_not_on_chain/);
    expect(s.sends()).toBe(0);
  });
  it('window cannot be read (RPC down): not sent, never assumed fine', async () => {
    const s = await setup();
    s.node.breakRpc('system_accountNextIndex');
    refused(await s.adapter.submit(s.tx(0), 'pay'), /window_unreadable/);
    expect(s.sends()).toBe(0);
  });
});
