import { u8aToHex } from '@polkadot/util';
import { encodeAddress } from '@polkadot/util-crypto';
import type { Hex, Plan, PlanStep, RuntimeFacts } from '@seam/compiler';
import { SeamChainError } from './errors.js';
import { readHead } from './discover.js';
import { rpc, toBigInt, toSafeNumber, withClient, type ConnectOptions, type Endpoint, type RpcClient } from './rpc.js';
import { decodeRuntime, encodeRuntime } from './runtime.js';
import { callsForSigning } from './signing.js';
import type { BlockRef, Estimate, PreflightResult, PreflightStep } from './types.js';

export interface PreflightOptions extends ConnectOptions {
  /** Use this nonce instead of asking the node (system_accountNextIndex). */
  nonce?: number;
  /** Block to estimate at. Default: current best block. */
  at?: Hex;
  /**
   * Real signed extrinsics (same order as the signing requests) to dry-run with system_dryRun. Without them
   * SEAM only has a fake signature, which a dry run rejects, so generic steps get dryRun 'unknown'.
   */
  signedExtrinsics?: Hex[];
}

/** What the node said, per transaction SEAM would send. */
export interface PreflightTxDetail {
  actionIds: string[];
  nonce: number;
  /** payment_queryInfo on the (fake- or really-) signed extrinsic. */
  queryInfo?: { weight: string; class: string; partialFee: string };
  /** payment_queryFeeDetails, when the node returns it. */
  feeDetails?: unknown;
  /** system_dryRun result (only with real signed extrinsics). */
  dryRun?: { outcome: 'ok' | 'failed' | 'unknown'; detail: string };
  error?: string;
}

export interface PreflightReport {
  /** The agreed PreflightResult shape, ready for evaluatePolicy and createApproval. */
  result: PreflightResult;
  /** Next nonce for the signer, from system_accountNextIndex (or options.nonce). */
  nonce: number;
  nonceSource: 'node' | 'caller';
  atBlock: BlockRef;
  transactions: PreflightTxDetail[];
  /** Raw contracts_call responses per contracts.call step. */
  contractDryRuns: Record<string, unknown>;
}

const known = (value: bigint | string): Estimate => ({ value: value.toString() });
const UNKNOWN: Estimate = { unknown: true };

/** Builds a fake-signed extrinsic (signature bytes are filler) for fee/weight estimation. Never submittable. */
export function fakeSignedExtrinsic(callHex: Hex, facts: RuntimeFacts, signerAccountId: Hex, nonce: number, at: BlockRef): Hex {
  const { registry } = encodeRuntime(facts);
  const ext = registry.createType('Extrinsic', { method: callHex }, { version: 4 });
  ext.signFake(encodeAddress(signerAccountId, facts.fingerprint.ss58Prefix), {
    blockHash: at.hash,
    genesisHash: facts.fingerprint.genesisHash,
    nonce,
    runtimeVersion: { specVersion: facts.fingerprint.specVersion, transactionVersion: facts.fingerprint.transactionVersion } as never,
    era: registry.createType('ExtrinsicEra', { current: at.number, period: 64 })
  });
  return ext.toHex() as Hex;
}

async function queryInfo(client: RpcClient, extrinsic: Hex, at: Hex): Promise<PreflightTxDetail['queryInfo']> {
  const info = await rpc<{ weight: unknown; class: unknown; partialFee: unknown }>(client, 'payment_queryInfo', [extrinsic, at]);
  // Weight is a plain u64 on spec 1002; newer nodes return { refTime, proofSize }.
  const w = info.weight as unknown;
  const weight = typeof w === 'object' && w !== null && 'refTime' in w ? toBigInt((w as { refTime: unknown }).refTime) : toBigInt(w);
  return { weight: weight.toString(), class: String(info.class), partialFee: toBigInt(info.partialFee).toString() };
}

function describeDispatchError(facts: RuntimeFacts, json: unknown): string {
  try {
    const { registry } = decodeRuntime(facts);
    const err = registry.createType('DispatchError', json as never) as unknown as { isModule: boolean; asModule: never; type: string };
    if (err.isModule) {
      const m = registry.findMetaError(err.asModule);
      return `${m.section}.${m.name}${m.docs.length ? `: ${m.docs.join(' ').trim()}` : ''}`;
    }
    return err.type;
  } catch {
    return JSON.stringify(json);
  }
}

