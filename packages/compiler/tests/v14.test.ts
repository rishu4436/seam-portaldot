import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NO_PINNED_TYPES,
  compile,
  factsFromMetadata,
  loadRuntime,
  readPinnedTypes,
  type Manifest,
  type RuntimeFacts
} from '../src/index.js';
import { ALICE, BOB, BOB_HEX, demoManifest, expectIssue, realFacts } from './helpers.js';

// Read-only capture of the local dev node (substrate-contracts-node v0.42.0, metadata V14), see fixtures/devnode-snapshot.json.
const fx = (n: string) => fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url));
const devSnap = JSON.parse(readFileSync(fx('devnode-snapshot.json'), 'utf8'));
const devMetadataHex = readFileSync(fx('devnode-metadata.hex'), 'utf8').trim();

// system_properties is empty on the dev node; UNIT/12 is the node's documented default, declared here.
function devFacts(typesBundle?: string): RuntimeFacts {
  return factsFromMetadata({
    metadataHex: devMetadataHex,
    ...(typesBundle !== undefined ? { typesBundle } : {}),
    genesisHash: devSnap.genesis,
    tokenSymbol: 'UNIT',
    tokenDecimals: 12,
    specName: devSnap.runtime.specName,
    specVersion: devSnap.runtime.specVersion,
    transactionVersion: devSnap.runtime.transactionVersion
  });
}

function devCall(args: Record<string, unknown>): Manifest {
  return {
    version: 1,
    chain: { genesisHash: devSnap.genesis, specVersion: 100 },
    signer: { type: 'ss58', value: ALICE },
    actions: [{ id: 'call', kind: 'contracts.call', args: { contract: BOB, value: '0', gasLimit: '5000000000', data: '0x633aa551', ...args } }]
  };
}

