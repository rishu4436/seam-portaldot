import { describe, expect, it } from 'vitest';
import { compile, computeManifestDigest, factsFromMetadata, type Manifest, type RuntimeFacts } from '../src/index.js';
import { ALICE, BOB, GENESIS, H160, demoManifest, expectIssue, metadataHex, proofFor, realFacts, snapshot, typesBundle, withBareVerified, withRollback } from './helpers.js';

const base = realFacts();
const verified = withRollback(base, 'verified');

// Digests recorded from the unmodified compiler (a3bc52b) for the demo manifest: must never move.
const GOLD = {
  manifest: '0xb7ceb459813eca8496cc9ea090b879a13a175dbbc09eea0b147ad76e445edd25',
  planSequential: '0xe5ba74c5848c8997c65ef336e3463a4bb27d187e51ca6e952139d90d26778aab',
  planAtomicVerified: '0x527142599aadbdad9fcc9a78da114acb6418a186c283c83565eb0129613e4418',
  fingerprint: '0xfa84b636f16022d59470133e37c4130e936421a85d272363fb394b1116eba896'
};

describe('SEAM-013 atomicRequired vs preferredMode', () => {
  const req = (): Manifest => ({ ...demoManifest(), atomicRequired: true });

  it('atomicRequired + rollback unverified -> unavailable, clear reason, no executable calls', () => {
    const p = compile(req(), base);
    expect(p.mode).toBe('unavailable');
    expect(p.modeReason).toMatch(/atomic execution is required/i);
    expect(p.outerCall).toBeUndefined();
    expect(p.modeDowngrade).toBeUndefined();
    expect(p.steps.every((s) => s.encodedCall === null && s.status === 'unavailable')).toBe(true);
    expect(p.steps.every((s) => s.reasonCode === 'ATOMIC_REQUIRED_UNAVAILABLE')).toBe(true);
  });

  it('atomicRequired + no batch_all -> unavailable', () => {
    const noBatch: RuntimeFacts = { ...base, capabilities: { ...base.capabilities, 'Utility.batch_all': { status: 'not_observed' } } };
    const p = compile(req(), noBatch, { allowAtomicUnverified: true });
    expect(p.mode).toBe('unavailable');
    expect(p.steps.every((s) => s.encodedCall === null)).toBe(true);
  });

  it('atomicRequired + batch_all does not roll back -> unavailable', () => {
    expect(compile(req(), withRollback(base, 'not_supported'), { allowAtomicUnverified: true }).mode).toBe('unavailable');
  });

  it('atomicRequired + verified rollback proof -> atomic_verified', () => {
    const p = compile(req(), verified);
    expect(p.mode).toBe('atomic_verified');
    expect(p.outerCall).toBeDefined();
  });

  it('atomicRequired + unverified rollback is only batched when allowAtomicUnverified is set', () => {
    expect(compile(req(), base, { allowAtomicUnverified: true }).mode).toBe('atomic_unverified');
  });

  it('atomicRequired conflicts with preferredMode sequential -> unavailable', () => {
    const m = req();
    m.actions[0]!.preferredMode = 'sequential';
    const p = compile(m, verified);
    expect(p.mode).toBe('unavailable');
    expect(p.modeReason).toMatch(/sequential/);
  });

  it('atomicRequired on a single step is fine: one step is atomic by itself', () => {
    const m: Manifest = { ...demoManifest(), atomicRequired: true, actions: [demoManifest().actions[0]!] };
    expect(compile(m, base).mode).toBe('sequential');
  });

  it('atomicRequired must be a boolean', () => {
    expectIssue(() => compile({ ...demoManifest(), atomicRequired: 'yes' as any }, base), 'MANIFEST_INVALID', 'atomicRequired');
  });

  it('preferredMode atomic that falls back is flagged with modeDowngrade (needs approval)', () => {
    const m = demoManifest();
    m.actions[0]!.preferredMode = 'atomic';
    const p = compile(m, base);
    expect(p.mode).toBe('sequential');
    expect(p.modeReason).toMatch(/^Atomic execution was requested but is not available/);
    expect(p.modeDowngrade).toMatchObject({ from: 'atomic', to: 'sequential', requiresApproval: true });
    expect(p.modeDowngrade!.partialExecutionRisk).toMatch(/earlier steps/i);
    expect(p.steps.every((s) => s.status === 'ok' && s.encodedCall)).toBe(true);
  });

  it('no downgrade flag when atomic was never requested, or when atomic is honoured', () => {
    expect(compile(demoManifest(), base).modeDowngrade).toBeUndefined();
    const m = demoManifest();
    m.actions[0]!.preferredMode = 'atomic';
    expect(compile(m, verified).modeDowngrade).toBeUndefined();
    expect('modeDowngrade' in compile(demoManifest(), base)).toBe(false);
  });

  it('digests of plans that do not use the new fields are unchanged from a3bc52b', () => {
    expect(computeManifestDigest(demoManifest())).toBe(GOLD.manifest);
    expect(compile(demoManifest(), base).planDigest).toBe(GOLD.planSequential);
    expect(compile(demoManifest(), verified).planDigest).toBe(GOLD.planAtomicVerified);
    expect(base.fingerprintDigest).toBe(GOLD.fingerprint);
  });

  it('the new field is part of the manifest digest only when present', () => {
    expect(computeManifestDigest({ ...demoManifest(), atomicRequired: true })).not.toBe(GOLD.manifest);
  });
});

