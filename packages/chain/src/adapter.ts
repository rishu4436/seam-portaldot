import { encodeAddress } from "@polkadot/util-crypto";
import type {
  AtomicRollbackProof,
  BatchAllRollback,
  Hex,
  Plan,
  RuntimeFacts,
  RuntimeFingerprint,
} from "@seam/compiler";
import { discover, readSigningCheckpoint, refetchFingerprint } from "./discover.js";
import { SeamChainError } from "./errors.js";
import { toChainEvent, type ChainEvent } from "./events.js";
import { preflight, type PreflightReport } from "./preflight.js";
import { withClient, type ConnectOptions, type Endpoint } from "./rpc.js";
import { decodeRuntime } from "./runtime.js";
import { dryRunOne, dryRunSigned, type SignedDryRunDetail } from "./dryrun.js";
import {
  assembleSignedExtrinsic,
  extractSignedCall,
  signingRequestsForCalls,
  verifySignedAgainstRequest,
  verifySignedBatch,
  signedExtrinsicDecoder,
  type DecodedSignedExtrinsic,
  type AssembleOptions,
  type SignerPayloadJSON,
  type SigningRequest,
} from "./signing.js";
import { checkSigningWindow } from "./window.js";
import { lookupExtrinsic, type TxLookup } from "./lookup.js";
import { submitAndWatch, type StatusUpdate, type SubmitResult } from "./submit.js";
import type { PreflightResult, SignedDryRun, SigningEnvelope } from "./types.js";

/** Mirrors @seam/sdk StepOutcome (seam-sdk/src/receipt.ts @ 6577346). */
/** not_sent: refused before broadcast; rejected: the node refused it (not in the pool); accepted: the node took it; uncertain: ambiguous. */
export type SubmitDelivery = "not_sent" | "rejected" | "accepted" | "uncertain";

export interface StepOutcome {
  actionId: string;
  delivery?: SubmitDelivery;
  status: "finalized" | "included" | "submitted" | "failed" | "not_run";
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
  /** SEAM-005: locate a transaction after an uncertain send (read-only; never reports absence it cannot prove). */
  lookupTx(txHash: Hex): Promise<TxLookup>;
  /**
   * SEAM-001: decodes every signed transaction and checks it against the signing requests for `calls` (one per call,
   * in order, same envelope). `signedCalls` are decoded from the transactions, never taken from the wallet.
   * Fewer, extra, reordered or altered transactions give ok false. Read-only; sends nothing.
   */
  verifySigned(
    signedTxs: Hex[],
    calls: Hex[],
    envelope: SigningEnvelope,
  ): { ok: boolean; signedCalls: Hex[]; reasons: string[] };
  /** The trusted decoder for checkBeforeSubmit({ signedExtrinsics, decodeSignedExtrinsic }), bound to the approved requests for `calls`. */
  signedDecoder(
    calls: Hex[],
    envelope: SigningEnvelope,
  ): (extrinsic: Hex) => DecodedSignedExtrinsic | null;
}

/** Mirrors @seam/sdk WalletSigner. */
export interface WalletSigner {
  sign(calls: Hex[], envelope: SigningEnvelope): Promise<{ signedTx: Hex; signedCall: Hex }[]>;
}

export interface PortaldotAdapterOptions extends ConnectOptions {
  /** Pinned types file text. Default: the compiler's spec 1002 file. */
  typesBundle?: string;
  batchAllRollback?: BatchAllRollback;
  /** Rollback test evidence for 'verified' (see DiscoverOptions.batchAllRollbackProof). */
  batchAllRollbackProof?: AtomicRollbackProof;
  /** Metadata to compare re-reads against by layout (see DiscoverOptions.pinnedMetadataHex). Default: facts.source.metadataHex. */
  pinnedMetadataHex?: Hex;
  /** Token symbol/decimals for a node whose system_properties omit them (see DiscoverOptions.declaredToken). */
  declaredToken?: { tokenSymbol: string; tokenDecimals: number };
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
  walletFrom(
    signPayload: (payload: SignerPayloadJSON) => Promise<{ signature: string }>,
    opts?: AssembleOptions,
  ): WalletSigner;
  /** Raw submit result of the last submit() (status history, extrinsic index, decoded events with types). */
  readonly lastSubmit: SubmitResult | undefined;
}

