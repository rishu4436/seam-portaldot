/**
 * Bot 5's SDK flow (Seam: discover -> prepare -> approve -> execute -> receipt) running on
 * createPortaldotAdapter against the in-process fake node. Imports the SDK from its sibling folder
 * (../../sdk/dist) until the monorepo wires packages together; skipped if it isn't built.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { portaldotPolicy } from '@seam/policy';
import { createPortaldotAdapter, signBytesOf, type ChainAdapter } from '../src/index.js';
import { FakeNode } from './fakeNode.js';
import { BOB, CHARLIE, demoManifest, devKeys, snapshotFacts, snapshotInputs } from './helpers.js';

const SDK = fileURLToPath(new URL('../../sdk/dist/index.js', import.meta.url));
const limits = {
  allowedAssets: ['1', '2'], allowedContracts: [CHARLIE], allowedRecipients: [BOB],
  maxAmountPerAsset: { '1': '5000000000000000', '2': '1' }, maxNativeValue: '0', maxGasLimit: '10000000000',
  maxWeight: '1000000000', maxFee: '10000000000'
};
// Strict default (requireSignedDryRun on) works for atomic plans. For sequential plans, transactions 2..n
// have future nonces when the SDK dry-runs them up front, so they come back 'unknown' and the gate blocks
// (see the first test). The sequential tests turn it off; the adapter still dry-runs each transaction right
// before sending it and refuses one that fails.
const strict = portaldotPolicy(limits);
const policy = portaldotPolicy({ ...limits, requireSignedDryRun: false });

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

  it('sequential plan with requireSignedDryRun on: the up-front dry run of txs 2..n is unknown (future nonce), so the gate blocks', async () => {
    const { seam, node, adapter, wallet, facts, prepared } = await setup();
    const now = new Date('2026-10-11T12:00:00Z');
    const p = { ...prepared, policyResult: (await import('@seam/policy')).evaluatePolicy({ policy: strict, plan: prepared.plan, facts, preflight: prepared.preflight }) };
    const approval = seam.approve({ ...p, policy: strict, facts, now });
    expect(approval.ok).toBe(true);
    const run = await seam.execute({ ...p, policy: strict, facts, approval: approval.approval, wallet, now: () => now });
    expect(run).toMatchObject({ ok: false, stage: 'submit_gate' });
    expect(run.check.reasons.map((r: any) => r.code)).toEqual(['signed_dry_run_missing']);
    expect(adapter.lastDryRun!.map((d) => d.outcome)).toEqual(['ok', 'unknown', 'unknown']);
    expect(node.submitted).toHaveLength(0);
  });

  it('runs end to end and the receipt verifies every step from the decoded events', async () => {
    const { sdk, seam, node, wallet, facts, prepared } = await setup();
    expect(prepared.policyResult.allowed).toBe(true);
    expect(prepared.envelope).toEqual({ signer: demoManifest().signer.value, nonce: 0, mortalityBlocks: 64, checkpoint: { number: 2721455, hash: snapshotInputs().head.hash }, expiresAt: '2026-10-11T13:03:00.000Z' });
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

  it('a failing second step is caught by the pre-submit dry run, not sent, and the receipt says partial', async () => {
    const { seam, node, wallet, facts, prepared } = await setup({ failCall: (c) => (c.startsWith('0x0d00') ? { index: 13, error: 12 } : undefined) });
    const now = new Date('2026-10-11T12:00:00Z');
    const approval = seam.approve({ ...prepared, policy, facts, now });
    const run = await seam.execute({ ...prepared, policy, facts, approval: approval.approval, wallet, now: () => now });
    // the adapter's pre-submit dry run catches step 2, so it is never broadcast
    expect(node.submitted).toHaveLength(1);
    expect(run.receipt.result).toBe('partial');
    expect(run.receipt.steps[1]).toMatchObject({ status: 'failed', verification: 'not_verified' });
    expect(run.receipt.steps[1].reason).toMatch(/not sent: the dry run right before submitting failed \(dispatch failed: contracts\.ContractNotFound/);
    expect(run.receipt.steps[2].status).toBe('not_run');
  });

  it('atomic plan with the strict policy: the signed batch_all dry-runs ok, one transaction, every step verified', async () => {
    const { seam, node, adapter, wallet, facts } = await setup({}, 'verified');
    const prepared = await seam.prepare(demoManifest(), facts, strict);
    expect(prepared.plan.mode).toBe('atomic_verified');
    const now = new Date('2026-10-11T12:00:00Z');
    const approval = seam.approve({ ...prepared, policy: strict, facts, now });
    const run = await seam.execute({ ...prepared, policy: strict, facts, approval: approval.approval, wallet, now: () => now });
    expect(run.ok).toBe(true);
    expect(adapter.lastDryRun!.map((d) => d.outcome)).toEqual(['ok']);
    expect(node.submitted).toHaveLength(1);
    expect(run.receipt.result).toBe('verified');
  });
});
