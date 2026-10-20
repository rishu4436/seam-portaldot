import type { Hex, RuntimeFacts } from "@seam/compiler";
import { hexToU8a } from "@polkadot/util";
import { blake2AsHex } from "@polkadot/util-crypto";
import { sameMetadataLayout } from "./metadata-layout.js";
import { SeamChainError } from "./errors.js";
import { outcomeForExtrinsic, type DecodedEvent } from "./events.js";
import {
  rpc,
  toSafeNumber,
  withClient,
  type ConnectOptions,
  type Endpoint,
  type RpcClient,
} from "./rpc.js";
import { SYSTEM_EVENTS_KEY, extrinsicHash } from "./runtime.js";
import { extractSignedCall } from "./signing.js";
import type { BlockRef } from "./types.js";

/** Portaldot mainnet. SEAM refuses to submit here unless allowMainnet is set (the hackathon targets the V3 testnet). */
export const PORTALDOT_MAINNET_GENESIS: Hex =
  "0x83b5212c69f85f3996f8696bb35bf913af51b176a5f53d0a74fd3a83dc0b8a54";

export type TxStatus =
  | "submitted"
  | "in_block"
  | "retracted"
  | "finality_timeout"
  | "finalized"
  | "dropped"
  | "invalid"
  | "usurped";

export interface StatusUpdate {
  status: TxStatus;
  txHash: Hex;
  /** Block hash for in_block / retracted / finalized. */
  blockHash?: Hex;
  /** Raw author_extrinsicUpdate value. */
  raw: unknown;
}

export interface InclusionResult extends BlockRef {
  extrinsicIndex: number;
  events: DecodedEvent[];
  success: boolean | undefined;
  dispatchError?: string;
}

export interface SubmitResult {
  txHash: Hex;
  /** Last status reached: finalized on the happy path; in_block/submitted if timeoutMs ran out first. */
  status: TxStatus;
  /** Inclusion details (the finalized block when finalized). */
  inclusion?: InclusionResult;
  /** Statuses in the order the node reported them. */
  history: TxStatus[];
  timedOut: boolean;
  /** Why the node rejected or dropped the transaction. */
  error?: string;
}

export interface SubmitOptions extends ConnectOptions {
  /** Pinned runtime used to decode events (required). */
  facts: RuntimeFacts;
  /** Stop waiting after this long and return the last status. Default 5 minutes (Portaldot blocks are ~60 s). */
  timeoutMs?: number;
  /** Must be true to submit to Portaldot mainnet. Default false. */
  allowMainnet?: boolean;
}

/** Index of an extrinsic in a block, matched by tx hash. */
export async function findExtrinsicIndex(
  client: RpcClient,
  blockHash: Hex,
  txHash: Hex,
): Promise<number> {
  const block = await rpc<{ block: { extrinsics: string[] } } | null>(client, "chain_getBlock", [
    blockHash,
  ]);
  if (!block) throw new SeamChainError("NODE_MISSING_VALUE", `block ${blockHash} not found`);
  const i = block.block.extrinsics.findIndex((x) => extrinsicHash(x) === txHash.toLowerCase());
  if (i < 0)
    throw new SeamChainError(
      "NODE_MISSING_VALUE",
      `transaction ${txHash} is not in block ${blockHash}`,
    );
  return i;
}

async function eventsAt(
  client: RpcClient,
  blockHash: Hex,
  facts: RuntimeFacts,
): Promise<{ eventsHex: string; number: number }> {
  const [eventsHex, version, header, metadataHex] = await Promise.all([
    rpc<string | null>(client, "state_getStorage", [SYSTEM_EVENTS_KEY, blockHash]),
    rpc<{ specVersion: number }>(client, "state_getRuntimeVersion", [blockHash]),
    rpc<{ number: unknown } | null>(client, "chain_getHeader", [blockHash]),
    rpc<string | null>(client, "state_getMetadata", [blockHash]),
  ]);
  if (!header) throw new SeamChainError("NODE_MISSING_VALUE", `block ${blockHash} not found`);
  if (version.specVersion !== facts.fingerprint.specVersion) {
    throw new SeamChainError(
      "RUNTIME_CHANGED",
      `block ${blockHash} runs spec ${version.specVersion}, but the pinned runtime is spec ${facts.fingerprint.specVersion}; its events cannot be decoded safely`,
    );
  }
  // SEAM-015: the spec version alone does not pin the event layout. The metadata at the inclusion block must hash to the pinned metadata.
  if (typeof metadataHex !== "string" || !/^0x[0-9a-fA-F]*$/.test(metadataHex)) {
    throw new SeamChainError(
      "NODE_MISSING_VALUE",
      `no metadata at block ${blockHash}; its events cannot be decoded safely`,
    );
  }
  // Same bytes, or bytes that differ only in allow-listed storage default values (BLANKED_STORAGE_DEFAULTS: V3's state-dependent Revive.EthBlockBuilderIR
  // fallback), which no event, error or type depends on. Anything else is a real layout change.
  const blockMetadataHash = blake2AsHex(hexToU8a(metadataHex), 256).toLowerCase();
  if (
    blockMetadataHash !== facts.fingerprint.metadataHash.toLowerCase() &&
    !sameMetadataLayout(metadataHex, facts.source.metadataHex)
  ) {
    throw new SeamChainError(
      "RUNTIME_CHANGED",
      `block ${blockHash} has metadata ${blockMetadataHash}, not the pinned ${facts.fingerprint.metadataHash}; its events cannot be decoded safely`,
    );
  }
  if (!eventsHex)
    throw new SeamChainError("NODE_MISSING_VALUE", `no System.Events at block ${blockHash}`);
  return { eventsHex, number: toSafeNumber(header.number) };
}

