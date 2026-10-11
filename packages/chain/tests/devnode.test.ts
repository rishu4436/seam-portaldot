/**
 * End to end on a LOCAL substrate-contracts-node (scripts/devnode.sh start), gated on SEAM_DEVNODE=1.
 * Signs with the public //Alice dev seed: local dev chain only (lib.mjs refuses non-localhost endpoints and
 * Portaldot mainnet). Each run writes its evidence under /workspace/seam-evidence/devnode/runs/.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LIVE = process.env.SEAM_DEVNODE === '1';
const script = (name: string) => fileURLToPath(new URL(`../scripts/devnode/${name}`, import.meta.url));
const run = (name: string, ...args: string[]) => execFileSync('node', [script(name), ...args], { encoding: 'utf8', timeout: 240_000 });
const evidenceOf = (stdout: string) => {
  const file = stdout.trim().split(/\s/)[0]!;
  return { file, json: JSON.parse(readFileSync(file, 'utf8')) };
};

describe.skipIf(!LIVE)('local dev node (SEAM_DEVNODE=1)', () => {
  it('setup: asset 1 and the seam_emitter contract exist', () => {
    const out = JSON.parse(run('setup.mjs'));
    expect(out.state.assetId).toBe(1);
    expect(out.state.contract).toMatch(/^0x[0-9a-f]{64}$/);
  }, 240_000);

  it('sequential transfer -> contract call -> mint, strict policy, per-step gate: receipt verified', () => {
    const { json } = evidenceOf(run('run-sequential.mjs'));
    expect(json.policy.requireSignedDryRun).toBe(true);
    expect(json.policyResult.allowed).toBe(true);
    const sent = json.stepLog.filter((s: any) => s.phase === 'sending');
    expect(sent.map((s: any) => s.dryRun.map((d: any) => d.outcome))).toEqual([['ok'], ['ok'], ['ok']]);
    expect(json.run.receipt.result).toBe('verified');
    expect(json.receiptIntact).toBe(true);
    const steps = json.run.receipt.steps;
    expect(steps.map((s: any) => s.status)).toEqual(['finalized', 'finalized', 'finalized']);
    expect(new Set(steps.map((s: any) => s.txHash)).size).toBe(3);
    expect(steps[1].events.some((e: string) => e.startsWith('Contracts.ContractEmitted('))).toBe(true);
    // Weight V2 runtime: every preflight step has a real proof size from payment_queryInfo
    for (const p of json.preflight.steps) expect(p.proofSize.value).toMatch(/^[1-9][0-9]*$/);
    expect(json.preflightDetail.transactions.every((t: any) => t.queryInfo.weightVersion === 2)).toBe(true);
    // the contract call's queried proof size covers the gas_limit proof size; the contract itself needs far less
    const call = json.preflight.steps[1];
    const needed = /contract needs proof size (\d+)/.exec(call.note)![1]!;
    expect(BigInt(call.proofSize.value)).toBeGreaterThan(BigInt(needed));
  }, 240_000);

  it('batch_all rollback: the gate blocks the failing batch; sent directly, nothing from steps 1 and 3 sticks', () => {
    const { file, json } = evidenceOf(run('run-rollback.mjs'));
    expect(json.seamGate).toMatchObject({ ok: false, stage: 'submit_gate', nothingSent: true });
    expect(json.seamGate.reasons.map((r: any) => r.code)).toEqual(['signed_dry_run_failed']);
    expect(json.directSubmit).toMatchObject({ status: 'finalized', success: false });
    expect(json.directSubmit.dispatchError).toMatch(/assets\.BalanceLow/);
    expect(json.innerEffects).toEqual([]);
    expect(json.state.after.asset).toEqual(json.state.before.asset);
    expect(json.state.after.aliceNonce).toBe(json.state.before.aliceNonce + 1);
    expect(json.batchAllRollback).toBe('verified');

    const atomic = evidenceOf(run('run-atomic.mjs', file)).json;
    expect(atomic.plan.mode).toBe('atomic_verified');
    expect(atomic.run.receipt.result).toBe('verified');
    expect(new Set(atomic.run.receipt.steps.map((s: any) => s.txHash)).size).toBe(1);
  }, 480_000);
});
