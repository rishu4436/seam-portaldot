import { describe, expect, it } from 'vitest';
import { u8aConcat, u8aToHex } from '@polkadot/util';
import { decodeBlockEvents, decodeRuntime, extrinsicHash, outcomeForExtrinsic } from '../src/index.js';
import { eventsFixture, snapshotFacts } from './helpers.js';

const facts = snapshotFacts();
const SENDER = '0x32db51fc607333c64b3bf3ab799919cace04802efa4d3ba9a61d03b8c7a0286f';
const RECIPIENT = '0xe66541ee49b00334f5a93754022087dba7471b3de850129f8a592cf5e4201240';

describe('event decoding with the pinned spec 1002 runtime', () => {
  it('decodes the real System.Events of mainnet block 2,721,116 byte for byte', () => {
    const all = decodeBlockEvents(eventsFixture.systemEvents, facts);
    expect(all.map((e) => `${e.extrinsicIndex}:${e.pallet}.${e.name}`)).toEqual([
      '0:System.ExtrinsicSuccess', '1:System.NewAccount', '1:Balances.Endowed', '1:Balances.Transfer', '1:Treasury.Deposit', '1:System.ExtrinsicSuccess'
    ]);
  });

  it('returns one extrinsic\'s events as { pallet, name, args } with hex accounts and decimal numbers', () => {
    const out = outcomeForExtrinsic(eventsFixture.systemEvents, 1, facts);
    expect(out.success).toBe(true);
    expect(out.dispatchError).toBeUndefined();
    const transfer = out.events.find((e) => e.name === 'Transfer')!;
    expect(transfer).toMatchObject({ pallet: 'Balances', name: 'Transfer', args: [SENDER, RECIPIENT, '157169178082191'], argTypes: ['AccountId', 'AccountId', 'Balance'] });
    expect(out.events.at(-1)!.args).toEqual(['{"class":"Normal","paysFee":"Yes","weight":179881000}']);
    // the extrinsic in the fixture really is index 1 of that block
    expect(eventsFixture.extrinsics.map(extrinsicHash)[1]).toBe(extrinsicHash(eventsFixture.extrinsics[1]));
  });

  it('decodes a V13 dispatch error (Module { index: u8, error: u8 }) to a plain name', () => {
    const { registry } = decodeRuntime(facts);
    const failed = u8aConcat(
      new Uint8Array([4]), // one record
      new Uint8Array([0]), registry.createType('u32', 0).toU8a(), new Uint8Array([0, 1]), // ApplyExtrinsic(0), System.ExtrinsicFailed
      registry.createType('DispatchError', { Module: { index: 26, error: 0 } }).toU8a(),
      registry.createType('DispatchInfo', { weight: 1, class: 'Normal', paysFee: 'Yes' }).toU8a(),
      new Uint8Array([0])
    );
    const out = outcomeForExtrinsic(u8aToHex(failed), 0, facts);
    expect(out.success).toBe(false);
    expect(out.dispatchError).toMatch(/^assets\.BalanceLow: Account balance must be greater than or equal to the transfer amount\.$/);
    expect(out.events[0]!.args[0]).toBe('{"module":{"error":0,"index":26}}');
  });

  it('refuses events that do not decode cleanly with the pinned types', () => {
    expect(() => decodeBlockEvents(`${eventsFixture.systemEvents}00`, facts)).toThrow(/did not decode cleanly/);
  });
});
