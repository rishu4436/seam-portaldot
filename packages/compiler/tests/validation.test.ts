import { describe, expect, it } from 'vitest';
import { compile, SeamCompileError, type Manifest } from '../src/index.js';
import { ALICE, ALICE_KUSAMA, ALICE_POLKADOT, BOB, BOB_HEX, GENESIS, H160, demoManifest, expectIssue, realFacts } from './helpers.js';

const facts = realFacts();
const m = demoManifest;
const withArg = (i: number, key: string, value: unknown): Manifest => {
  const x = m();
  (x.actions[i]!.args as any)[key] = value;
  return x;
};

describe('address checks', () => {
  it('rejects an H160 recipient for a native call', () => {
    expectIssue(() => compile(withArg(0, 'recipient', H160), facts), 'ADDRESS_TYPE', 'actions[0].args.recipient');
  });
  it('rejects an H160 signer for native calls (domain mismatch on a 32-byte runtime; ADDRESS_TYPE on a 20-byte one)', () => {
    expectIssue(() => compile({ ...m(), signer: { type: 'h160', value: H160 } }, facts), 'SIGNER_DOMAIN_MISMATCH', 'signer');
    expectIssue(() => compile({ ...m(), signer: { type: 'h160', value: H160 } }, { ...facts, signingAccountBytes: 20 }), 'ADDRESS_TYPE', 'signer');
  });
  it('allows an H160 signer only when every action is revive.call', () => {
    const p = compile(
      { version: 1, signer: { type: 'h160', value: H160 }, actions: [{ id: 'r', kind: 'revive.call', args: { contract: H160, value: '0', data: '0x' } }] },
      { ...facts, signingAccountBytes: 20 }
    );
    expect(p.signer.type).toBe('h160');
    expect(p.mode).toBe('unavailable'); // Revive is not on spec 1002
  });
  it('rejects an SS58 contract for revive.call (needs H160)', () => {
    const x: Manifest = { version: 1, signer: { type: 'ss58', value: ALICE }, actions: [{ id: 'r', kind: 'revive.call', args: { contract: BOB, value: '0', data: '0x' } }] };
    expectIssue(() => compile(x, facts), 'ADDRESS_TYPE', 'actions[0].args.contract');
  });
  it('rejects a recipient using another chain prefix (Polkadot 0, Kusama 2)', () => {
    expectIssue(() => compile(withArg(0, 'recipient', ALICE_POLKADOT), facts), 'SS58_PREFIX', 'actions[0].args.recipient');
    expectIssue(() => compile(withArg(2, 'recipient', ALICE_KUSAMA), facts), 'SS58_PREFIX', 'actions[2].args.recipient');
  });
  it('rejects a signer with the wrong prefix, in the address or declared', () => {
    expectIssue(() => compile({ ...m(), signer: { type: 'ss58', value: ALICE_POLKADOT } }, facts), 'SS58_PREFIX', 'signer.value');
    expectIssue(() => compile({ ...m(), signer: { type: 'ss58', value: ALICE, ss58Prefix: 0 } }, facts), 'SS58_PREFIX', 'signer.ss58Prefix');
  });
  it('rejects a signer whose type does not match its value', () => {
    expectIssue(() => compile({ ...m(), signer: { type: 'accountId32', value: ALICE } }, facts), 'ADDRESS_TYPE', 'signer.value');
    expectIssue(() => compile({ ...m(), signer: { type: 'ss58', value: BOB_HEX } }, facts), 'ADDRESS_TYPE', 'signer.value');
  });
  it('accepts a 0x AccountId32 and shows it in this chain’s SS58 form', () => {
    const p = compile(withArg(0, 'recipient', BOB_HEX), facts);
    expect(p.steps[0]!.decodedArgs.recipient).toBe(BOB);
    expect(p.steps[0]!.encodedCall).toBe(compile(m(), facts).steps[0]!.encodedCall);
  });
  it('rejects garbage and short hex addresses', () => {
    expectIssue(() => compile(withArg(0, 'recipient', 'not-an-address'), facts), 'ADDRESS_INVALID');
    expectIssue(() => compile(withArg(0, 'recipient', '0x1234'), facts), 'ADDRESS_INVALID');
  });
});

