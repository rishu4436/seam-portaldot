import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { factsFromMetadata, readPinnedTypes, type ActionKind, type AtomicRollbackProof, type Manifest, type RuntimeFacts } from '../src/index.js';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export const snapshot = JSON.parse(readFileSync(fixture('portaldot-mainnet-snapshot.json'), 'utf8'));
export const metadataHex = readFileSync(fixture('portaldot-mainnet-metadata.hex'), 'utf8').trim();
export const realExtrinsic = JSON.parse(readFileSync(fixture('mainnet-extrinsic-2721116.json'), 'utf8'));
export const typesBundle = readPinnedTypes();

export const GENESIS = snapshot.genesis as string;
// Well-known dev accounts, SS58 prefix 42.
export const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
export const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
export const BOB_HEX = '0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48';
// Alice's key encoded with Polkadot (0) and Kusama (2) prefixes.
export const ALICE_POLKADOT = '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5';
export const ALICE_KUSAMA = 'HNZata7iMYWmk5RvZRTiAsSDhV8366zq2YGb3tLH5Upf74F';
export const H160 = '0x1111111111111111111111111111111111111111';

export function realFacts(overrides: Partial<Parameters<typeof factsFromMetadata>[0]> = {}): RuntimeFacts {
  return factsFromMetadata({
    metadataHex,
    typesBundle,
    genesisHash: GENESIS,
    tokenSymbol: snapshot.properties.tokenSymbol,
    tokenDecimals: snapshot.properties.tokenDecimals,
    specName: snapshot.runtime.specName,
    specVersion: snapshot.runtime.specVersion,
    transactionVersion: snapshot.runtime.transactionVersion,
    ss58Prefix: snapshot.properties.ss58Format,
    endpoint: snapshot.endpoint,
    blockNumber: snapshot.block,
    ...overrides
  });
}

export const ALL_KINDS: ActionKind[] = ['assets.transfer', 'assets.mint', 'contracts.call'];

/** A rollback proof that matches `facts` (same genesis, metadata hash, spec version) and covers `composition`. */
export function proofFor(facts: RuntimeFacts, composition: ActionKind[] = ALL_KINDS): AtomicRollbackProof {
  return {
    genesisHash: facts.fingerprint.genesisHash,
    metadataHash: facts.fingerprint.metadataHash,
    specVersion: facts.fingerprint.specVersion,
    txHash: `0x${'ab'.repeat(32)}`,
    blockHash: `0x${'cd'.repeat(32)}`,
    preState: { aliceBalance: '100' },
    postState: { aliceBalance: '100' },
    composition
  };
}

/**
 * Deep copy with a different batch_all rollback fact (behaviour is not in the fingerprint).
 * 'verified' attaches a matching proof; use withBareVerified for the deprecated bare string.
 */
export function withRollback(facts: RuntimeFacts, batchAllRollback: RuntimeFacts['behaviour']['batchAllRollback']): RuntimeFacts {
  if (batchAllRollback === 'verified') return { ...facts, behaviour: { batchAllRollback, batchAllRollbackProof: proofFor(facts) } };
  return { ...facts, behaviour: { batchAllRollback } };
}

/** The deprecated shape: the string 'verified' with no proof object. */
export function withBareVerified(facts: RuntimeFacts): RuntimeFacts {
  return { ...facts, behaviour: { batchAllRollback: 'verified' } };
}

export function demoManifest(): Manifest {
  return {
    version: 1,
    chain: { genesisHash: GENESIS, specVersion: 1002 },
    signer: { type: 'ss58', value: ALICE, ss58Prefix: 42 },
    actions: [
      { id: 'pay', kind: 'assets.transfer', args: { assetId: '1', amount: '2500000000000000', recipient: BOB } },
      { id: 'call', kind: 'contracts.call', args: { contract: BOB, value: '0', gasLimit: '5000000000', data: '0x633aa551' } },
      { id: 'receipt', kind: 'assets.mint', args: { assetId: '2', amount: '1', recipient: BOB } }
    ]
  };
}

export function expectIssue(fn: () => unknown, code: string, pathPart?: string): void {
  try {
    fn();
  } catch (e: any) {
    const issues = e.issues as { code: string; path?: string }[] | undefined;
    if (!issues) throw e;
    const hit = issues.find((i) => i.code === code && (pathPart === undefined || (i.path ?? '').includes(pathPart)));
    if (!hit) throw new Error(`expected ${code}${pathPart ? ` at ${pathPart}` : ''}, got ${JSON.stringify(issues)}`);
    return;
  }
  throw new Error(`expected ${code} but compile succeeded`);
}
