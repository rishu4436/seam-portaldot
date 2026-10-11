/**
 * Live, READ-ONLY checks against Portaldot mainnet. Run with: SEAM_LIVE=1 npm test  (or npm run test:live)
 * Nothing is ever submitted: only state reads, fee queries on a fake-signed (unsubmittable) extrinsic and
 * a contract dry run.
 */
import { describe, expect, it } from 'vitest';
import { computeFingerprintDigest } from '@seam/compiler';
import {
  connect, discover, fakeSignedExtrinsic, listRpcMethods, preflight, readCheckpoint, readFingerprint, refetchFingerprint, readEvents
} from '../src/index.js';
import { ALICE, ALICE_HEX, demoPlan, eventsFixture, snapshotFacts } from './helpers.js';

const LIVE = process.env.SEAM_LIVE === '1';
const ENDPOINT = process.env.SEAM_ENDPOINT ?? 'wss://mainnet.portaldot.io';

describe.skipIf(!LIVE)(`live, read-only: ${ENDPOINT}`, () => {
  const snap = snapshotFacts();

  it('discover() matches the snapshot fingerprint (unless the chain upgraded)', async () => {
    const facts = await discover(ENDPOINT);
    console.log(`[live] head #${facts.blockNumber}, spec ${facts.fingerprint.specVersion}, digest ${facts.fingerprintDigest} (snapshot ${snap.fingerprintDigest})`);
    if (facts.fingerprint.specVersion !== snap.fingerprint.specVersion) {
      console.warn('[live] runtime upgraded since the snapshot; digest will differ');
      expect(facts.fingerprintDigest).not.toBe(snap.fingerprintDigest);
      return;
    }
    expect(facts.fingerprint).toEqual(snap.fingerprint);
    expect(facts.fingerprintDigest).toBe(snap.fingerprintDigest);
    expect(facts.capabilities['Assets.transfer_keep_alive']).toMatchObject({ status: 'observed', palletIndex: 26, callIndex: 6 });
  }, 60_000);

  it('refetchFingerprint() digest equals the snapshot digest', async () => {
    const fp = await refetchFingerprint(ENDPOINT);
    expect(computeFingerprintDigest(fp)).toBe(snap.fingerprintDigest);
  }, 60_000);

  it('node lists the RPCs SEAM needs, gives Alice\'s next nonce and a fee for a fake-signed transfer', async () => {
    const client = await connect(ENDPOINT);
    try {
      const methods = await listRpcMethods(client);
      for (const m of ['author_submitAndWatchExtrinsic', 'chain_subscribeFinalizedHeads', 'payment_queryInfo', 'payment_queryFeeDetails',
        'system_dryRun', 'system_accountNextIndex', 'state_call', 'contracts_call']) expect(methods).toContain(m);

      const nonce = await client.send<number>('system_accountNextIndex', [ALICE]);
      console.log(`[live] system_accountNextIndex(Alice) = ${nonce}`);
      expect(Number.isSafeInteger(nonce)).toBe(true);

      const fp = await readFingerprint(client);
      const plan = demoPlan(snap);
      const tx = fakeSignedExtrinsic(plan.steps[0]!.encodedCall!, snap, ALICE_HEX, nonce, fp.atBlock);
      const info = await client.send<{ weight: number; class: string; partialFee: string }>('payment_queryInfo', [tx, fp.atBlock.hash]);
      console.log(`[live] payment_queryInfo(fake-signed Assets.transfer_keep_alive) = ${JSON.stringify(info)}`);
      expect(BigInt(info.partialFee)).toBeGreaterThan(0n);
      expect(info.weight).toBeGreaterThan(0);

      const report = await preflight(client, plan, snap);
      console.log(`[live] preflight: ${JSON.stringify(report.result)}`);
      expect(report.result.steps).toHaveLength(3);
      expect(report.result.totalFee.value).toBeDefined();

      const cp = await readCheckpoint(client);
      expect(cp.number).toBeGreaterThanOrEqual(fp.atBlock.number - 10);

      // decode real events of a real past transfer with the pinned runtime
      const hash = await client.send<string>('chain_getBlockHash', [eventsFixture.block]);
      const evs = await readEvents(client, hash as `0x${string}`, 1, snap);
      expect(evs.success).toBe(true);
      expect(evs.events.map((e) => `${e.pallet}.${e.name}`)).toContain('Balances.Transfer');
    } finally {
      await client.disconnect();
    }
  }, 120_000);
});
