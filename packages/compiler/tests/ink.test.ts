import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blake2AsHex } from '@polkadot/util-crypto';
import { describe, expect, it } from 'vitest';
import {
  compile,
  computeAbiHash,
  computePlanDigest,
  decodeInkMessage,
  loadRuntime,
  type Manifest,
  type ManifestAction
} from '../src/index.js';
import { ALICE, ALICE_POLKADOT, BOB, BOB_HEX, demoManifest, expectIssue, metadataHex, realFacts, typesBundle } from './helpers.js';

const ink = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/ink/${name}`, import.meta.url)), 'utf8'));
const ERC20 = ink('erc20.v5.json'); // ink! 5 metadata (V5), from polkadot-js/api test fixtures
const FLIPPER = ink('flipper.v3.json'); // ink! 3.0.0-rc7 metadata (V3)

const facts = realFacts();
const { registry } = loadRuntime(metadataHex, typesBundle);

function inkCall(args: Record<string, unknown>): Manifest {
  const m = demoManifest();
  m.actions[1] = { id: 'call', kind: 'contracts.call', args: { contract: BOB, value: '0', gasLimit: '5000000000', ...args } } as ManifestAction;
  return m;
}
const transfer = (extra: Record<string, unknown> = {}) =>
  inkCall({ message: 'transfer', args: { to: BOB, value: '1000' }, abi: ERC20, ...extra });

function reverseKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(reverseKeys) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys((v as any)[k])])) as T;
  return v;
}

describe('contracts.call from an ink! ABI', () => {
  it('encodes data = selector + SCALE args and records abiHash, message, selector and decoded args', () => {
    const p = compile(transfer(), facts);
    const s = p.steps[1]!;
    expect(s.status).toBe('ok');
    // 84a15da1 = transfer; AccountId (32 bytes); u128 1000 little-endian
    const expected = `0x84a15da1${BOB_HEX.slice(2)}e8030000000000000000000000000000`;
    expect(s.decodedArgs.data).toBe(expected);
    expect(s.decodedArgs).toMatchObject({ message: 'transfer', selector: '0x84a15da1', abiHash: computeAbiHash(ERC20) });
    expect(s.contractMessage).toEqual({ abiHash: computeAbiHash(ERC20), message: 'transfer', selector: '0x84a15da1', args: { to: BOB, value: '1000' } });
    // Policy's selector filter reads the first 4 bytes of data.
    expect(s.decodedArgs.data!.slice(0, 10)).toBe(s.contractMessage!.selector);
    // The runtime call carries exactly those bytes.
    const call = registry.createType('Call', s.encodedCall!);
    expect(`${call.section}.${call.method}`).toBe('contracts.call');
    expect((call.args[3] as any).toHex()).toBe(expected);
  });

  it("selector is ink!'s default: first 4 bytes of blake2b-256(label)", () => {
    for (const label of ['transfer', 'approve', 'balance_of', 'transfer_from']) {
      const sel = blake2AsHex(label, 256).slice(0, 10);
      const m = inkCall({ message: label, args: label === 'balance_of' ? { owner: BOB } : label === 'transfer_from' ? { from: ALICE, to: BOB, value: '1' } : label === 'approve' ? { spender: BOB, value: '1' } : { to: BOB, value: '1' }, abi: ERC20 });
      expect(compile(m, facts).steps[1]!.contractMessage!.selector).toBe(sel);
    }
  });

  it('gives the same call bytes as the equivalent raw-data manifest', () => {
    const viaAbi = compile(inkCall({ message: 'flip', abi: FLIPPER }), facts).steps[1]!;
    const raw = compile(demoManifest(), facts).steps[1]!; // demo data 0x633aa551 is flipper's flip()
    expect(viaAbi.decodedArgs.data).toBe('0x633aa551');
    expect(viaAbi.encodedCall).toBe(raw.encodedCall);
  });

  it('round-trips through decodeInkMessage', () => {
    const s = compile(inkCall({ message: 'transfer_from', args: { from: ALICE, to: BOB, value: '340282366920938463463374607431768211455' }, abi: ERC20 }), facts).steps[1]!;
    expect(decodeInkMessage(ERC20, s.decodedArgs.data as `0x${string}`, 42)).toEqual({
      message: 'transfer_from',
      selector: '0x0b396f18',
      args: { from: ALICE, to: BOB, value: '340282366920938463463374607431768211455' }
    });
  });

  it('accepts positional args, small integers as numbers, and 0x AccountIds, normalising them', () => {
    const a = compile(transfer(), facts).steps[1]!;
    const b = compile(inkCall({ message: 'transfer', args: [BOB_HEX, 1000], abi: ERC20 }), facts).steps[1]!;
    expect(b.decodedArgs.data).toBe(a.decodedArgs.data);
    expect(b.contractMessage).toEqual(a.contractMessage);
  });

  it('abiRef resolves from options.abis; the plan records the ABI hash and the ref', () => {
    const p = compile(inkCall({ message: 'transfer', args: { to: BOB, value: '1000' }, abiRef: 'erc20' }), facts, { abis: { erc20: ERC20 } });
    const inline = compile(transfer(), facts).steps[1]!;
    expect(p.steps[1]!.decodedArgs.data).toBe(inline.decodedArgs.data);
    expect(p.steps[1]!.contractMessage).toEqual({ ...inline.contractMessage, abiRef: 'erc20' });
  });

  it('an optional abiHash pin must match', () => {
    expect(compile(transfer({ abiHash: computeAbiHash(ERC20) }), facts).steps[1]!.status).toBe('ok');
    expectIssue(() => compile(transfer({ abiHash: `0x${'00'.repeat(32)}` }), facts), 'ABI_HASH_MISMATCH', 'actions[1].args.abiHash');
  });

  it('works with older ink! metadata (V3, ink! 3.0)', () => {
    const s = compile(inkCall({ message: 'get', abi: FLIPPER }), facts).steps[1]!;
    expect(s.contractMessage).toMatchObject({ message: 'get', selector: '0x2f865bd9', args: {} });
  });
});

describe('contracts.call ABI form: errors', () => {
  it('needs exactly one of data or message', () => {
    expectIssue(() => compile(inkCall({}), facts), 'MANIFEST_INVALID', 'actions[1].args.data');
    expectIssue(() => compile(transfer({ data: '0x00' }), facts), 'MANIFEST_INVALID', 'actions[1].args.message');
  });
  it('ABI-only fields are rejected next to raw data', () => {
    expectIssue(() => compile(inkCall({ data: '0x00', abi: ERC20 }), facts), 'MANIFEST_INVALID', 'actions[1].args.abi');
    expectIssue(() => compile(inkCall({ data: '0x00', args: {} }), facts), 'MANIFEST_INVALID', 'actions[1].args.args');
  });
  it('needs exactly one of abi or abiRef, and the ref must exist', () => {
    expectIssue(() => compile(inkCall({ message: 'flip' }), facts), 'ABI_INVALID', 'actions[1].args.abi');
    expectIssue(() => compile(inkCall({ message: 'flip', abi: FLIPPER, abiRef: 'f' }), facts), 'ABI_INVALID', 'actions[1].args.abiRef');
    expectIssue(() => compile(inkCall({ message: 'flip', abiRef: 'nope' }), facts, { abis: {} }), 'ABI_INVALID', 'actions[1].args.abiRef');
  });
  it('rejects something that is not an ink! ABI', () => {
    expectIssue(() => compile(inkCall({ message: 'flip', abi: { hello: 'world' } }), facts), 'ABI_INVALID', 'actions[1].args.abi');
  });
  it('unknown message names list what the ABI has; constructors are called out', () => {
    try {
      compile(inkCall({ message: 'transferr', args: {}, abi: ERC20 }), facts);
      throw new Error('should fail');
    } catch (e: any) {
      expect(e.issues[0]).toMatchObject({ code: 'ABI_MESSAGE_UNKNOWN', path: 'actions[1].args.message' });
      expect(e.issues[0].message).toMatch(/no message "transferr".*transfer_from/);
    }
    expectIssue(() => compile(inkCall({ message: 'new', abi: FLIPPER }), facts), 'ABI_MESSAGE_UNKNOWN', 'actions[1].args.message');
  });
  it('wrong argument count, names or types are coded with a path', () => {
    expectIssue(() => compile(inkCall({ message: 'transfer', args: [BOB], abi: ERC20 }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.args');
    expectIssue(() => compile(inkCall({ message: 'transfer', args: { to: BOB }, abi: ERC20 }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.args.value');
    expectIssue(() => compile(inkCall({ message: 'transfer', args: { to: BOB, value: '1', memo: 'x' }, abi: ERC20 }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.args.memo');
    expectIssue(() => compile(transfer({ args: { to: BOB, value: 1.5 } }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.args.value');
    expectIssue(() => compile(transfer({ args: { to: BOB, value: 'lots' } }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.args.value');
    expectIssue(() => compile(transfer({ args: { to: BOB, value: '-1' } }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.args.value');
    expectIssue(() => compile(transfer({ args: { to: BOB, value: (1n << 128n).toString() } }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.args.value');
    expectIssue(() => compile(transfer({ args: { to: true, value: '1' } }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.args.to');
    expectIssue(() => compile(inkCall({ message: 'transfer', args: [true, '1'], abi: ERC20 }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.args[0]');
  });
  it('AccountId arguments must use the chain SS58 prefix', () => {
    expectIssue(() => compile(transfer({ args: { to: ALICE_POLKADOT, value: '1' } }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.args.to');
  });
  it('refuses a non-zero value for a non-payable message', () => {
    expectIssue(() => compile(transfer({ value: '1' }), facts), 'ABI_ARGS_INVALID', 'actions[1].args.value');
  });
});

describe('contracts.call ABI form: determinism and digests', () => {
  it('ABI key order does not change abiHash or the plan', () => {
    expect(computeAbiHash(reverseKeys(ERC20))).toBe(computeAbiHash(ERC20));
    expect(compile(transfer({ abi: reverseKeys(ERC20) }), facts).planDigest).toBe(compile(transfer(), facts).planDigest);
  });
  it('any ABI change (even docs) changes abiHash and planDigest', () => {
    const edited = JSON.parse(JSON.stringify(ERC20));
    edited.spec.docs = ['edited'];
    const a = compile(transfer(), facts);
    const b = compile(transfer({ abi: edited }), facts);
    expect(b.steps[1]!.decodedArgs.data).toBe(a.steps[1]!.decodedArgs.data);
    expect(b.steps[1]!.contractMessage!.abiHash).not.toBe(a.steps[1]!.contractMessage!.abiHash);
    expect(b.planDigest).not.toBe(a.planDigest);
  });
  it('a tampered contractMessage no longer matches planDigest', () => {
    const p = compile(transfer(), facts);
    const t = JSON.parse(JSON.stringify(p));
    t.steps[1].contractMessage.args.value = '1';
    expect(computePlanDigest(t)).not.toBe(p.planDigest);
    expect(computePlanDigest(p)).toBe(p.planDigest);
  });
  it('raw-data steps carry no contractMessage (existing plans unchanged)', () => {
    expect(compile(demoManifest(), facts).steps[1]).not.toHaveProperty('contractMessage');
  });
  it('golden digests for the ABI form (update only on intentional format changes)', () => {
    const p = compile(transfer(), facts);
    expect({ abiHash: p.steps[1]!.contractMessage!.abiHash, planDigest: p.planDigest }).toMatchInlineSnapshot(`
      {
        "abiHash": "0x997b93d1a57e8358230963c2f8fd5bcb5cdc5875664448a651485110989b7b48",
        "planDigest": "0x318ebb4478f5794a2e041cb22fb990b75d6cdd5367579700e8070ed8402bfe19",
      }
    `);
  });
});
