import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeFingerprintDigest, factsFromMetadata, readPinnedTypes } from '@seam/compiler';
import { checkRuntimeLock, fingerprintDigest as policyFingerprintDigest } from '@seam/policy';
import {
  discover, factsFromChainInputs, fingerprintFromChainInputs, readFingerprint, refetchFingerprint, snapshotFromChainInputs,
  snapshotFromNode, tokenInfo, chainInputsFromSnapshot, listRpcMethods, readCheckpoint, signedExtensionsOf
} from '../src/index.js';
import { FakeNode } from './fakeNode.js';
import { metadataHex, snapshot, snapshotFacts, snapshotInputs } from './helpers.js';

const compilerFacts = () => factsFromMetadata({
  metadataHex, typesBundle: readPinnedTypes(), genesisHash: snapshot.genesis,
  tokenSymbol: 'POT', tokenDecimals: 14, specName: 'portaldot', specVersion: 1002, transactionVersion: 2, ss58Prefix: 42
});

describe('discovery from the real spec 1002 snapshot', () => {
  it('builds the same RuntimeFacts fingerprint as the compiler', () => {
    const facts = factsFromChainInputs(snapshotInputs());
    const expected = compilerFacts();
    expect(facts.fingerprint).toEqual(expected.fingerprint);
    expect(facts.fingerprintDigest).toBe(expected.fingerprintDigest);
    expect(facts.fingerprint).toMatchObject({ specName: 'portaldot', specVersion: 1002, transactionVersion: 2, ss58Prefix: 42, tokenSymbol: 'POT', tokenDecimals: 14 });
    expect(facts.fingerprint.metadataHash).toBe(`0x${snapshot.metadata_blake2b256}`);
    expect(facts.blockNumber).toBe(2721455);
    expect(facts.endpoint).toBe('wss://mainnet.portaldot.io');
  });

  it('a refetched fingerprint from the snapshot inputs equals the compiler digest and Bot 3\'s digest', () => {
    const fresh = fingerprintFromChainInputs(snapshotInputs());
    expect(fresh.fingerprintDigest).toBe(computeFingerprintDigest(compilerFacts().fingerprint));
    expect(policyFingerprintDigest(fresh.fingerprint)).toBe(fresh.fingerprintDigest);
    expect(checkRuntimeLock(compilerFacts().fingerprint, fresh.fingerprint).ok).toBe(true);
    expect(fresh.atBlock).toEqual({ number: snapshot.block, hash: snapshot.block_hash });
  });

  it('discover() and refetchFingerprint() over RPC (fake node replaying the snapshot) give the same digest', async () => {
    const node = new FakeNode({ inputs: snapshotInputs(), facts: snapshotFacts() });
    const facts = await discover(node);
    expect(facts.fingerprintDigest).toBe(compilerFacts().fingerprintDigest);
    expect(facts.capabilities['Assets.transfer_keep_alive']).toMatchObject({ status: 'observed', palletIndex: 26, callIndex: 6 });
    const fp = await refetchFingerprint(node);
    expect(computeFingerprintDigest(fp)).toBe(facts.fingerprintDigest);
    expect((await readFingerprint(node)).atBlock.number).toBe(2721455);
    // every read is pinned to the best block hash
    const pinned = node.log.filter((c) => c.method === 'state_getMetadata' || c.method === 'state_getRuntimeVersion');
    expect(pinned.every((c) => c.params[0] === snapshot.block_hash)).toBe(true);
    expect(await readCheckpoint(node)).toEqual({ number: snapshot.block, hash: snapshot.block_hash });
    expect(await listRpcMethods(node)).toContain('contracts_call');
  });

  it('the runtime lock catches a runtime upgrade', () => {
    const inputs = snapshotInputs();
    expect(() => factsFromChainInputs({ ...inputs, runtimeVersion: { ...inputs.runtimeVersion, specVersion: 1003 } })).toThrow(/FACTS_MISMATCH: specVersion mismatch/);
    const other = fingerprintFromChainInputs({ ...inputs, properties: { ...inputs.properties, tokenSymbol: 'DOT' } });
    const lock = checkRuntimeLock(compilerFacts().fingerprint, other.fingerprint);
    expect(lock.ok).toBe(false);
    expect(lock.changed).toEqual(['tokenSymbol']);
  });

  it('never guesses missing token info', () => {
    expect(() => tokenInfo({ ss58Format: 42 })).toThrow(/NODE_MISSING_VALUE.*tokenSymbol/);
    expect(() => tokenInfo({ tokenSymbol: 'POT' })).toThrow(/tokenDecimals/);
    expect(tokenInfo({ tokenSymbol: ['POT', 'X'], tokenDecimals: [14, 12] })).toEqual({ tokenSymbol: 'POT', tokenDecimals: 14 });
  });

  it('reads the signed extensions from metadata', () => {
    expect(signedExtensionsOf(metadataHex)).toEqual(['CheckSpecVersion', 'CheckTxVersion', 'CheckGenesis', 'CheckMortality', 'CheckNonce', 'CheckWeight', 'ChargeTransactionPayment']);
  });

  it('snapshot JSON round-trips in the original evidence format', () => {
    const snap = snapshotFromChainInputs(snapshotInputs());
    for (const k of ['endpoint', 'block', 'block_hash', 'genesis', 'runtime', 'metadata_blake2b256', 'properties'] as const) {
      expect(snap[k]).toEqual(snapshot[k]);
    }
    expect(snap.fingerprintDigest).toBe(compilerFacts().fingerprintDigest);
    expect(() => chainInputsFromSnapshot(snapshot, metadataHex.slice(0, -2) + '00')).toThrow(/does not match the snapshot/);
  });

  it('snapshotFromNode writes the evidence files', async () => {
    const node = new FakeNode({ inputs: snapshotInputs(), facts: snapshotFacts() });
    const dir = mkdtempSync(join(tmpdir(), 'seam-chain-'));
    const out = await snapshotFromNode(node, dir, { name: 'portaldot-test' });
    expect(out.metadataPath).toBe(join(dir, 'portaldot-test-metadata.hex'));
    expect(readFileSync(out.metadataPath, 'utf8')).toBe(metadataHex);
    const written = JSON.parse(readFileSync(out.snapshotPath, 'utf8'));
    expect(written.metadata_blake2b256).toBe(snapshot.metadata_blake2b256);
    expect(written.rpcMethods).toContain('author_submitAndWatchExtrinsic');
    expect(typeof written.fetchedAt).toBe('string');
  });
});