async function dryRunSigned(client: RpcClient, facts: RuntimeFacts, extrinsic: Hex, at: Hex): Promise<NonNullable<PreflightTxDetail['dryRun']>> {
  let raw: string;
  try {
    raw = await rpc<string>(client, 'system_dryRun', [extrinsic, at]);
  } catch (e) {
    return { outcome: 'unknown', detail: `system_dryRun unavailable: ${(e as Error).message.slice(0, 200)}` };
  }
  const { registry } = decodeRuntime(facts);
  const res = registry.createType('ApplyExtrinsicResult', raw) as unknown as {
    isOk: boolean; asOk: { isOk: boolean; asErr: { toJSON(): unknown } }; asErr: { toString(): string };
  };
  if (!res.isOk) return { outcome: 'failed', detail: `transaction is invalid: ${res.asErr.toString()}` };
  if (!res.asOk.isOk) return { outcome: 'failed', detail: `dispatch failed: ${describeDispatchError(facts, res.asOk.asErr.toJSON())}` };
  return { outcome: 'ok', detail: 'system_dryRun: dispatch ok' };
}

/** ink! dry run with contracts_call (spec 1002 shape: { debugMessage, gasConsumed, result: { Ok | Err } }). */
async function contractDryRun(client: RpcClient, facts: RuntimeFacts, plan: Plan, step: PlanStep, at: Hex): Promise<{ outcome: 'ok' | 'failed' | 'unknown'; note: string; raw?: unknown }> {
  const a = step.decodedArgs;
  const dest = a.contractAccountId ?? a.contract;
  if (!dest || a.data === undefined || a.gasLimit === undefined || a.value === undefined) {
    return { outcome: 'unknown', note: 'contract dry run skipped: the plan step is missing contract, value, gasLimit or data' };
  }
  const ss58 = (v: string) => (v.startsWith('0x') ? encodeAddress(v, facts.fingerprint.ss58Prefix) : v);
  const req = {
    origin: encodeAddress(plan.signer.publicKey, facts.fingerprint.ss58Prefix),
    dest: ss58(dest),
    value: `0x${BigInt(a.value).toString(16)}`,
    gasLimit: `0x${BigInt(a.gasLimit).toString(16)}`,
    inputData: a.data
  };
  let raw: Record<string, unknown>;
  try {
    raw = await rpc<Record<string, unknown>>(client, 'contracts_call', [req, at]);
  } catch (e) {
    return { outcome: 'unknown', note: `contracts_call unavailable: ${(e as Error).message.slice(0, 200)}` };
  }
  const result = raw?.result as Record<string, unknown> | undefined;
  const gas = raw?.gasConsumed !== undefined ? ` (gas consumed ${toBigInt(raw.gasConsumed)})` : '';
  if (result && 'Err' in result) return { outcome: 'failed', note: `contract dry run failed: ${describeDispatchError(facts, result.Err)}${gas}`, raw };
  if (result && 'Ok' in result) {
    const flags = Number((result.Ok as { flags?: unknown })?.flags ?? 0);
    if (flags & 1) return { outcome: 'failed', note: `contract dry run reverted (flags ${flags})${gas}`, raw };
    return { outcome: 'ok', note: `contract dry run ok${gas}; state at this block, before earlier steps run`, raw };
  }
  return { outcome: 'unknown', note: 'contracts_call returned a shape SEAM does not recognise', raw };
}

/** Assets steps: an empty Assets.Asset entry means the asset does not exist, so the step must fail. Anything else stays unknown. */
async function assetExists(client: RpcClient, facts: RuntimeFacts, assetId: string, at: Hex): Promise<boolean | undefined> {
  try {
    const query = (decodeRuntime(facts).decorated().query as any).assets?.asset;
    if (!query) return undefined;
    const key = u8aToHex(query(assetId));
    const value = await rpc<string | null>(client, 'state_getStorage', [key, at]);
    return value !== null && value !== undefined && value !== '0x';
  } catch {
    return undefined;
  }
}

/**
 * Preflight for a compiled plan: next nonce, fee and weight from payment_queryInfo on a fake-signed
 * extrinsic per transaction, contracts_call dry runs for contracts.call steps, an asset-existence check
 * for asset steps, and system_dryRun when real signed extrinsics are given. Anything the node doesn't
 * report is { unknown: true }, never guessed. Read-only.
 */