describe('chain checks', () => {
  it('rejects a manifest for another genesis', () => {
    const x = { ...m(), chain: { genesisHash: `0x${'00'.repeat(32)}`, specVersion: 1002 } };
    expectIssue(() => compile(x, facts), 'CHAIN_MISMATCH', 'chain.genesisHash');
  });
  it('rejects a manifest for another spec version', () => {
    expectIssue(() => compile({ ...m(), chain: { genesisHash: GENESIS, specVersion: 1003 } }, facts), 'CHAIN_MISMATCH', 'chain.specVersion');
  });
  it('chain is optional', () => {
    const { chain: _c, ...rest } = m();
    expect(compile(rest as Manifest, facts).steps).toHaveLength(3);
  });
});

describe('amounts', () => {
  it.each([
    ['float', 1.5],
    ['integer number', 1000],
    ['decimal string', '1.5'],
    ['leading zero', '0100'],
    ['negative', '-1'],
    ['exponent', '1e18'],
    ['empty', '']
  ])('rejects %s', (_n, v) => {
    expectIssue(() => compile(withArg(0, 'amount', v), facts), 'AMOUNT_INVALID', 'actions[0].args.amount');
  });
  it('rejects floats in contract value and gas limit too', () => {
    expectIssue(() => compile(withArg(1, 'value', 0.1), facts), 'AMOUNT_INVALID', 'actions[1].args.value');
    expectIssue(() => compile(withArg(1, 'gasLimit', 5e9), facts), 'AMOUNT_INVALID', 'actions[1].args.gasLimit');
  });
  it('rejects an amount that does not fit the runtime type (asset balance u64 on spec 1002)', () => {
    expectIssue(() => compile(withArg(0, 'amount', (1n << 64n).toString()), facts), 'AMOUNT_INVALID', 'actions[0].args.amount');
    expect(compile(withArg(0, 'amount', ((1n << 64n) - 1n).toString()), facts).steps[0]!.status).toBe('ok');
  });
  it('accepts large native values (u128)', () => {
    expect(compile(withArg(1, 'value', ((1n << 128n) - 1n).toString()), facts).steps[1]!.status).toBe('ok');
  });
  it('rejects floats anywhere else in the manifest as non-canonical', () => {
    expectIssue(() => compile({ ...m(), note: { x: 0.5 } } as any, facts), 'NOT_CANONICAL');
  });
});

describe('manifest shape', () => {
  it('rejects unknown kinds, duplicate ids, unknown/missing args, and reports them all at once', () => {
    const x: any = m();
    x.actions[0].kind = 'balances.transfer';
    x.actions[1].id = 'receipt';
    x.actions[2].args.amout = '1';
    delete x.actions[2].args.amount;
    try {
      compile(x, facts);
      throw new Error('should fail');
    } catch (e) {
      expect(e).toBeInstanceOf(SeamCompileError);
      const err = e as SeamCompileError;
      expect(err.codes.every((c) => c === 'MANIFEST_INVALID')).toBe(true);
      expect(err.issues.length).toBeGreaterThanOrEqual(2);
    }
  });
  it('rejects version != 1 and empty actions', () => {
    expectIssue(() => compile({ ...m(), version: 2 } as any, facts), 'MANIFEST_INVALID', 'version');
    expectIssue(() => compile({ ...m(), actions: [] }, facts), 'MANIFEST_INVALID', 'actions');
  });
  it('rejects non-hex contract data', () => {
    expectIssue(() => compile(withArg(1, 'data', 'hello'), facts), 'MANIFEST_INVALID', 'actions[1].args.data');
  });
});

describe('facts integrity', () => {
  it('rejects facts whose fingerprint was edited without recomputing the digest', () => {
    const f = { ...facts, fingerprint: { ...facts.fingerprint, specVersion: 2000 } };
    expectIssue(() => compile(m(), f), 'FACTS_INVALID');
  });
  it('rejects facts whose metadata does not match metadataHash', () => {
    const f = { ...facts, source: { ...facts.source, typesBundle: facts.source.typesBundle + ' ' } };
    expectIssue(() => compile(m(), f), 'FACTS_INVALID');
  });
  it('rejects capability indexes that do not point at that call in the metadata', () => {
    const cap = facts.capabilities['Assets.transfer_keep_alive']!;
    const f = { ...facts, capabilities: { ...facts.capabilities, 'Assets.transfer_keep_alive': { ...cap, callIndex: 5 } } };
    expectIssue(() => compile(m(), f), 'FACTS_INVALID');
    const g = { ...facts, capabilities: { ...facts.capabilities, 'Assets.transfer_keep_alive': { ...cap, palletIndex: 6 } } };
    expectIssue(() => compile(m(), g), 'FACTS_INVALID');
  });
});
