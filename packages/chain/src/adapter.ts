import { encodeAddress } from '@polkadot/util-crypto';
import type { BatchAllRollback, Hex, Plan, RuntimeFacts, RuntimeFingerprint } from '@seam/compiler';
import { discover, readSigningCheckpoint, refetchFingerprint } from './discover.js';
import { SeamChainError } from './errors.js';
import { toChainEvent, type ChainEvent } from './events.js';
import { preflight, type PreflightReport } from './preflight.js';
import { withClient, type ConnectOptions, type Endpoint } from './rpc.js';
import { decodeRuntime } from './runtime.js';
import { dryRunOne, dryRunSigned, type SignedDryRunDetail } from './dryrun.js';
import { assembleSignedExtrinsic, extractSignedCall, signingRequestsForCalls, type AssembleOptions, type SignerPayloadJSON, type SigningRequest } from './signing.js';
import { submitAndWatch, type StatusUpdate, type SubmitResult } from './submit.js';
import type { PreflightResult, SignedDryRun, SigningEnvelope } from './types.js';

/** Mirrors @seam/sdk StepOutcome (seam-sdk/src/receipt.ts @ 6577346). */
export interface StepOutcome {
  actionId: string;
  status: 'finalized' | 'included' | 'submitted' | 'failed' | 'not_run';
  txHash?: Hex;
  block?: { number: number; hash: Hex };
  events: ChainEvent[];
  error?: string;
}

/** Mirrors @seam/sdk ChainAdapter (packages/sdk/src/flow.ts @ 4826fd1). */
export interface ChainAdapter {
  discover(): Promise<RuntimeFacts>;
  readFingerprint(): Promise<RuntimeFingerprint>;
  preflight(plan: Plan): Promise<{ preflight: PreflightResult; envelope: SigningEnvelope }>;
  /**
   * system_dryRun of each signed transaction, in order, for checkBeforeSubmit({ signedDryRun }).
   * In a sequential run, transaction i > 0 is 'unknown' (future nonce) until the earlier ones are on chain;
   * submit() dry-runs each transaction again right before broadcasting it.
   */
  dryRunSigned(signedTxs: Hex[]): Promise<SignedDryRun[]>;
  submit(signedTx: Hex, actionId: string): Promise<StepOutcome>;
}

/** Mirrors @seam/sdk WalletSigner. */
export interface WalletSigner {
  sign(calls: Hex[], envelope: SigningEnvelope): Promise<{ signedTx: Hex; signedCall: Hex }[]>;
}

export interface PortaldotAdapterOptions extends ConnectOptions {
  /** Pinned types file text. Default: the compiler's spec 1002 file. */
  typesBundle?: string;
  batchAllRollback?: BatchAllRollback;
  /** Use these facts instead of the ones discover() returns (e.g. facts from an approved snapshot). */
  facts?: RuntimeFacts;
  /** Envelope mortality, power of two. Default 64 blocks (about 64 minutes at Portaldot's 60 s blocks). */
  mortalityBlocks?: number;
  /** Override the block time used for envelope.expiresAt. Default: from metadata (Babe.ExpectedBlockTime). */
  blockTimeMs?: number;
  /** Clock for envelope.expiresAt. Default () => new Date(). */
  now?: () => Date;
  /** How long submit() waits for finality. Default 5 minutes. */
  submitTimeoutMs?: number;
  /** Dry-run each transaction right before broadcasting it and refuse to send one that fails. Default true. */
  dryRunBeforeSubmit?: boolean;
  /** Must be true to submit to Portaldot mainnet (never needed for the hackathon). */
  allowMainnet?: boolean;
  onStatus?: (actionId: string, u: StatusUpdate) => void;
}

export interface PortaldotAdapter extends ChainAdapter {
  readonly endpoint: Endpoint;
  /** Facts the adapter uses (set by discover() or options.facts). */
  readonly facts: RuntimeFacts | undefined;
  /** Full preflight report of the last preflight() call (fee details, contract dry runs, nonce source). */
  readonly lastPreflight: PreflightReport | undefined;
  /** Details of the last dryRunSigned() / pre-submit dry run. */
  readonly lastDryRun: SignedDryRunDetail[] | undefined;
  /** Signing requests for the calls the SDK hands its wallet (callsToSign(plan)), in order, nonces envelope.nonce + i, era from envelope.checkpoint. */
  signingRequests(calls: Hex[], envelope: SigningEnvelope): SigningRequest[];
  /** Turns a payload signer (e.g. a polkadot.js extension's signPayload) into the SDK's WalletSigner. SEAM never sees keys. */
  walletFrom(signPayload: (payload: SignerPayloadJSON) => Promise<{ signature: string }>, opts?: AssembleOptions): WalletSigner;
  /** Raw submit result of the last submit() (status history, extrinsic index, decoded events with types). */
  readonly lastSubmit: SubmitResult | undefined;
}

/** Block time from metadata constants: Babe.ExpectedBlockTime, else 2 x Timestamp.MinimumPeriod. */
export function blockTimeFromFacts(facts: RuntimeFacts): number | undefined {
  const consts = decodeRuntime(facts).decorated().consts as unknown as Record<string, Record<string, { toNumber(): number } | undefined> | undefined>;
  const expected = consts.babe?.expectedBlockTime?.toNumber();
  if (expected) return expected;
  const min = consts.timestamp?.minimumPeriod?.toNumber();
  // Below a second means manual/instant seal (substrate-contracts-node: MinimumPeriod 5 ms): blocks come per
  // transaction, so metadata says nothing about real block time. Make the caller pass blockTimeMs.
  return min && min * 2 >= 1000 ? min * 2 : undefined;
}

