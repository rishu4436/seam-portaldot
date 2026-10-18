import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeFingerprintDigest, factsFromMetadata, readPinnedTypes } from '@seam/compiler';
import { checkRuntimeLock, fingerprintDigest as policyFingerprintDigest } from '@seam/policy';
import {
  discover, factsFromChainInputs, fingerprintFromChainInputs, readFingerprint, refetchFingerprint, snapshotFromChainInputs,
  snapshotFromNode, tokenInfo, quietly, chainInputsFromSnapshot, listRpcMethods, readCheckpoint, signedExtensionsOf
} from '../src/index.js';
import { FakeNode } from './fakeNode.js';
import { metadataHex, snapshot, snapshotFacts, snapshotInputs } from './helpers.js';

// factsFromMetadata (compiler 14faeb7) still prints the lookup warning from expandMetadata; see README.
const compilerFacts = () => quietly(() => factsFromMetadata({
  metadataHex, typesBundle: readPinnedTypes(), genesisHash: snapshot.genesis,
  tokenSymbol: 'POT', tokenDecimals: 14, specName: 'portaldot', specVersion: 1002, transactionVersion: 2, ss58Prefix: 42
}));

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

describe('readSigningCheckpoint', () => {
  const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  const stub = (finalized: number, best: number) => ({
    async send(method: string, params: unknown[]) {
      if (method === 'chain_getFinalizedHead') return H(finalized);
      if (method === 'chain_getBlockHash') return H(best);
      if (method === 'chain_getHeader') { const n = parseInt(String(params[0]), 16); return { number: `0x${n.toString(16)}`, parentHash: H(n - 1) }; }
      throw new Error(method);
    },
    async subscribe() { throw new Error('no'); }, async unsubscribe() { return true; }
  });
  it('uses the finalized head when finality lags the best block (Portaldot)', async () => {
    const { readSigningCheckpoint } = await import('../src/index.js');
    expect(await readSigningCheckpoint(stub(10, 12) as never)).toEqual({ number: 10, hash: H(10) });
  });
  it('uses the parent when the finalized head is the best block (instant seal), so system_dryRun sees its BlockHash', async () => {
    const { readSigningCheckpoint } = await import('../src/index.js');
    expect(await readSigningCheckpoint(stub(10, 10) as never)).toEqual({ number: 9, hash: H(9) });
  });
});

describe('declaredToken (node without tokenSymbol/tokenDecimals in system_properties)', () => {
  it('tokenInfo uses declared values only when the node reports none, and refuses a disagreement', async () => {
    const { tokenInfo } = await import('../src/index.js');
    expect(tokenInfo({}, { tokenSymbol: 'UNIT', tokenDecimals: 12 })).toEqual({ tokenSymbol: 'UNIT', tokenDecimals: 12 });
    expect(tokenInfo({ tokenSymbol: 'POT', tokenDecimals: 14 }, { tokenSymbol: 'POT', tokenDecimals: 14 })).toEqual({ tokenSymbol: 'POT', tokenDecimals: 14 });
    expect(() => tokenInfo({ tokenSymbol: 'POT', tokenDecimals: 14 }, { tokenSymbol: 'UNIT', tokenDecimals: 14 })).toThrow(/FACTS_MISMATCH.*declared tokenSymbol UNIT/);
    expect(() => tokenInfo({}, undefined)).toThrow(/NODE_MISSING_VALUE/);
  });

  it('createPortaldotAdapter passes declaredToken to discovery', async () => {
    const { createPortaldotAdapter } = await import('../src/index.js');
    const { FakeNode } = await import('./fakeNode.js');
    const { snapshotFacts, snapshotInputs } = await import('./helpers.js');
    const inputs = { ...snapshotInputs(), properties: { ss58Format: 42 } };
    const node = new FakeNode({ inputs, facts: snapshotFacts() });
    await expect(createPortaldotAdapter(node).discover()).rejects.toThrow(/NODE_MISSING_VALUE/);
    const facts = await createPortaldotAdapter(node, { declaredToken: { tokenSymbol: 'POT', tokenDecimals: 14 } }).discover();
    expect(facts.fingerprint).toMatchObject({ tokenSymbol: 'POT', tokenDecimals: 14 });
    // same nine fields as the node that reports them, so the same digest
    expect(facts.fingerprintDigest).toBe(snapshotFacts().fingerprintDigest);
  });
});

describe('discovery records audit facts', () => {
  it('records stateVersion, observed token provenance, metadataVersion and signingAccountBytes from the node', () => {
    const inputs = snapshotInputs();
    inputs.runtimeVersion = { ...inputs.runtimeVersion, stateVersion: 1 };
    const facts = factsFromChainInputs(inputs);
    expect(facts.stateVersion).toBe(1);
    expect(facts.signingAccountBytes).toBe(32);
    expect(facts.metadataVersion).toBeGreaterThan(0);
    expect(facts.tokenProvenance).toEqual({ tokenSymbol: 'observed', tokenDecimals: 'observed' });
  });
  it('marks declared token facts as declared when the node reports none', () => {
    const inputs = snapshotInputs();
    inputs.properties = { ss58Format: inputs.properties.ss58Format };
    const facts = factsFromChainInputs(inputs, { declaredToken: { tokenSymbol: 'POT', tokenDecimals: 12 } });
    expect(facts.tokenProvenance).toEqual({ tokenSymbol: 'declared', tokenDecimals: 'declared' });
  });
});
