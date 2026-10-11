import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { compile } from '@seam/compiler';
import { defineManifest, action, explainPlan, factsFromSnapshot, locateSnapshot } from '../src/index.js';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const demo = () => defineManifest({ signer: { type: 'ss58', value: ALICE }, actions: [
  action.transfer('pay', { assetId: '1', amount: '2500', recipient: BOB }),
  action.mint('receipt', { assetId: '2', amount: '1', recipient: BOB }),
  { id: 'nft', kind: 'nfts.mint', args: { collection: '0', item: '1', recipient: BOB } },
] });

describe('compiling one Manifest against different real runtimes', () => {
  const mainnet = factsFromSnapshot(dir('./fixtures'));
  const devnode = factsFromSnapshot(dir('./fixtures/devnode'));

  it('reads both snapshots, including a token the node only declared', () => {
    expect([mainnet.fingerprint.specName, mainnet.fingerprint.specVersion, mainnet.fingerprint.tokenSymbol]).toEqual(['portaldot', 1002, 'POT']);
    expect([devnode.fingerprint.specName, devnode.fingerprint.specVersion, devnode.fingerprint.tokenSymbol]).toEqual(['substrate-contracts-node', 100, 'UNIT']);
    expect(devnode.fingerprintDigest).not.toBe(mainnet.fingerprintDigest);
  });

  it('takes call indexes from each runtime, so the same Manifest encodes differently', () => {
    const a = compile(demo(), mainnet), b = compile(demo(), devnode);
    expect(a.manifestDigest).toBe(b.manifestDigest);
    expect(a.steps[0]!.encodedCall).not.toBe(b.steps[0]!.encodedCall);
    expect(a.fingerprintDigest).not.toBe(b.fingerprintDigest);
  });

  it('marks Revive observed on the test chain and not observed on Portaldot mainnet', () => {
    expect(mainnet.capabilities['Revive.call']!.status).toBe('not_observed');
    expect(devnode.capabilities['Revive.call']!.status).toBe('observed');
    expect(explainPlan(compile(demo(), devnode))).toContain("nft: can't run, because Nfts.mint is not on this runtime");
  });

  it('finds the snapshot from a folder, a file, or a folder plus a name, and refuses to guess', () => {
    expect(locateSnapshot(dir('./fixtures/devnode')).name).toBe('substrate-contracts-node-spec100');
    expect(locateSnapshot(dir('./fixtures/devnode/substrate-contracts-node-spec100-snapshot.json')).name).toBe('substrate-contracts-node-spec100');
    expect(() => locateSnapshot(dir('./fixtures/devnode'), 'nope')).not.toThrow();
    expect(() => factsFromSnapshot(dir('./fixtures/devnode'), { name: 'nope' })).toThrow();
  });
});