describe('metadata V14 runtimes (dev node): no pinned types', () => {
  const facts = devFacts();

  it('reads spec 100 / V14 with typesBundleHash null and no overrides', () => {
    expect(loadRuntime(devMetadataHex).metadataVersion).toBe(14);
    expect(facts.fingerprint).toMatchObject({ specName: 'substrate-contracts-node', specVersion: 100, ss58Prefix: 42, typesBundleHash: null });
    expect(facts.fingerprint.metadataHash).toBe(`0x${devSnap.metadata_blake2b256}`);
    expect(facts.source.typesBundle).toBe(NO_PINNED_TYPES);
    expect(facts.capabilities['Contracts.call']).toMatchObject({ status: 'observed', palletIndex: 8, callIndex: 6, argTypesConfidence: 'full' });
    expect(facts.capabilities['Contracts.call']!.args!.map((a) => a.name)).toEqual(['dest', 'value', 'gas_limit', 'storage_deposit_limit', 'data']);
  });

  it('ignores the Portaldot spec-1002 types file on a V14 runtime (same facts as with no file)', () => {
    const withPortaldot = devFacts(readPinnedTypes());
    expect(withPortaldot.fingerprintDigest).toBe(facts.fingerprintDigest);
    expect(withPortaldot.source.typesBundle).toBe(NO_PINNED_TYPES);
  });

  it('a V13 runtime still needs its pinned file, and the file must match the spec', () => {
    expect(() => realFacts({ typesBundle: undefined as unknown as string })).toThrow(/pinned types file is required/);
    const other = JSON.stringify({ ...JSON.parse(readPinnedTypes()), specVersion: 999 });
    expect(() => realFacts({ typesBundle: other })).toThrow(/pinned types file is for spec 999/);
    expect(realFacts().fingerprint.typesBundleHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('Contracts.call with Weight v2 (dev node)', () => {
  const facts = devFacts();

  it('encodes gas_limit as Weight {ref_time, proof_size} and storage_deposit_limit; the call decodes to exactly that', () => {
    const p = compile(devCall({ proofSize: '262144', storageDepositLimit: '1000000000000' }), facts);
    const s = p.steps[0]!;
    expect(s.status).toBe('ok');
    expect(s.decodedArgs).toMatchObject({ gasLimit: '5000000000', proofSize: '262144', storageDepositLimit: '1000000000000', data: '0x633aa551' });
    const { registry } = loadRuntime(devMetadataHex);
    const call = registry.createType('Call', s.encodedCall!);
    expect(`${call.section}.${call.method}`).toBe('contracts.call');
    const [dest, value, gas, sdl, data] = call.args as any[];
    expect(dest.type).toBe('Id');
    expect(dest.value.toHex()).toBe(BOB_HEX);
    expect(value.toString()).toBe('0');
    expect(gas.refTime.toString()).toBe('5000000000');
    expect(gas.proofSize.toString()).toBe('262144');
    expect(sdl.isSome && sdl.unwrap().toString()).toBe('1000000000000');
    expect(data.toHex()).toBe('0x633aa551');
    // 08 06 = Contracts.call (pallet 8, call 6), then MultiAddress::Id(Bob)
    expect(s.encodedCall!.startsWith(`0x080600${BOB_HEX.slice(2)}`)).toBe(true);
  });

  it('storageDepositLimit: null encodes None and is recorded as null', () => {
    const s = compile(devCall({ proofSize: '262144', storageDepositLimit: null }), facts).steps[0]!;
    expect(s.status).toBe('ok');
    expect(s.decodedArgs.storageDepositLimit).toBeNull();
    const call = loadRuntime(devMetadataHex).registry.createType('Call', s.encodedCall!);
    expect((call.args[3] as any).isNone).toBe(true);
  });

  it('omitted storageDepositLimit: unavailable with the reason, never guessed', () => {
    const p = compile(devCall({ proofSize: '262144' }), facts);
    expect(p.mode).toBe('unavailable');
    expect(p.steps[0]!.reason).toBe('Contracts.call on this runtime takes argument(s) SEAM cannot fill: storageDepositLimit');
  });

  it('omitted proofSize: unavailable with the reason', () => {
    const p = compile(devCall({ storageDepositLimit: null }), facts);
    expect(p.steps[0]!.status).toBe('unavailable');
    expect(p.steps[0]!.reason).toMatch(/Weight \{ ref_time, proof_size \}; the manifest must give proofSize/);
  });

  it('range and format checks', () => {
    expectIssue(() => compile(devCall({ proofSize: (1n << 64n).toString(), storageDepositLimit: null }), facts), 'AMOUNT_INVALID', 'actions[0].args.proofSize');
    expectIssue(() => compile(devCall({ gasLimit: (1n << 64n).toString(), proofSize: '1', storageDepositLimit: null }), facts), 'AMOUNT_INVALID', 'actions[0].args.gasLimit');
    expectIssue(() => compile(devCall({ proofSize: 262144, storageDepositLimit: null }), facts), 'AMOUNT_INVALID', 'actions[0].args.proofSize');
    expectIssue(() => compile(devCall({ proofSize: '1', storageDepositLimit: '-1' }), facts), 'AMOUNT_INVALID', 'actions[0].args.storageDepositLimit');
  });

  it('is deterministic', () => {
    const m = devCall({ proofSize: '262144', storageDepositLimit: null });
    expect(compile(m, devFacts()).planDigest).toBe(compile(m, facts).planDigest);
  });
});

describe('Contracts.call with Weight v1 (Portaldot spec 1002) is unchanged', () => {
  const facts = realFacts();

  it('proofSize / storageDepositLimit are refused there instead of dropped', () => {
    const m = demoManifest();
    (m.actions[1]!.args as any).proofSize = '1';
    expectIssue(() => compile(m, facts), 'MANIFEST_INVALID', 'actions[1].args.proofSize');
    const n = demoManifest();
    (n.actions[1]!.args as any).storageDepositLimit = null;
    expectIssue(() => compile(n, facts), 'MANIFEST_INVALID', 'actions[1].args.storageDepositLimit');
  });

  it('a plain demo step has no proofSize/storageDepositLimit keys (digests unchanged)', () => {
    const d = compile(demoManifest(), facts).steps[1]!.decodedArgs;
    expect(d).not.toHaveProperty('proofSize');
    expect(d).not.toHaveProperty('storageDepositLimit');
  });
});

describe('the three-step demo on the dev node', () => {
  it('compiles transfer -> contract call -> mint with indexes from V14 metadata', () => {
    const m: Manifest = {
      version: 1,
      signer: { type: 'ss58', value: ALICE },
      actions: [
        { id: 'pay', kind: 'assets.transfer', args: { assetId: '1', amount: '2500000000000000', recipient: BOB } },
        { id: 'call', kind: 'contracts.call', args: { contract: BOB, value: '0', gasLimit: '5000000000', proofSize: '262144', storageDepositLimit: null, data: '0x633aa551' } },
        { id: 'receipt', kind: 'assets.mint', args: { assetId: '2', amount: '1', recipient: BOB } }
      ]
    };
    const p = compile(m, devFacts());
    expect(p.steps.map((s) => [s.capability, s.palletIndex, s.callIndex, s.status])).toEqual([
      ['Assets.transfer_keep_alive', 10, 9, 'ok'],
      ['Contracts.call', 8, 6, 'ok'],
      ['Assets.mint', 10, 6, 'ok']
    ]);
  });
});

describe('ink! ABI form on the dev node (Weight v2)', () => {
  it('settle() on the SEAM demo contract via abiRef, with proofSize and no deposit limit', () => {
    const abi = JSON.parse(readFileSync(fx('ink/seam_demo.v5.json'), 'utf8'));
    const m = devCall({ data: undefined, message: 'settle', args: { order_id: 7, amount: '1000' }, abiRef: 'seam_demo', proofSize: '262144', storageDepositLimit: null });
    const s = compile(m, devFacts(), { abis: { seam_demo: abi } }).steps[0]!;
    expect(s.status).toBe('ok');
    expect(s.decodedArgs).toMatchObject({ message: 'settle', selector: '0x6c337222', proofSize: '262144', storageDepositLimit: null });
    const call = loadRuntime(devMetadataHex).registry.createType('Call', s.encodedCall!);
    expect((call.args[4] as any).toHex()).toBe(s.decodedArgs.data);
    expect(s.decodedArgs.data!.startsWith('0x6c337222')).toBe(true);
  });
});
