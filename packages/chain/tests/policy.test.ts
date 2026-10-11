import { describe, expect, it, beforeAll } from 'vitest';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { InMemoryApprovalStore, checkBeforeSubmit, createApproval, definePolicy, evaluatePolicy } from '@seam/policy';
import { assembleSignedExtrinsic, buildSigningRequests, fingerprintFromChainInputs, preflight, signedCallsOf, type Hex } from '../src/index.js';
import { FakeNode } from './fakeNode.js';
import { ALICE, BOB, CHARLIE, CHECKPOINT, demoManifest, demoPlan, devKeys, snapshotFacts, snapshotInputs } from './helpers.js';

const facts = snapshotFacts();
const policy = definePolicy({
  allowedAssets: ['1', '2'],
  allowedContracts: [CHARLIE],
  allowedRecipients: [BOB],
  maxAmountPerAsset: { '1': '5000000000000000', '2': '1' },
  maxNativeValue: '0',
  maxGasLimit: '10000000000',
  maxWeight: '1000000000',
  maxFee: '10000000000',
  allowUnknown: { storageDeposit: true, dryRun: true }
});

describe('plugs into Bot 3\'s policy package as-is', () => {
  it('preflight -> evaluatePolicy -> createApproval -> sign -> checkBeforeSubmit passes with @seam/chain outputs', async () => {
    const keys = await devKeys();
    const plan = demoPlan();
    const node = new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: ['1', '2'] });
    const pf = await preflight(node, plan, facts);
    const policyResult = evaluatePolicy({ policy, plan: plan as never, facts: facts as never, preflight: pf.result, manifest: demoManifest() as never });
    expect(policyResult.allowed).toBe(true);
    const now = new Date('2026-10-11T12:00:00Z');
    const envelope = { signer: ALICE, nonce: pf.nonce, mortalityBlocks: 64, expiresAt: '2026-10-11T12:30:00Z' };
    const base = { manifestDigest: plan.manifestDigest, plan: plan as never, envelope, preflight: pf.result, policy, policyResult };
    const approval = createApproval({ ...base, fingerprint: facts.fingerprint, now });
    if (!approval.ok) throw new Error(approval.reason);

    const reqs = buildSigningRequests(plan, facts, envelope, CHECKPOINT);
    const signed = reqs.map((q) => assembleSignedExtrinsic(q.payload, u8aToHex(keys.alice.sign(hexToU8a(q.signBytesHex), { withType: true })), facts));
    const store = new InMemoryApprovalStore();
    const gate = (signedCalls: Hex[], current = fingerprintFromChainInputs(snapshotInputs()).fingerprint) =>
      checkBeforeSubmit({ ...base, approval: approval.approval, preparedFingerprint: facts.fingerprint, currentFingerprint: current, signedCalls, now, store });

    expect(gate(signedCallsOf(signed, facts))).toEqual({ ok: true, reasons: [] });

    // a wallet that signed something else is caught from the extracted bytes
    const other = buildSigningRequests(demoPlan(), facts, { ...envelope, nonce: 9 }, CHECKPOINT);
    const swapped = [signed[0]!, assembleSignedExtrinsic(other[2]!.payload, u8aToHex(keys.alice.sign(hexToU8a(other[2]!.signBytesHex), { withType: true })), facts), signed[2]!];
    expect(gate(signedCallsOf(swapped, facts)).reasons.map((r) => r.code)).toEqual(['signed_bytes_mismatch']);

    // a runtime change seen by the re-read is caught
    const inputs = snapshotInputs();
    const upgraded = fingerprintFromChainInputs({ ...inputs, properties: { ...inputs.properties, tokenDecimals: 12 } }).fingerprint;
    expect(gate(signedCallsOf(signed, facts), upgraded).reasons.map((r) => r.code)).toEqual(['runtime_changed']);
  });
});
