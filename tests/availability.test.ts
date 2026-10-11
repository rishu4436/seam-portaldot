import { describe, expect, it } from 'vitest';
import { compile, type Manifest } from '../src/index.js';
import { ALICE, BOB, H160, demoManifest, realFacts, withRollback } from './helpers.js';

const facts = withRollback(realFacts(), 'verified');

function single(action: Manifest['actions'][number], signer: Manifest['signer'] = { type: 'ss58', value: ALICE }): Manifest {
  return { version: 1, signer, actions: [action] };
}

describe('capabilities missing from the runtime', () => {
  it('nfts.mint -> step unavailable with a plain reason, mode unavailable', () => {
    const p = compile(single({ id: 'nft', kind: 'nfts.mint', args: { collection: 0, item: 1, recipient: BOB } }), facts);
    expect(p.mode).toBe('unavailable');
    expect(p.steps[0]).toMatchObject({ status: 'unavailable', capability: 'Nfts.mint', palletIndex: null, callIndex: null, encodedCall: null });
    expect(p.steps[0]!.reason).toBe('Nfts.mint is not on this runtime (spec 1002)');
    expect(p.outerCall).toBeUndefined();
  });

  it('revive.call -> step unavailable with a plain reason', () => {
    const p = compile(single({ id: 'r', kind: 'revive.call', args: { contract: H160, value: '0', data: '0x00' } }), facts);
    expect(p.mode).toBe('unavailable');
    expect(p.steps[0]!.reason).toBe('Revive.call is not on this runtime (spec 1002)');
  });

  it('one unavailable step makes the whole plan unavailable, other steps still shown encoded', () => {
    const m = demoManifest();
    m.actions.push({ id: 'nft', kind: 'nfts.mint', args: { collection: '0', item: '1', recipient: BOB } });
    const p = compile(m, facts);
    expect(p.mode).toBe('unavailable');
    expect(p.modeReason).toContain('step "nft": Nfts.mint is not on this runtime (spec 1002)');
    expect(p.steps.slice(0, 3).every((s) => s.status === 'ok' && s.encodedCall)).toBe(true);
    expect(p.outerCall).toBeUndefined();
  });

  it("a capability discovery marked 'unknown' is unavailable, not assumed", () => {
    const f = { ...facts, capabilities: { ...facts.capabilities, 'Assets.mint': { status: 'unknown' as const } } };
    const p = compile(demoManifest(), f);
    expect(p.mode).toBe('unavailable');
    expect(p.steps[2]!.reason).toMatch(/Assets.mint could not be confirmed/);
  });
});
