import { describe, expect, it } from 'vitest';
import { action, parseManifest } from '../src/index.js';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const base = () => ({ version: 1, signer: { type: 'ss58', value: ALICE }, actions: [action.transfer('pay', { assetId: '1', amount: '1', recipient: BOB })] });

describe('Manifest atomicRequired (SEAM-013, SDK side)', () => {
  it('passes atomicRequired through to the parsed manifest and changes the digest', () => {
    const plain = parseManifest(base());
    const req = parseManifest({ ...base(), atomicRequired: true });
    expect(req.ok).toBe(true);
    if (!req.ok || !plain.ok) return;
    expect(req.manifest.atomicRequired).toBe(true);
    expect(req.digest).not.toBe(plain.digest);
  });
  it('rejects a non-boolean atomicRequired in plain words', () => {
    const r = parseManifest({ ...base(), atomicRequired: 'yes' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain('$.atomicRequired');
  });
  it('still rejects unknown top-level fields', () => {
    expect(parseManifest({ ...base(), nope: 1 }).ok).toBe(false);
  });
});