describe('SEAM-012 atomic_verified needs a matching proof object', () => {
  it('proof matching genesis + metadata + spec + composition promotes', () => {
    expect(compile(demoManifest(), verified).mode).toBe('atomic_verified');
  });

  it("bare 'verified' string never reaches atomic_verified", () => {
    const f = withBareVerified(base);
    expect(compile(demoManifest(), f).mode).toBe('sequential');
    const p = compile(demoManifest(), f, { allowAtomicUnverified: true });
    expect(p.mode).toBe('atomic_unverified');
    expect(p.modeReason).toMatch(/deprecated/i);
    expect(p.modeReason).toMatch(/proof/i);
  });

  it('a proof copied from another genesis cannot promote', () => {
    const f: RuntimeFacts = { ...base, behaviour: { batchAllRollback: 'verified', batchAllRollbackProof: { ...proofFor(base), genesisHash: `0x${'11'.repeat(32)}` } } };
    expect(compile(demoManifest(), f).mode).toBe('sequential');
    const p = compile(demoManifest(), f, { allowAtomicUnverified: true });
    expect(p.mode).toBe('atomic_unverified');
    expect(p.modeReason).toMatch(/genesisHash/);
  });

  it.each([
    ['metadataHash', { metadataHash: `0x${'22'.repeat(32)}` }],
    ['specVersion', { specVersion: 9999 }],
    ['fingerprintDigest', { fingerprintDigest: `0x${'33'.repeat(32)}` }],
    ['txHash/blockHash', { txHash: undefined, blockHash: undefined }],
    ['preState', { preState: undefined }],
    ['postState', { postState: null }],
    ['composition', { composition: ['assets.transfer'] }],
    ['composition', { composition: [] }]
  ] as const)('proof with bad %s cannot promote', (field, patch) => {
    const f: RuntimeFacts = { ...base, behaviour: { batchAllRollback: 'verified', batchAllRollbackProof: { ...proofFor(base), ...(patch as any) } } };
    expect(compile(demoManifest(), f).mode).not.toBe('atomic_verified');
    expect(compile(demoManifest(), f, { allowAtomicUnverified: true }).modeReason).toContain(field.split('/')[0]!);
  });

  it('a proof for a subset-of-kinds batch does not cover a bigger plan, but covers a smaller one', () => {
    const f: RuntimeFacts = { ...base, behaviour: { batchAllRollback: 'verified', batchAllRollbackProof: proofFor(base, ['assets.transfer', 'assets.mint']) } };
    expect(compile(demoManifest(), f).mode).not.toBe('atomic_verified');
    const m = demoManifest();
    m.actions = [m.actions[0]!, m.actions[2]!];
    expect(compile(m, f).mode).toBe('atomic_verified');
  });

  it("a proof without the 'verified' claim does not promote", () => {
    const f: RuntimeFacts = { ...base, behaviour: { batchAllRollback: 'unknown', batchAllRollbackProof: proofFor(base) } };
    expect(compile(demoManifest(), f).mode).toBe('sequential');
  });

  it('a proof is never trusted over not_supported', () => {
    const f: RuntimeFacts = { ...base, behaviour: { batchAllRollback: 'not_supported', batchAllRollbackProof: proofFor(base) } };
    expect(compile(demoManifest(), f, { allowAtomicUnverified: true }).mode).toBe('sequential');
  });

  it('factsFromMetadata passes a proof through', () => {
    const f = realFacts({ batchAllRollback: 'verified', batchAllRollbackProof: proofFor(base) });
    expect(f.behaviour.batchAllRollbackProof).toEqual(proofFor(base));
    expect(compile(demoManifest(), f).mode).toBe('atomic_verified');
  });
});