/** Maps a submitAndWatch result to the SDK's StepOutcome. */
export function toStepOutcome(actionId: string, r: SubmitResult): StepOutcome {
  const out: StepOutcome = { actionId, status: 'submitted', txHash: r.txHash, events: (r.inclusion?.events ?? []).map(toChainEvent) };
  if (r.inclusion) out.block = { number: r.inclusion.number, hash: r.inclusion.hash };
  if (r.inclusion?.success === false) {
    out.status = 'failed';
    out.error = r.inclusion.dispatchError ?? 'System.ExtrinsicFailed';
  } else if (['dropped', 'invalid', 'usurped', 'finality_timeout'].includes(r.status)) {
    out.status = 'failed';
    out.error = r.error ?? `the node reported ${r.status}`;
  } else if (r.status === 'finalized' && r.inclusion) {
    out.status = 'finalized';
  } else if (r.inclusion) {
    out.status = 'included';
  }
  if (r.error && !out.error) out.error = r.error;
  return out;
}

/**
 * Bot 5's ChainAdapter for Portaldot. discover/readFingerprint/preflight are read-only; submit broadcasts
 * a transaction the user's wallet already signed. The adapter holds no keys.
 */
export function createPortaldotAdapter(endpoint: Endpoint, options: PortaldotAdapterOptions = {}): PortaldotAdapter {
  let facts = options.facts;
  let lastPreflight: PreflightReport | undefined;
  let lastSubmit: SubmitResult | undefined;
  let lastDryRun: SignedDryRunDetail[] | undefined;
  const needFacts = (): RuntimeFacts => {
    if (!facts) throw new SeamChainError('FACTS_MISMATCH', 'call discover() first (or pass options.facts)');
    return facts;
  };
  const discoverOpts = { ...options };
  delete discoverOpts.facts;

  const adapter: PortaldotAdapter = {
    endpoint,
    get facts() { return facts; },
    get lastPreflight() { return lastPreflight; },
    get lastSubmit() { return lastSubmit; },
    get lastDryRun() { return lastDryRun; },

    async discover() {
      const found = await discover(endpoint, discoverOpts);
      if (!facts) facts = found;
      else if (found.fingerprintDigest !== facts.fingerprintDigest) {
        throw new SeamChainError('RUNTIME_CHANGED', 'the node no longer matches the pinned facts given in options.facts');
      }
      return facts;
    },

    readFingerprint() {
      return refetchFingerprint(endpoint, discoverOpts);
    },

    async preflight(plan: Plan) {
      const f = needFacts();
      const report = await preflight(endpoint, plan, f, options);
      const checkpoint = await readSigningCheckpoint(endpoint, options);
      const mortalityBlocks = options.mortalityBlocks ?? 64;
      const blockTimeMs = options.blockTimeMs ?? blockTimeFromFacts(f);
      if (!blockTimeMs) throw new SeamChainError('NODE_MISSING_VALUE', 'block time not in metadata; pass options.blockTimeMs');
      // The era counts from the checkpoint, so leave one block of margin before the transaction would die.
      const expiresAt = new Date((options.now ?? (() => new Date()))().getTime() + (mortalityBlocks - 1) * blockTimeMs).toISOString();
      const envelope: SigningEnvelope = {
        signer: encodeAddress(plan.signer.publicKey, f.fingerprint.ss58Prefix),
        nonce: report.nonce,
        mortalityBlocks,
        checkpoint,
        expiresAt
      };
      lastPreflight = report;
      return { preflight: report.result, envelope };
    },

    async submit(signedTx: Hex, actionId: string) {
      const f = needFacts();
      if (options.dryRunBeforeSubmit !== false) {
        const d = await withClient(endpoint, (c) => dryRunOne(c, f, signedTx, 0), options);
        lastDryRun = [d];
        if (d.outcome === 'failed') {
          lastSubmit = undefined;
          return { actionId, status: 'failed', txHash: d.txHash, events: [], error: `not sent: the dry run right before submitting failed (${d.detail})` };
        }
      }
      const opts: Parameters<typeof submitAndWatch>[3] = { ...options, facts: f };
      if (options.submitTimeoutMs !== undefined) opts.timeoutMs = options.submitTimeoutMs;
      const r = await submitAndWatch(endpoint, signedTx, options.onStatus ? (u) => options.onStatus!(actionId, u) : undefined, opts);
      lastSubmit = r;
      return toStepOutcome(actionId, r);
    },

    async dryRunSigned(signedTxs) {
      const r = await dryRunSigned(endpoint, signedTxs, needFacts(), options);
      lastDryRun = r.details;
      return r.results;
    },

    signingRequests(calls, envelope) {
      return signingRequestsForCalls(calls, needFacts(), envelope);
    },

    walletFrom(signPayload, assembleOpts = {}) {
      return {
        async sign(calls, envelope) {
          const f = needFacts();
          const out: { signedTx: Hex; signedCall: Hex }[] = [];
          for (const req of adapter.signingRequests(calls, envelope)) {
            const { signature } = await signPayload(req.payload);
            const signedTx = assembleSignedExtrinsic(req.payload, signature, f, assembleOpts);
            out.push({ signedTx, signedCall: extractSignedCall(signedTx, f).callHex });
          }
          return out;
        }
      };
    }
  };
  return adapter;
}
