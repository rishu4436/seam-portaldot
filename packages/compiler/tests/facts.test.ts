import { describe, expect, it } from 'vitest';
import { computeFingerprintDigest, loadRuntime, parsePinnedTypes } from '../src/index.js';
import { metadataHex, realExtrinsic, realFacts, snapshot, typesBundle } from './helpers.js';

describe('factsFromMetadata on the real Portaldot mainnet snapshot', () => {
  const facts = realFacts();

  it('reads the fingerprint from the metadata itself', () => {
    expect(facts.fingerprint).toMatchObject({
      specName: 'portaldot',
      specVersion: 1002,
      transactionVersion: 2,
      ss58Prefix: 42,
      tokenSymbol: 'POT',
      tokenDecimals: 14,
      genesisHash: snapshot.genesis
    });
    expect(facts.fingerprintDigest).toBe(computeFingerprintDigest(facts.fingerprint));
  });

  it('metadataHash matches the blake2b-256 Bot 4 recorded in the snapshot', () => {
    expect(facts.fingerprint.metadataHash).toBe(`0x${snapshot.metadata_blake2b256}`);
  });

  it('takes pallet/call indexes from the metadata (cross-checked against the registry)', () => {
    const { registry } = loadRuntime(metadataHex, typesBundle);
    const expected: Record<string, [number, number]> = {
      'Assets.transfer_keep_alive': [26, 6],
      'Assets.mint': [26, 3],
      'Contracts.call': [13, 0],
      'Utility.batch_all': [1, 2],
      'Balances.transfer_keep_alive': [6, 3]
    };
    for (const [name, [p, c]] of Object.entries(expected)) {
      const cap = facts.capabilities[name]!;
      expect(cap.status, name).toBe('observed');
      expect([cap.palletIndex, cap.callIndex], name).toEqual([p, c]);
      const meta = registry.findMetaCall(new Uint8Array([p, c])).meta;
      expect(meta.name.toString()).toBe(name.split('.')[1]);
    }
  });

  it('marks Revive.call and Nfts.mint as not_observed (metadata read, call absent)', () => {
    expect(facts.capabilities['Revive.call']).toEqual({ status: 'not_observed' });
    expect(facts.capabilities['Nfts.mint']).toEqual({ status: 'not_observed' });
  });

  it('lists runtime arg names and flags unverified arg types as partial', () => {
    expect(facts.capabilities['Contracts.call']!.args!.map((a) => a.name)).toEqual(['dest', 'value', 'gas_limit', 'data']);
    expect(facts.capabilities['Contracts.call']!.argTypesConfidence).toBe('full');
    expect(facts.capabilities['Utility.batch_all']!.argTypesConfidence).toBe('full');
    // AssetId / asset Balance widths could not be checked on chain (no assets exist yet).
    expect(facts.capabilities['Assets.transfer_keep_alive']!.argTypesConfidence).toBe('partial');
    expect(facts.capabilities['Assets.mint']!.argTypesConfidence).toBe('partial');
  });

  it('defaults batchAllRollback to unknown (metadata cannot prove rollback)', () => {
    expect(facts.behaviour.batchAllRollback).toBe('unknown');
    expect(realFacts({ batchAllRollback: 'verified' }).behaviour.batchAllRollback).toBe('verified');
  });

  it('is deterministic', () => {
    expect(JSON.stringify(realFacts())).toBe(JSON.stringify(facts));
  });

  it('rejects caller values that disagree with the metadata', () => {
    expect(() => realFacts({ specVersion: 1003 })).toThrow(/specVersion mismatch/);
    expect(() => realFacts({ ss58Prefix: 0 })).toThrow(/ss58Prefix mismatch/);
  });

  it('typesBundleHash changes when the pinned types change', () => {
    const edited = JSON.stringify({ ...parsePinnedTypes(typesBundle), types: { ...parsePinnedTypes(typesBundle).types, AssetId: 'u64' } });
    const other = realFacts({ typesBundle: edited });
    expect(other.fingerprint.typesBundleHash).not.toBe(facts.fingerprint.typesBundleHash);
    expect(other.fingerprintDigest).not.toBe(facts.fingerprintDigest);
  });
});

describe('pinned types against real chain data', () => {
  it('a real signed mainnet extrinsic decodes and re-encodes byte-identically (MultiAddress)', () => {
    const { registry } = loadRuntime(metadataHex, typesBundle);
    const ex = registry.createType('Extrinsic', realExtrinsic.extrinsic);
    expect(ex.isSigned).toBe(true);
    expect(`${ex.method.section}.${ex.method.method}`).toBe('balances.transferKeepAlive');
    expect(ex.toHex()).toBe(realExtrinsic.extrinsic);
    // Rebuild the call from its decoded args with our encoder path and compare bytes.
    const fn = registry.findMetaCall(new Uint8Array([6, 3]));
    const [dest, value] = ex.method.args as any[];
    expect(dest.type).toBe('Id');
    expect(fn({ Id: dest.value.toHex() }, value.toString()).toHex()).toBe(ex.method.toHex());
  });
});