/** Reads System.Events at a block, keeps the given extrinsic's events and decodes success or the dispatch error. */
export async function readEvents(
  endpoint: Endpoint,
  blockHash: Hex,
  extrinsicIndex: number,
  facts: RuntimeFacts,
  opts: ConnectOptions = {},
): Promise<InclusionResult> {
  return withClient(
    endpoint,
    async (client) => {
      const { eventsHex, number } = await eventsAt(client, blockHash, facts);
      return {
        number,
        hash: blockHash,
        extrinsicIndex,
        ...outcomeForExtrinsic(eventsHex, extrinsicIndex, facts),
      };
    },
    opts,
  );
}

/** readEvents for a tx hash: finds the extrinsic in the block first. */
export async function readInclusion(
  endpoint: Endpoint,
  blockHash: Hex,
  txHash: Hex,
  facts: RuntimeFacts,
  opts: ConnectOptions = {},
): Promise<InclusionResult> {
  return withClient(
    endpoint,
    async (client) =>
      readEvents(client, blockHash, await findExtrinsicIndex(client, blockHash, txHash), facts),
    opts,
  );
}

export interface FinalityResult {
  finalized: boolean;
  block: BlockRef;
  reason?: "timeout" | "not_canonical";
}

/** Waits until the block is finalized (and still canonical at its height), or timeoutMs passes. */
export async function waitFinalized(
  endpoint: Endpoint,
  blockHash: Hex,
  opts: ConnectOptions & { timeoutMs?: number } = {},
): Promise<FinalityResult> {
  return withClient(
    endpoint,
    async (client) => {
      const header = await rpc<{ number: unknown } | null>(client, "chain_getHeader", [blockHash]);
      if (!header) throw new SeamChainError("NODE_MISSING_VALUE", `block ${blockHash} not found`);
      const block: BlockRef = { number: toSafeNumber(header.number), hash: blockHash };
      const check = async (finalizedNumber: number): Promise<FinalityResult | undefined> => {
        if (finalizedNumber < block.number) return undefined;
        const canonical = await rpc<string>(client, "chain_getBlockHash", [block.number]);
        return canonical?.toLowerCase() === blockHash.toLowerCase()
          ? { finalized: true, block }
          : { finalized: false, block, reason: "not_canonical" };
      };
      const finalizedHash = await rpc<string>(client, "chain_getFinalizedHead", []);
      const fh = await rpc<{ number: unknown }>(client, "chain_getHeader", [finalizedHash]);
      const now = await check(toSafeNumber(fh.number));
      if (now) return now;

      return new Promise<FinalityResult>((resolve, reject) => {
        let subId: number | string | undefined;
        let done = false;
        const finish = (r: FinalityResult | Error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (subId !== undefined)
            client
              .unsubscribe("chain_finalizedHead", "chain_unsubscribeFinalizedHeads", subId)
              .catch(() => undefined);
          r instanceof Error ? reject(r) : resolve(r);
        };
        const timer = setTimeout(
          () => finish({ finalized: false, block, reason: "timeout" }),
          opts.timeoutMs ?? 300_000,
        );
        client
          .subscribe("chain_finalizedHead", "chain_subscribeFinalizedHeads", [], (err, head) => {
            if (err) return finish(err);
            check(toSafeNumber((head as { number: unknown }).number)).then(
              (r) => r && finish(r),
              finish,
            );
          })
          .then((id) => {
            subId = id;
            if (done)
              client
                .unsubscribe("chain_finalizedHead", "chain_unsubscribeFinalizedHeads", id)
                .catch(() => undefined);
          }, finish);
      });
    },
    opts,
  );
}

