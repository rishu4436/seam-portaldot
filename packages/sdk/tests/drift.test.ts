import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type RuntimeFacts } from '@seam/compiler';
import { action, defineManifest, diffRuntimes, explainDrift, factsFromSnapshot, SeamCode, EXIT } from '../src/index.js';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const mainnet = factsFromSnapshot(dir('./fixtures'));
const devnode = factsFromSnapshot(dir('./fixtures/devnode'));
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

describe('SEAM-021 runtime A/B drift report', () => {
  it('identical runtimes: no drift', () => {
    const d = diffRuntimes(mainnet, mainnet);
    expect(d.drifted).toBe(false);
    expect(d.fingerprint).toEqual([]);
    expect(d.capabilities).toEqual([]);
  });
  it('two different real runtimes: names the changed fingerprint fields and capabilities', () => {
    const d = diffRuntimes(mainnet, devnode);
    expect(d.drifted).toBe(true);
    const fields = d.fingerprint.map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['specName', 'specVersion', 'genesisHash', 'metadataHash']));
    const spec = d.fingerprint.find((f) => f.field === 'specVersion')!;
    expect([spec.a, spec.b]).toEqual([1002, 100]);
    // Revive.call is observed on the test chain only
    const revive = d.capabilities.find((c) => c.call === 'Revive.call')!;
    expect(revive.change).toBe('status');
    expect([revive.a, revive.b]).toEqual(['not_observed', 'observed']);
  });
  it('detects a changed call index and an added/removed call', () => {
    const b: RuntimeFacts = JSON.parse(JSON.stringify(mainnet));
    b.capabilities['Assets.transfer_keep_alive']!.callIndex = (b.capabilities['Assets.transfer_keep_alive']!.callIndex ?? 0) + 1;
    delete b.capabilities['Assets.mint'];
    b.capabilities['New.call'] = { status: 'observed', palletIndex: 99, callIndex: 0 };
    const d = diffRuntimes(mainnet, b);
    const by = (c: string) => d.capabilities.find((x) => x.call === c)!;
    expect(by('Assets.transfer_keep_alive').change).toBe('index');
    expect(by('Assets.mint').change).toBe('removed');
    expect(by('New.call').change).toBe('added');
  });
  it('a plan prepared against A is reported stale against B, and fresh against A', () => {
    const plan = compile(defineManifest({ signer: { type: 'ss58', value: ALICE }, actions: [action.transfer('pay', { assetId: '1', amount: '1', recipient: BOB })] }), mainnet);
    expect(diffRuntimes(mainnet, devnode, { plan }).plan).toEqual({ stale: true, planFingerprint: plan.fingerprintDigest, against: devnode.fingerprintDigest });
    expect(diffRuntimes(mainnet, mainnet, { plan }).plan?.stale).toBe(false);
  });
  it('the text report is plain and says it is a recorded-snapshot comparison, not monitoring', () => {
    const t = explainDrift(diffRuntimes(mainnet, devnode));
    expect(t).toMatch(/Runtime drift: yes/);
    expect(t).toMatch(/specVersion: 1002 -> 100/);
    expect(t).toMatch(/not a live check/i);
  });
  it('drift has its own non-zero exit code', () => {
    expect(EXIT[SeamCode.RuntimeDrift]).not.toBe(0);
  });
});

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = (...a: string[]) => spawnSync('node', [cli, ...a], { encoding: 'utf8' });
describe.skipIf(!existsSync(cli))('seam drift (CLI, needs a built dist)', () => {
  it('same snapshot twice: exit 0; different runtimes: exit for runtime_drift with code in --json', () => {
    expect(run('drift', dir('./fixtures'), dir('./fixtures')).status).toBe(0);
    const o = run('drift', dir('./fixtures'), dir('./fixtures/devnode'), '--json');
    expect(o.status).toBe(EXIT[SeamCode.RuntimeDrift]);
    const j = JSON.parse(o.stdout);
    expect([j.code, j.drifted]).toEqual(['runtime_drift', true]);
  });
  it('with --plan, a stale plan is reported', () => {
    const plan = compile(defineManifest({ signer: { type: 'ss58', value: ALICE }, actions: [action.transfer('pay', { assetId: '1', amount: '1', recipient: BOB })] }), mainnet);
    const f = join(mkdtempSync(join(tmpdir(), 'seam-drift-')), 'plan.json');
    writeFileSync(f, JSON.stringify(plan));
    const o = run('drift', dir('./fixtures'), dir('./fixtures/devnode'), '--plan', f, '--json');
    expect(JSON.parse(o.stdout).plan.stale).toBe(true);
  });
  it('a missing snapshot is a usage error, not success', () => {
    expect(run('drift', '/nonexistent-a', '/nonexistent-b').status).not.toBe(0);
  });
});