/** Block time from metadata constants: Babe.ExpectedBlockTime, else 2 x Timestamp.MinimumPeriod. */
export function blockTimeFromFacts(facts: RuntimeFacts): number | undefined {
  const consts = decodeRuntime(facts).decorated().consts as unknown as Record<
    string,
    Record<string, { toNumber(): number } | undefined> | undefined
  >;
  const expected = consts.babe?.expectedBlockTime?.toNumber();
  if (expected) return expected;
  const min = consts.timestamp?.minimumPeriod?.toNumber();
  // Below a second means manual/instant seal (substrate-contracts-node: MinimumPeriod 5 ms): blocks come per
  // transaction, so metadata says nothing about real block time. Make the caller pass blockTimeMs.
  return min && min * 2 >= 1000 ? min * 2 : undefined;
}

/** Maps a submitAndWatch result to the SDK's StepOutcome. */
/** Classifies what we know about delivery from a finished watch. Anything ambiguous is 'uncertain'. */
export function deliveryOf(r: SubmitResult): SubmitDelivery {
  const nodeRefusal =
    /\b\d{4}:|invalid transaction|bad proof|stale|future|priority is too low|exhausts resources|ancient birth|outdated/i;
  if (r.status === "invalid" && r.history.every((h) => h === "invalid") && r.error) {
    if (/already imported|temporarily banned/i.test(r.error)) return "uncertain";
    return nodeRefusal.test(r.error) ? "rejected" : "uncertain";
  }
  if (r.timedOut && r.history.length === 0) return "uncertain";
  return "accepted";
}

export function toStepOutcome(actionId: string, r: SubmitResult): StepOutcome {
  const out: StepOutcome = {
    actionId,
    status: "submitted",
    txHash: r.txHash,
    events: (r.inclusion?.events ?? []).map(toChainEvent),
  };
  if (r.inclusion) out.block = { number: r.inclusion.number, hash: r.inclusion.hash };
  if (r.inclusion?.success === false) {
    out.status = "failed";
    out.error = r.inclusion.dispatchError ?? "System.ExtrinsicFailed";
  } else if (["dropped", "invalid", "usurped", "finality_timeout"].includes(r.status)) {
    out.status = "failed";
    out.error = r.error ?? `the node reported ${r.status}`;
  } else if (r.status === "finalized" && r.inclusion) {
    out.status = "finalized";
  } else if (r.inclusion) {
    out.status = "included";
  }
  if (r.error && !out.error) out.error = r.error;
  out.delivery = deliveryOf(r);
  return out;
}

/**
 * Bot 5's ChainAdapter for Portaldot. discover/readFingerprint/preflight are read-only; submit broadcasts
 * a transaction the user's wallet already signed. The adapter holds no keys.
 */