function parseUpdate(raw: unknown): { status: TxStatus; blockHash?: Hex } {
  if (raw === "future" || raw === "ready") return { status: "submitted" };
  if (raw === "dropped") return { status: "dropped" };
  if (raw === "invalid") return { status: "invalid" };
  if (raw && typeof raw === "object") {
    const [key, value] = Object.entries(raw as Record<string, unknown>)[0] ?? [];
    switch (key) {
      case "broadcast":
        return { status: "submitted" };
      case "inBlock":
        return { status: "in_block", blockHash: String(value).toLowerCase() as Hex };
      case "retracted":
        return { status: "retracted", blockHash: String(value).toLowerCase() as Hex };
      case "finalityTimeout":
        return { status: "finality_timeout", blockHash: String(value).toLowerCase() as Hex };
      case "finalized":
        return { status: "finalized", blockHash: String(value).toLowerCase() as Hex };
      case "usurped":
        return { status: "usurped" };
    }
  }
  return { status: "submitted" };
}

const TERMINAL: TxStatus[] = ["finalized", "dropped", "invalid", "usurped", "finality_timeout"];

/**
 * Broadcasts a signed extrinsic with author_submitAndWatchExtrinsic and tracks it: submitted -> in_block ->
 * finalized (or dropped / invalid / usurped / finality_timeout). On inclusion it reads System.Events at that
 * block, keeps this extrinsic's events and decodes success or the dispatch error. Resolves when a terminal
 * status arrives or timeoutMs passes. Refuses Portaldot mainnet unless allowMainnet is set.
 */
export async function submitAndWatch(
  endpoint: Endpoint,
  signedExtrinsicHex: Hex,
  onStatus: ((u: StatusUpdate) => void) | undefined,
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const { facts } = opts;
  extractSignedCall(signedExtrinsicHex, facts); // must be a signed extrinsic for this runtime
  const txHash = extrinsicHash(signedExtrinsicHex);
  return withClient(
    endpoint,
    async (client) => {
      const genesis = String(await rpc(client, "chain_getBlockHash", [0])).toLowerCase();
      if (genesis !== facts.fingerprint.genesisHash) {
        throw new SeamChainError(
          "FACTS_MISMATCH",
          `node genesis ${genesis} is not the facts' chain ${facts.fingerprint.genesisHash}`,
        );
      }
      if (genesis === PORTALDOT_MAINNET_GENESIS && !opts.allowMainnet) {
        throw new SeamChainError(
          "MAINNET_SUBMIT_REFUSED",
          "refusing to submit to Portaldot mainnet (set allowMainnet to override)",
        );
      }

      return new Promise<SubmitResult>((resolve, reject) => {
        const result: SubmitResult = { txHash, status: "submitted", history: [], timedOut: false };
        const inclusions = new Map<string, Promise<InclusionResult>>();
        let subId: number | string | undefined;
        let done = false;
        const include = (blockHash: Hex) => {
          let p = inclusions.get(blockHash);
          if (!p) {
            p = readInclusion(client, blockHash, txHash, facts);
            p.catch(() => undefined);
            inclusions.set(blockHash, p);
          }
          return p;
        };
        const finish = (err?: Error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (subId !== undefined)
            client
              .unsubscribe("author_extrinsicUpdate", "author_unwatchExtrinsic", subId)
              .catch(() => undefined);
          err ? reject(err) : resolve(result);
        };
        const timer = setTimeout(() => {
          result.timedOut = true;
          finish();
        }, opts.timeoutMs ?? 300_000);

        const handle = async (raw: unknown) => {
          const { status, blockHash } = parseUpdate(raw);
          result.status = status;
          result.history.push(status);
          const update: StatusUpdate = { status, txHash, raw };
          if (blockHash) update.blockHash = blockHash;
          try {
            onStatus?.(update);
          } catch {
            /* a listener error must not break tracking */
          }
          if ((status === "in_block" || status === "finalized") && blockHash) {
            try {
              result.inclusion = await include(blockHash);
            } catch (e) {
              result.error = `included in ${blockHash} but its events could not be read: ${(e as Error).message}`;
            }
          }
          if (status === "retracted") delete result.inclusion;
          if (status === "dropped" || status === "invalid" || status === "usurped")
            result.error = `node reported the transaction as ${status}`;
          if (TERMINAL.includes(status)) finish();
        };

        let queue = Promise.resolve();
        client
          .subscribe(
            "author_extrinsicUpdate",
            "author_submitAndWatchExtrinsic",
            [signedExtrinsicHex],
            (err, raw) => {
              if (err) {
                result.status = "invalid";
                result.error = err.message;
                return finish();
              }
              queue = queue.then(() => handle(raw)); // keep updates in order while events are read
            },
          )
          .then(
            (id) => {
              subId = id;
              if (done)
                client
                  .unsubscribe("author_extrinsicUpdate", "author_unwatchExtrinsic", id)
                  .catch(() => undefined);
            },
            (e: Error) => {
              // The node rejected it outright (e.g. "1010: Invalid Transaction: ... BadProof").
              result.status = "invalid";
              result.history.push("invalid");
              result.error = e.message;
              finish();
            },
          );
      });
    },
    opts,
  );
}
