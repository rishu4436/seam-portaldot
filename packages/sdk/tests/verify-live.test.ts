import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { compile, type Hex, type Plan } from '@seam/compiler';
import {
  buildReceipt, defineManifest, action, factsFromSnapshot, receiptDigest, receiptIntegrity, verifyReceiptLive,
  type ChainEvent, type Receipt, type ReceiptChainReader, type StepOutcome,
} from '../src/index.js';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ALICE_HEX = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d' as Hex;
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const BOB_HEX = '0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48';
const facts = factsFromSnapshot(fileURLToPath(new URL('./fixtures', import.meta.url)));
const ev = (pallet: string, name: string, ...args: string[]): ChainEvent => ({ pallet, name, args });
const SUCCESS = ev('System', 'ExtrinsicSuccess', '{}');
const H = (n: number) => (`0x${n.toString(16).padStart(64, '0')}`) as Hex;

const plan: Plan = compile(defineManifest({
  signer: { type: 'ss58', value: ALICE, ss58Prefix: 42 },
  actions: [action.transfer('pay', { assetId: '1', amount: '2500', recipient: BOB })],
}), facts);
const transferred = ev('Assets', 'Transferred', '1', ALICE_HEX, BOB_HEX, '2500');
const outcomes: StepOutcome[] = [{ actionId: 'pay', status: 'finalized', txHash: H(0xaa), block: { number: 5, hash: H(5) }, events: [transferred, SUCCESS] }];
const real = buildReceipt({ plan, outcomes });

/** A chain that really holds the transaction. */
const honestChain = (over: Partial<ReceiptChainReader> = {}): ReceiptChainReader => ({
  finalizedNumber: async () => 10,
  canonicalHash: async (n) => (n === 5 ? H(5) : null),
  readTx: async (block, tx) => (block === H(5) && tx === H(0xaa)
    ? { extrinsicIndex: 1, signer: ALICE_HEX, callHex: plan.steps[0]!.encodedCall!, events: [transferred, SUCCESS] } : null),
  ...over,
});
/** Attacker: edits the receipt and recomputes the unkeyed digest, so offline checking cannot tell. */
const forge = (edit: (r: Receipt) => void): Receipt => {
  const r = JSON.parse(JSON.stringify(real)) as Receipt;
  edit(r);
  r.receiptDigest = receiptDigest(r);
  return r;
};

describe('SEAM-003 offline integrity vs live chain verification', () => {
  it('a genuine receipt is integrity_checked offline, never chain_verified', () => {
    const i = receiptIntegrity(real);
    expect(i.status).toBe('integrity_checked');
    expect(i.note).toMatch(/integrity only, not on-chain proof/);
  });
  it('a receipt edited without recomputing the digest is failed offline', () => {
    const r = JSON.parse(JSON.stringify(real)) as Receipt;
    r.result = 'verified'; r.steps[0]!.txHash = H(1);
    expect(receiptIntegrity(r).status).toBe('failed');
  });
  it('the real receipt is chain_verified against a chain that holds the tx', async () => {
    const v = await verifyReceiptLive(real, honestChain(), { plan });
    expect(v.status).toBe('chain_verified');
    expect(v.problems).toEqual([]);
  });
  it('fabricated self-consistent receipt (fake tx): offline says integrity only, live rejects', async () => {
    const fake = forge((r) => { r.steps[0]!.txHash = H(0xdead); });
    expect(receiptIntegrity(fake).status).toBe('integrity_checked');
    const v = await verifyReceiptLive(fake, honestChain(), { plan });
    expect(v.status).toBe('failed');
    expect(v.problems.join(' ')).toMatch(/not in block/);
  });
  it('rejects a wrong block hash and a non-canonical block', async () => {
    const wrongHash = forge((r) => { r.steps[0]!.block = { number: 5, hash: H(99) }; });
    expect((await verifyReceiptLive(wrongHash, honestChain(), { plan })).status).toBe('failed');
    const fork = honestChain({ canonicalHash: async () => H(77) });
    const v = await verifyReceiptLive(real, fork, { plan });
    expect(v.status).toBe('failed');
    expect(v.problems.join(' ')).toMatch(/canonical/);
  });
  it('a block above the finalized head is unknown, not verified', async () => {
    const v = await verifyReceiptLive(real, honestChain({ finalizedNumber: async () => 3 }), { plan });
    expect(v.status).toBe('unknown');
  });
  it('rejects wrong signer and wrong call', async () => {
    const wrongSigner = await verifyReceiptLive(real, honestChain({ readTx: async () => ({ extrinsicIndex: 1, signer: BOB_HEX as Hex, callHex: plan.steps[0]!.encodedCall!, events: [transferred, SUCCESS] }) }), { plan });
    expect(wrongSigner.status).toBe('failed');
    const wrongCall = await verifyReceiptLive(real, honestChain({ readTx: async () => ({ extrinsicIndex: 1, signer: ALICE_HEX, callHex: '0x0000' as Hex, events: [transferred, SUCCESS] }) }), { plan });
    expect(wrongCall.status).toBe('failed');
  });
  it('rejects forged events: receipt claims a transfer the chain does not show', async () => {
    const chain = honestChain({ readTx: async () => ({ extrinsicIndex: 1, signer: ALICE_HEX, callHex: plan.steps[0]!.encodedCall!, events: [ev('Assets', 'Transferred', '1', ALICE_HEX, BOB_HEX, '1'), SUCCESS] }) });
    const v = await verifyReceiptLive(real, chain, { plan });
    expect(v.status).toBe('failed');
    expect(v.problems.join(' ')).toMatch(/events/);
  });
  it('a reader that throws gives unknown, never verified', async () => {
    const v = await verifyReceiptLive(real, honestChain({ finalizedNumber: async () => { throw new Error('rpc down'); } }), { plan });
    expect(v.status).toBe('unknown');
  });
  it('without a plan the signer/call cannot be checked, which is stated, and the result stays unknown (fail closed)', async () => {
    const v = await verifyReceiptLive(real, honestChain());
    expect(v.status).toBe('unknown');
    expect(v.notes.join(' ')).toMatch(/no plan/i);
  });
});
