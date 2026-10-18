/** SEAM-001 end to end: real SDK flow + real adapter + fake node. A wallet that reports the expected signedCall but signs something else submits nothing. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { portaldotPolicy } from '@seam/policy';
import { createPortaldotAdapter, encodeRuntime, signBytesOf } from '../src/index.js';
import { FakeNode } from './fakeNode.js';
import { BOB, CHARLIE, demoManifest, devKeys, snapshotFacts, snapshotInputs } from './helpers.js';

const SDK = fileURLToPath(new URL('../../sdk/dist/index.js', import.meta.url));
const policy = portaldotPolicy({ allowedAssets: ['1', '2'], allowedContracts: [CHARLIE], allowedRecipients: [BOB], maxAmountPerAsset: { '1': '5000000000000000', '2': '1' }, maxNativeValue: '0', maxGasLimit: '10000000000', maxWeight: '1000000000', maxFee: '10000000000' });
const NOW = new Date('2026-10-11T12:00:00Z');

describe.skipIf(!existsSync(SDK))('SEAM-001 SDK + chain adapter', () => {
  const go = async (tamper: 'none' | 'swap-call' | 'other-signer') => {
    const sdk = await import(SDK);
    const keys = await devKeys();
    const facts = snapshotFacts();
    const node = new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: ['1', '2'] });
    const adapter = createPortaldotAdapter(node, { allowMainnet: true, submitTimeoutMs: 2000, now: () => NOW });
    const seam = new sdk.Seam(adapter);
    const f = await seam.discover();
    const prepared = await seam.prepare(demoManifest(), f, policy);
    const approval = seam.approve({ ...prepared, policy, facts: f, now: NOW });
    const { registry } = encodeRuntime(f);
    const sign = (pair: any, payload: any) => u8aToHex(pair.sign(hexToU8a(signBytesOf(payload, f)), { withType: true }));
    const wallet = {
      async sign(calls: string[], envelope: any) {
        const reqs = adapter.signingRequests(calls as any, envelope);
        return reqs.map((r, i) => {
          let payload: any = r.payload; let pair = keys.alice;
          if (tamper === 'swap-call' && i === 1) payload = { ...payload, method: reqs[2]!.callHex };
          if (tamper === 'other-signer' && i === 0) { pair = keys.bob; payload = { ...payload, address: keys.bob.address }; }
          const ext = registry.createType('Extrinsic', { method: payload.method }, { version: 4 });
          ext.addSignature(payload.address, hexToU8a(sign(pair, payload)), payload);
          return { signedTx: ext.toHex(), signedCall: r.callHex }; // the wallet always CLAIMS the approved call
        });
      }
    };
    const run = await seam.execute({ ...prepared, policy, facts: f, approval: approval.approval, wallet, now: () => NOW });
    const submits = node.log.filter((l) => /submit/i.test(l.method)).length + node.submitted.length;
    return { run, submits };
  };

  it('honest wallet: verified receipt', async () => {
    const { run, submits } = await go('none');
    expect(run.ok).toBe(true);
    expect(submits).toBeGreaterThan(0);
  });
  it('signedTx carries a different call than the wallet reports: blocked, zero submits', async () => {
    const { run, submits } = await go('swap-call');
    expect(run.ok).toBe(false);
    expect(run.reason).toMatch(/call_mismatch/);
    expect(submits).toBe(0);
  });
  it('signed by another account: blocked, zero submits', async () => {
    const { run, submits } = await go('other-signer');
    expect(run.ok).toBe(false);
    expect(run.reason).toMatch(/signer_mismatch/);
    expect(submits).toBe(0);
  });
});