export function createPortaldotAdapter(
  endpoint: Endpoint,
  options: PortaldotAdapterOptions = {},
): PortaldotAdapter {
  let facts = options.facts;
  let lastPreflight: PreflightReport | undefined;
  let lastSubmit: SubmitResult | undefined;
  const sent = new Map<
    Hex,
    { fromBlock: number | undefined; validUntilBlock: number | undefined }
  >();
  let lastDryRun: SignedDryRunDetail[] | undefined;
  // SEAM-001: the approved signing requests of the current operation, in order. submit() only accepts the next one.
  let approved: { requests: SigningRequest[]; next: number } | undefined;
  const broadcast = new Set<string>();
  const needFacts = (): RuntimeFacts => {
    if (!facts)
      throw new SeamChainError("FACTS_MISMATCH", "call discover() first (or pass options.facts)");
    return facts;
  };
  const discoverOpts = { ...options };
  delete discoverOpts.facts;
  // Re-reads compare against the pinned facts' metadata by layout: a drift in storage defaults only (V3's
  // Revive.EthBlockBuilderIR) keeps the pinned fingerprint; any other change still changes it.
  const pinnedOpts = () => {
    const pinned = options.pinnedMetadataHex ?? facts?.source.metadataHex;
    return pinned ? { ...discoverOpts, pinnedMetadataHex: pinned } : discoverOpts;
  };

  const adapter: PortaldotAdapter = {
    endpoint,
    get facts() {
      return facts;
    },
    get lastPreflight() {
      return lastPreflight;
    },
    get lastSubmit() {
      return lastSubmit;
    },
    get lastDryRun() {
      return lastDryRun;
    },

    async discover() {
      const found = await discover(endpoint, pinnedOpts());
      if (!facts) facts = found;
      else if (found.fingerprintDigest !== facts.fingerprintDigest) {
        throw new SeamChainError(
          "RUNTIME_CHANGED",
          "the node no longer matches the pinned facts given in options.facts",
        );
      }
      return facts;
    },

    readFingerprint() {
      return refetchFingerprint(endpoint, pinnedOpts());
    },

    async preflight(plan: Plan) {
      const f = needFacts();
      const report = await preflight(endpoint, plan, f, options);
      const checkpoint = await readSigningCheckpoint(endpoint, options);
      const mortalityBlocks = options.mortalityBlocks ?? 64;
      const blockTimeMs = options.blockTimeMs ?? blockTimeFromFacts(f);
      if (!blockTimeMs)
        throw new SeamChainError(
          "NODE_MISSING_VALUE",
          "block time not in metadata; pass options.blockTimeMs",
        );
      // The era counts from the checkpoint, so leave one block of margin before the transaction would die.
      const expiresAt = new Date(
        (options.now ?? (() => new Date()))().getTime() + (mortalityBlocks - 1) * blockTimeMs,
      ).toISOString();
      const envelope: SigningEnvelope = {
        signer: encodeAddress(plan.signer.publicKey, f.fingerprint.ss58Prefix),
        nonce: report.nonce,
        mortalityBlocks,
        checkpoint,
        expiresAt,
      };
      lastPreflight = report;
      return { preflight: report.result, envelope };
    },

    async submit(signedTx: Hex, actionId: string) {
      const f = needFacts();
      // Bound to the approved request: decode the real signed extrinsic, never trust what the wallet reported. Fail closed, send nothing.
      const refuse = (reasons: string[]): StepOutcome => {
        lastSubmit = undefined;
        return {
          actionId,
          status: "failed",
          delivery: "not_sent",
          events: [],
          error: `not sent: the signed transaction does not match the approved request (${reasons.join(", ")})`,
        };
      };
      if (!approved) return refuse(["no_approved_request"]);
      const req = approved.requests[approved.next];
      if (!req) return refuse(["no_remaining_request"]);
      const v = verifySignedAgainstRequest(signedTx, req, { facts: f });
      if (!v.ok) return refuse(v.reasons);
      const hash = extractSignedCall(signedTx, f).txHash;
      if (broadcast.has(hash)) return refuse(["replay_already_submitted"]);
      // SEAM-016: the checkpoint, nonce and era the wallet signed must still hold. Otherwise nothing is broadcast.
      const win = await checkSigningWindow(endpoint, req, options);
      if (!win.ok) {
        lastSubmit = undefined;
        return {
          actionId,
          status: "failed",
          delivery: "not_sent",
          events: [],
          error: `not sent: the signing window no longer holds (${win.reasons.join(", ")}: ${win.detail.join("; ")}); prepare and sign again`,
        };
      }
      if (options.dryRunBeforeSubmit !== false) {
        const d = await withClient(endpoint, (c) => dryRunOne(c, f, signedTx, 0), options);
        lastDryRun = [d];
        if (d.outcome === "failed") {
          lastSubmit = undefined;
          return {
            actionId,
            status: "failed",
            delivery: "not_sent",
            txHash: d.txHash,
            events: [],
            error: `not sent: the dry run right before submitting failed (${d.detail})`,
          };
        }
      }
      approved.next++;
      broadcast.add(hash);
      const birth = Number.parseInt(String(req.payload.blockNumber), 16);
      sent.set(hash, {
        fromBlock: Number.isSafeInteger(birth) ? birth : undefined,
        validUntilBlock:
          req.era.mortal && Number.isSafeInteger(birth) ? birth + req.era.period : undefined,
      });
      const opts: Parameters<typeof submitAndWatch>[3] = { ...options, facts: f };
      if (options.submitTimeoutMs !== undefined) opts.timeoutMs = options.submitTimeoutMs;
      let r: SubmitResult;
      try {
        r = await submitAndWatch(
          endpoint,
          signedTx,
          options.onStatus ? (u) => options.onStatus!(actionId, u) : undefined,
          opts,
        );
      } catch (e) {
        lastSubmit = undefined;
        // Refused before anything was sent (wrong chain, mainnet guard): not_sent. Anything else (connection lost, RPC error) is ambiguous.
        if (
          e instanceof SeamChainError &&
          (e.code === "FACTS_MISMATCH" || e.code === "MAINNET_SUBMIT_REFUSED")
        ) {
          return {
            actionId,
            status: "failed",
            delivery: "not_sent",
            txHash: hash,
            events: [],
            error: e.message,
          };
        }
        return {
          actionId,
          status: "submitted",
          delivery: "uncertain",
          txHash: hash,
          events: [],
          error: `the send ended without an answer (${(e as Error).message}); the transaction may or may not be on chain`,
        };
      }
      lastSubmit = r;
      return toStepOutcome(actionId, r);
    },

    async lookupTx(txHash) {
      const meta = sent.get(txHash.toLowerCase() as Hex);
      return lookupExtrinsic(endpoint, txHash, {
        ...options,
        ...(meta?.fromBlock !== undefined ? { fromBlock: meta.fromBlock } : {}),
        ...(meta?.validUntilBlock !== undefined ? { validUntilBlock: meta.validUntilBlock } : {}),
      });
    },

    async dryRunSigned(signedTxs) {
      const r = await dryRunSigned(endpoint, signedTxs, needFacts(), options);
      lastDryRun = r.details;
      return r.results;
    },

    verifySigned(signedTxs, calls, envelope) {
      const f = needFacts();
      const requests = signingRequestsForCalls(calls, f, envelope);
      const v = verifySignedBatch(signedTxs, requests, { facts: f });
      return {
        ok: v.ok,
        signedCalls: v.results.map((r) => r.signedCall as Hex),
        reasons: v.reasons,
      };
    },

    signedDecoder(calls, envelope) {
      const f = needFacts();
      return signedExtrinsicDecoder(f, signingRequestsForCalls(calls, f, envelope));
    },

    signingRequests(calls, envelope) {
      const requests = signingRequestsForCalls(calls, needFacts(), envelope);
      approved = { requests, next: 0 }; // a new operation replaces the previous one
      return requests;
    },

    walletFrom(signPayload, assembleOpts = {}) {
      return {
        async sign(calls, envelope) {
          const f = needFacts();
          const out: { signedTx: Hex; signedCall: Hex }[] = [];
          for (const req of adapter.signingRequests(calls, envelope)) {
            const { signature } = await signPayload(req.payload);
            const signedTx = assembleSignedExtrinsic(req.payload, signature, f, assembleOpts);
            const v = verifySignedAgainstRequest(signedTx, req, { facts: f });
            if (!v.ok)
              throw new SeamChainError(
                "SIGNED_MISMATCH",
                `the wallet's signed transaction ${req.index} does not match the approved request (${v.reasons.join(", ")})`,
              );
            out.push({ signedTx, signedCall: v.signedCall! });
          }
          return out;
        },
      };
    },
  };
  return adapter;
}