describe('SEAM-009 signer domain (20-byte H160 vs 32-byte AccountId32)', () => {
  it('h160 signer on a runtime that signs with AccountId32 -> precise blocker, no conversion', () => {
    const m: Manifest = { version: 1, signer: { type: 'h160', value: H160 }, actions: [{ id: 'r', kind: 'revive.call', args: { contract: H160, value: '0', data: '0x' } }] };
    expectIssue(() => compile(m, base), 'SIGNER_DOMAIN_MISMATCH', 'signer');
    try {
      compile(m, base);
    } catch (e: any) {
      const msg = e.issues[0].message as string;
      expect(msg).toMatch(/20-byte/);
      expect(msg).toMatch(/32-byte/);
      expect(msg).toMatch(/no implicit conversion|not converted/i);
    }
  });

  it('h160 signer with native actions -> the same domain blocker', () => {
    expectIssue(() => compile({ ...demoManifest(), signer: { type: 'h160', value: H160 } }, base), 'SIGNER_DOMAIN_MISMATCH', 'signer');
  });

  it('32-byte signer on a runtime whose facts require a 20-byte signing account -> blocker', () => {
    const f: RuntimeFacts = { ...base, signingAccountBytes: 20 };
    expectIssue(() => compile(demoManifest(), f), 'SIGNER_DOMAIN_MISMATCH', 'signer');
  });

  it('h160 signer is accepted when facts say the signing account is 20 bytes', () => {
    const f: RuntimeFacts = { ...base, signingAccountBytes: 20 };
    const m: Manifest = { version: 1, signer: { type: 'h160', value: H160 }, actions: [{ id: 'r', kind: 'revive.call', args: { contract: H160, value: '0', data: '0x' } }] };
    const p = compile(m, f);
    expect(p.signer.type).toBe('h160');
    expect(p.mode).toBe('unavailable');
  });
});

describe('SEAM-011 facts: versions and token provenance', () => {
  it('captures metadataVersion from the metadata and stateVersion when provided', () => {
    expect(base.metadataVersion).toBe(13);
    expect(base.stateVersion).toBeUndefined();
    expect(realFacts({ stateVersion: 1 }).stateVersion).toBe(1);
  });

  it('rejects a metadataVersion that disagrees with the metadata', () => {
    expect(() => realFacts({ metadataVersion: 14 })).toThrow(/metadataVersion mismatch/);
  });

  it('token properties default to declared; observed only when the caller says so', () => {
    expect(base.tokenProvenance).toEqual({ tokenSymbol: 'declared', tokenDecimals: 'declared' });
    expect(realFacts({ tokenProvenance: { tokenSymbol: 'observed', tokenDecimals: 'observed' } }).tokenProvenance).toEqual({ tokenSymbol: 'observed', tokenDecimals: 'observed' });
  });

  it('none of it changes the fingerprint or its digest (schema V1 byte-identical)', () => {
    const f = realFacts({ stateVersion: 1, tokenProvenance: { tokenSymbol: 'observed', tokenDecimals: 'observed' } });
    expect(f.fingerprint).toEqual(base.fingerprint);
    expect(f.fingerprintDigest).toBe(GOLD.fingerprint);
    expect(Object.keys(f.fingerprint).sort()).toEqual(['genesisHash', 'metadataHash', 'specName', 'specVersion', 'ss58Prefix', 'tokenDecimals', 'tokenSymbol', 'transactionVersion', 'typesBundleHash']);
  });

  it('references stay used', () => {
    expect([ALICE, BOB, GENESIS, metadataHex.length, typesBundle.length, snapshot.block, factsFromMetadata].length).toBe(7);
  });
});

describe('SEAM-006/007 revive.call and nfts.mint: honest capability blockers', () => {
  const cases = [
    ['revive.call', 'Revive.call', { contract: H160, value: '0', data: '0x00' }],
    ['nfts.mint', 'Nfts.mint', { collection: '0', item: '1', recipient: BOB }]
  ] as const;

  it.each(cases)('%s -> unavailable, stable code, names missing V3 metadata, never bytes', (kind, cap, args) => {
    const signer: Manifest['signer'] = kind === 'revive.call' ? { type: 'h160', value: H160 } : { type: 'ss58', value: ALICE };
    const f: RuntimeFacts = kind === 'revive.call' ? { ...verified, signingAccountBytes: 20 } : verified;
    const p = compile({ version: 1, signer, actions: [{ id: 'x', kind, args }] }, f);
    expect(p.mode).toBe('unavailable');
    expect(p.steps[0]).toMatchObject({ status: 'unavailable', capability: cap, encodedCall: null, palletIndex: null, callIndex: null, reasonCode: 'NO_OBSERVED_V3_METADATA' });
    expect(p.steps[0]!.reason).toMatch(/no observed V3 Revive\/Nfts metadata exists/);
    expect(p.outerCall).toBeUndefined();
  });

  it('even when a runtime lists the capability, SEAM does not guess a layout', () => {
    const fake: RuntimeFacts = { ...verified, capabilities: { ...verified.capabilities, 'Nfts.mint': { status: 'observed', palletIndex: 26, callIndex: 3, args: [], argTypesConfidence: 'full' } } };
    const p = compile({ version: 1, signer: { type: 'ss58', value: ALICE }, actions: [{ id: 'x', kind: 'nfts.mint', args: { collection: '0', item: '1', recipient: BOB } }] }, fake);
    expect(p.mode).toBe('unavailable');
    expect(p.steps[0]!.encodedCall).toBeNull();
    expect(p.steps[0]!.reasonCode).toBe('NO_OBSERVED_V3_METADATA');
  });
});
