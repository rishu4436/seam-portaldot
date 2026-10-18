import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { compile, type Hex, type Plan } from '@seam/compiler';
import { buildReceipt, defineManifest, action, factsFromSnapshot, type ChainEvent, type StepOutcome } from '../src/index.js';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const BOB_HEX = '0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48';
const OTHER_HEX = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
const facts = factsFromSnapshot(fileURLToPath(new URL('./fixtures', import.meta.url)));
const ev = (pallet: string, name: string, ...args: string[]): ChainEvent => ({ pallet, name, args });
const SUCCESS = ev('System', 'ExtrinsicSuccess', '{}');
const blk = { number: 2, hash: ('0x' + '02'.repeat(32)) as Hex };

const plan: Plan = compile(defineManifest({
  signer: { type: 'ss58', value: ALICE, ss58Prefix: 42 },
  actions: [action.contractCall('call', { contract: BOB, value: '0', gasLimit: '5000000000', data: '0x633aa551' })],
}), facts);
const out = (events: ChainEvent[], status: StepOutcome['status'] = 'finalized'): StepOutcome[] =>
  [{ actionId: 'call', status, txHash: '0xbb', block: blk, events }];
const step = (events: ChainEvent[], effects?: Parameters<typeof buildReceipt>[0]['effects'], status: StepOutcome['status'] = 'finalized') =>
  buildReceipt({ plan, outcomes: out(events, status), effects }).steps[0]!;

describe('SEAM-004 verifier coverage: contracts.call', () => {
  it('a generic ContractEmitted from the addressed contract is NOT verified', () => {
    const s = step([ev('Contracts', 'ContractEmitted', BOB_HEX, '0x01'), SUCCESS]);
    expect(s.verification).toBe('unknown');
    expect(s.coverage).toBe('contract_emitted');
  });
  it('an event from a different contract is not even contract_emitted coverage', () => {
    const s = step([ev('Contracts', 'ContractEmitted', OTHER_HEX, '0x01'), SUCCESS]);
    expect(s.verification).toBe('unknown');
    expect(s.coverage).toBe('extrinsic_finalized');
  });
  it('only the exact expected event data proves the effect', () => {
    const e = { call: { emittedData: '0x0102' as Hex } };
    const good = step([ev('Contracts', 'ContractEmitted', BOB_HEX, '0x0102'), SUCCESS], e);
    expect(good.verification).toBe('verified');
    expect(good.coverage).toBe('effect_proven');
    const bad = step([ev('Contracts', 'ContractEmitted', BOB_HEX, '0x0103'), SUCCESS], e);
    expect(bad.verification).toBe('not_verified');
    const missing = step([SUCCESS], e);
    expect(missing.verification).toBe('unknown');
  });
  it('state readback decides: match verifies, mismatch is not_verified, unreadable is unknown', () => {
    const emitted = [ev('Contracts', 'ContractEmitted', BOB_HEX, '0x01'), SUCCESS];
    expect(step(emitted, { call: { stateReadback: { expected: '7', actual: '7' } } }).verification).toBe('verified');
    expect(step(emitted, { call: { stateReadback: { expected: '7', actual: '8' } } }).verification).toBe('not_verified');
    expect(step(emitted, { call: { stateReadback: { expected: '7' } } }).verification).toBe('unknown');
  });
  it('a wrong readback overrides a matching event', () => {
    const s = step([ev('Contracts', 'ContractEmitted', BOB_HEX, '0x0102'), SUCCESS],
      { call: { emittedData: '0x0102', stateReadback: { expected: '7', actual: '8' } } });
    expect(s.verification).toBe('not_verified');
  });
  it('a matching effect in a block that is not finalized is not verified', () => {
    const s = step([ev('Contracts', 'ContractEmitted', BOB_HEX, '0x0102'), SUCCESS], { call: { emittedData: '0x0102' } }, 'included');
    expect(s.verification).toBe('unknown');
    expect(s.coverage).toBe('call_dispatched');
  });
});

describe('SEAM-010 partial: Revive and Nfts are not guessed', () => {
  it('report unsupported_runtime and never verified', () => {
    for (const kind of ['revive.call', 'nfts.mint'] as const) {
      const fake = { ...plan, steps: [{ ...plan.steps[0]!, kind }] } as Plan;
      const r = buildReceipt({ plan: fake, outcomes: out([SUCCESS]) });
      expect(r.steps[0]!.verification).toBe('unknown');
      expect(r.steps[0]!.code).toBe('unsupported_runtime');
      expect(r.result).toBe('not_verified');
    }
  });
});

describe('uncertain status', () => {
  it('is representable and never verified', () => {
    const r = buildReceipt({ plan, outcomes: [{ actionId: 'call', status: 'uncertain', txHash: '0xbb', events: [] }] });
    expect(r.steps[0]!.status).toBe('uncertain');
    expect(r.steps[0]!.verification).toBe('unknown');
    expect(r.result).toBe('not_verified');
  });
});
