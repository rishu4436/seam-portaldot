import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type Hex } from '@seam/compiler';
import { action, buildReceipt, defineManifest, factsFromSnapshot, receiptDigest, type Receipt } from '../src/index.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const facts = factsFromSnapshot(fileURLToPath(new URL('./fixtures', import.meta.url)));
const plan = compile(defineManifest({ signer: { type: 'ss58', value: ALICE, ss58Prefix: 42 }, actions: [action.transfer('pay', { assetId: '1', amount: '2500', recipient: BOB })] }), facts);
const run = (...args: string[]) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

describe.skipIf(!existsSync(cli))('seam verify (offline) says integrity only', () => {
  it('a fabricated self-consistent receipt is only integrity_checked, with the not-on-chain-proof wording', () => {
    const r = buildReceipt({ plan, outcomes: [] }) as Receipt;
    // attacker invents a finalized, verified-looking step and recomputes the digest
    r.steps[0] = { actionId: 'pay', status: 'finalized', txHash: ('0x' + 'ab'.repeat(32)) as Hex, block: { number: 1, hash: ('0x' + '01'.repeat(32)) as Hex }, events: [], verification: 'verified', reason: 'forged', coverage: 'effect_proven' };
    r.result = 'verified'; r.receiptDigest = receiptDigest(r);
    const f = join(mkdtempSync(join(tmpdir(), 'seam-')), 'r.json');
    writeFileSync(f, JSON.stringify(r));
    const o = run('verify', f);
    expect(o.status).toBe(0);
    expect(o.stdout).toContain('integrity_checked');
    expect(o.stdout).toMatch(/integrity only, not on-chain proof/);
    expect(o.stdout).not.toMatch(/chain_verified/);
    expect(o.stdout).not.toMatch(/Receipt is intact/);
  });
  it('an edited receipt without a recomputed digest fails with exit 5', () => {
    const r = buildReceipt({ plan, outcomes: [] });
    const f = join(mkdtempSync(join(tmpdir(), 'seam-')), 'r.json');
    writeFileSync(f, JSON.stringify({ ...r, result: 'verified' }));
    expect(run('verify', f).status).toBe(5);
  });
});
