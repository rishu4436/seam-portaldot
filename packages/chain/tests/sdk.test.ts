/**
 * Bot 5's SDK flow (Seam: discover -> prepare -> approve -> execute -> receipt) running on
 * createPortaldotAdapter against the in-process fake node. Imports the SDK from its sibling folder
 * (../../sdk/dist) until the monorepo wires packages together; skipped if it isn't built.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { definePolicy } from '@seam/policy';
import { createPortaldotAdapter, signBytesOf, type ChainAdapter } from '../src/index.js';
import { FakeNode } from './fakeNode.js';
import { BOB, CHARLIE, demoManifest, devKeys, snapshotFacts, snapshotInputs } from './helpers.js';

const SDK = fileURLToPath(new URL('../../sdk/dist/index.js', import.meta.url));
const policy = definePolicy({
  allowedAssets: ['1', '2'], allowedContracts: [CHARLIE], allowedRecipients: [BOB],
  maxAmountPerAsset: { '1': '5000000000000000', '2': '1' }, maxNativeValue: '0', maxGasLimit: '10000000000',
  maxWeight: '1000000000', maxFee: '10000000000', allowUnknown: { storageDeposit: true, dryRun: true }
});

describe.skipIf(!existsSync(SDK))('Bot 5 SDK flow with createPortaldotAdapter (fake node)', () => {
  const setup = async (o: Partial<ConstructorParameters<typeof FakeNode>[0]> = {}, batchAllRollback?: 'verified') => {
    const sdk = await import(SDK);
    const keys = await devKeys();
    const node = new FakeNode({ inputs: snapshotInputs(), facts: snapshotFacts(), existingAssets: ['1', '2'], ...o });
    // allowMainnet only because the fake node replays the mainnet snapshot; nothing leaves the process.
    const adapter = createPortaldotAdapter(node, { allowMainnet: true, submitTimeoutMs: 2000, now: () => new Date('2026-10-11T12:00:00Z'), ...(batchAllRollback ? { batchAllRollback } : {}) });
    const chain: ChainAdapter = adapter;
    // The user's wallet (TEST ONLY: public //Alice dev seed), as an extension-style signPayload.
    const wallet = adapter.walletFrom(async (payload) => ({
      signature: u8aToHex(keys.alice.sign(hexToU8a(signBytesOf(payload, adapter.facts!)), { withType: true }))
    }));
    const seam = new sdk.Seam(chain);
    const facts = await seam.discover();
    const prepared = await seam.prepare(demoManifest(), facts, policy);
    return { sdk, seam, node, adapter, wallet, facts, prepared };
  };

  it('runs end to end and the receipt verifies every step from the decoded events', async () => {
    const { sdk, seam, node, wallet, facts, prepared } = await setup();
    expect(prepared.policyResult.allowed).toBe(true);
    expect(prepared.envelope).toEqual({ signer: demoManifest().signer.value, nonce: 0, mortalityBlocks: 64, expiresAt: '2026-10-11T13:03:00.000Z' });
    const now = new Date('2026-10-11T12:00:00Z');
    const approval = seam.approve({ ...prepared, policy, facts, now });
    expect(approval.ok).toBe(true);
    const run = await seam.execute({ ...prepared, policy, facts, approval: approval.approval, wallet, now: () => now });
    expect(run.ok).toBe(true);
    expect(node.submitted).toHaveLength(3);
    expect(run.receipt.result).toBe('verified');
    expect(run.receipt.steps.map((s: any) => [s.actionId, s.status, s.verification])).toEqual([
      ['pay', 'finalized', 'verified'], ['call', 'finalized', 'verified'], ['receipt', 'finalized', 'verified']
    ]);
  });

  it('a failing second step stops the run and the receipt says partial', async () => {
    const { seam, node, wallet, facts, prepared } = await setup({ failCall: (c) => (c.startsWith('0x0d00') ? { index: 13, error: 12 } : undefined) });
    const now = new Date('2026-10-11T12:00:00Z');
    const approval = seam.approve({ ...prepared, policy, facts, now });
    const run = await seam.execute({ ...prepared, policy, facts, approval: approval.approval, wallet, now: () => now });
    expect(node.submitted).toHaveLength(2);
    expect(run.receipt.result).toBe('partial');
    expect(run.receipt.steps[1]).toMatchObject({ status: 'failed', verification: 'not_verified' });
    expect(run.receipt.steps[1].reason).toMatch(/contracts\.ContractNotFound/);
    expect(run.receipt.steps[2].status).toBe('not_run');
  });

  it('atomic plan: one batch_all transaction, every step verified from its events', async () => {
    const { seam, node, wallet, facts, prepared } = await setup({}, 'verified');
    expect(prepared.plan.mode).toBe('atomic_verified');
    const now = new Date('2026-10-11T12:00:00Z');
    const approval = seam.approve({ ...prepared, policy, facts, now });
    const run = await seam.execute({ ...prepared, policy, facts, approval: approval.approval, wallet, now: () => now });
    expect(node.submitted).toHaveLength(1);
    expect(run.receipt.result).toBe('verified');
  });
});