export async function preflight(endpoint: Endpoint, plan: Plan, facts: RuntimeFacts, opts: PreflightOptions = {}): Promise<PreflightReport> {
  if (plan.fingerprintDigest !== facts.fingerprintDigest) throw new SeamChainError('FACTS_MISMATCH', 'plan was compiled for different runtime facts');
  const txs = callsForSigning(plan);
  if (opts.signedExtrinsics && opts.signedExtrinsics.length !== txs.length) {
    throw new SeamChainError('PLAN_NOT_SIGNABLE', `expected ${txs.length} signed extrinsics, got ${opts.signedExtrinsics.length}`);
  }
  return withClient(endpoint, async (client) => {
    const atBlock: BlockRef = opts.at
      ? { hash: opts.at, number: toSafeNumber((await rpc<{ number: unknown }>(client, 'chain_getHeader', [opts.at])).number) }
      : await readHead(client);
    const version = await rpc<{ specVersion: number; transactionVersion: number }>(client, 'state_getRuntimeVersion', [atBlock.hash]);
    if (version.specVersion !== facts.fingerprint.specVersion || version.transactionVersion !== facts.fingerprint.transactionVersion) {
      throw new SeamChainError('RUNTIME_CHANGED', `node runs spec ${version.specVersion}/tx ${version.transactionVersion}, facts are for spec ${facts.fingerprint.specVersion}/tx ${facts.fingerprint.transactionVersion}; rediscover`);
    }
    const signerSs58 = encodeAddress(plan.signer.publicKey, facts.fingerprint.ss58Prefix);
    let nonce: number;
    let nonceSource: PreflightReport['nonceSource'];
    if (opts.nonce !== undefined) {
      nonce = opts.nonce;
      nonceSource = 'caller';
    } else {
      nonce = toSafeNumber(await rpc(client, 'system_accountNextIndex', [signerSs58]));
      nonceSource = 'node';
    }

    const transactions: PreflightTxDetail[] = [];
    for (const [i, tx] of txs.entries()) {
      const detail: PreflightTxDetail = { actionIds: tx.actionIds, nonce: nonce + i };
      const ext = opts.signedExtrinsics?.[i] ?? fakeSignedExtrinsic(tx.callHex, facts, plan.signer.publicKey, nonce + i, atBlock);
      try {
        detail.queryInfo = await queryInfo(client, ext, atBlock.hash);
      } catch (e) {
        detail.error = (e as Error).message;
      }
      try {
        detail.feeDetails = await rpc(client, 'payment_queryFeeDetails', [ext, atBlock.hash]);
      } catch {
        /* optional */
      }
      if (opts.signedExtrinsics?.[i]) detail.dryRun = await dryRunSigned(client, facts, ext, atBlock.hash);
      transactions.push(detail);
    }

    const atomic = plan.mode === 'atomic_verified' || plan.mode === 'atomic_unverified';
    // Atomic: the batch is charged once (totalFee), but the policy limits weight per step, so each inner
    // call is also estimated on its own.
    const standalone = new Map<string, PreflightTxDetail['queryInfo'] | undefined>();
    if (atomic) {
      for (const s of plan.steps) {
        try {
          standalone.set(s.actionId, await queryInfo(client, fakeSignedExtrinsic(s.encodedCall!, facts, plan.signer.publicKey, nonce, atBlock), atBlock.hash));
        } catch {
          standalone.set(s.actionId, undefined);
        }
      }
    }

    const contractDryRuns: Record<string, unknown> = {};
    const steps: PreflightStep[] = [];
    for (const [i, s] of plan.steps.entries()) {
      const tx = atomic ? transactions[0]! : transactions[i]!;
      const info = atomic ? standalone.get(s.actionId) : tx.queryInfo;
      const notes: string[] = [];
      let dryRun: PreflightStep['dryRun'] = 'unknown';
      if (s.kind === 'contracts.call') {
        const c = await contractDryRun(client, facts, plan, s, atBlock.hash);
        dryRun = c.outcome;
        notes.push(c.note);
        if (c.raw !== undefined) contractDryRuns[s.actionId] = c.raw;
      } else if ((s.kind === 'assets.transfer' || s.kind === 'assets.mint') && s.decodedArgs.assetId !== undefined) {
        const exists = await assetExists(client, facts, s.decodedArgs.assetId, atBlock.hash);
        if (exists === false) {
          dryRun = 'failed';
          notes.push(`asset ${s.decodedArgs.assetId} does not exist on chain (Assets.Asset is empty)`);
        }
      }
      if (tx.dryRun && dryRun !== 'failed') {
        if (tx.dryRun.outcome === 'failed') dryRun = 'failed';
        else if (tx.dryRun.outcome === 'ok' && !atomic && s.kind !== 'contracts.call') dryRun = 'ok';
        notes.push(tx.dryRun.detail);
      } else if (!tx.dryRun && dryRun === 'unknown') {
        notes.push('no dry run: needs the real signed transaction (system_dryRun rejects a fake signature)');
      }
      if (atomic) notes.push('atomic: weight and fee here are for this call on its own; the batch is charged once (totalFee)');
      if (!info) notes.push(`payment_queryInfo gave no answer${tx.error ? ` (${tx.error.slice(0, 120)})` : ''}`);
      notes.push('storage deposit: not reported by this runtime');
      steps.push({
        actionId: s.actionId,
        weight: info ? known(info.weight) : UNKNOWN,
        fee: info ? known(info.partialFee) : UNKNOWN,
        storageDeposit: UNKNOWN,
        dryRun,
        note: notes.join('; ')
      });
    }

    const fees = transactions.map((t) => t.queryInfo?.partialFee);
    const totalFee: Estimate = fees.every((f) => f !== undefined) ? known(fees.reduce((a, f) => a + BigInt(f!), 0n)) : UNKNOWN;
    return { result: { steps, totalFee }, nonce, nonceSource, atBlock, transactions, contractDryRuns };
  }, opts);
}
