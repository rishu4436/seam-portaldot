import { hexToU8a } from "@polkadot/util";
import { blake2AsHex } from "@polkadot/util-crypto";
import type { Hex } from "@seam/compiler";
import { SeamChainError } from "./errors.js";
import type { RpcClient } from "./rpc.js";

/**
 * JSON-RPC over HTTP(S) as a SEAM RpcClient, for nodes whose WebSocket drops (the Portaldot V3 test node closes with
 * 1006 several times a minute, often on the 1.1 MB state_getMetadata). Uses only `fetch` (Node 18+ or a browser).
 *
 * Retry rule: only methods on READ_METHODS / READ_PREFIXES are retried, on network errors, timeouts and HTTP
 * 429/502/503/504, with exponential backoff. A JSON-RPC error answer is the node's verdict and is never retried.
 * Everything else, author_submitExtrinsic included, is sent exactly once: a lost response is reported, never resent.
 *
 * Subscriptions are emulated by polling:
 *   - author_submitAndWatchExtrinsic: author_submitExtrinsic ONCE, then scans new best blocks for the extrinsic's hash
 *     and reports { inBlock }, then { finalized } once the finalized head reaches that height on the same hash (or
 *     { retracted } and keeps scanning). If the submit request's response was lost (network error or timeout), the
 *     transaction may or may not have reached the node: it is not resent; the watch keeps scanning, so the caller
 *     either sees it land or times out with nothing known (SEAM reports that as uncertain).
 *   - chain_subscribeFinalizedHeads / chain_subscribeNewHeads: poll the finalized / best head.
 */
export interface HttpRpcOptions {
  /** Per-request timeout. Default 60 s (state_getMetadata is ~1.1 MB on V3). */
  requestTimeoutMs?: number;
  /** Attempts for a retryable read, first try included. Default 6. */
  readAttempts?: number;
  /** First backoff delay; doubles per retry, capped at maxBackoffMs, plus up to 25% jitter. Default 500 ms. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Polling interval for emulated subscriptions. Default 3 s. */
  pollMs?: number;
  /** Injected for tests. Default globalThis.fetch. */
  fetch?: typeof fetch;
  /** Injected for tests. Default setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Read-only methods that are safe to repeat. */
export const READ_METHODS: ReadonlySet<string> = new Set([
  "rpc_methods",
  "system_health",
  "system_chain",
  "system_name",
  "system_version",
  "system_properties",
  "system_chainType",
  "system_accountNextIndex",
  "system_dryRun",
  "system_dryRunAt",
  "system_syncState",
  "author_pendingExtrinsics",
  "contracts_call",
]);
export const READ_PREFIXES: readonly string[] = [
  "chain_get",
  "state_get",
  "state_call",
  "state_query",
  "childstate_get",
  "payment_query",
];

export function isIdempotentRead(method: string): boolean {
  return READ_METHODS.has(method) || READ_PREFIXES.some((p) => method.startsWith(p));
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

class RpcAnswerError extends Error {
  readonly rpcCode: number | undefined;
  constructor(code: number | undefined, message: string) {
    super(message);
    this.rpcCode = code;
  }
}
class TransportError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export interface HttpRpcClient extends RpcClient {
  readonly url: string;
  /** Stops every emulated subscription. */
  close(): void;
  /** Requests sent per method (for tests and evidence). */
  readonly stats: Record<string, number>;
}

const hashOf = (xt: string) => blake2AsHex(hexToU8a(xt), 256).toLowerCase() as Hex;

export function httpRpcClient(url: string, opts: HttpRpcOptions = {}): HttpRpcClient {
  if (!/^https?:\/\//.test(url)) throw new Error(`httpRpcClient needs an http(s) URL, got ${url}`);
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("httpRpcClient: no fetch available");
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.requestTimeoutMs ?? 60_000;
  const attempts = Math.max(1, opts.readAttempts ?? 6);
  const base = opts.backoffMs ?? 500;
  const cap = opts.maxBackoffMs ?? 8_000;
  const pollMs = opts.pollMs ?? 3_000;
  const stats: Record<string, number> = {};
  const subs = new Map<string, { stopped: boolean }>();
  let id = 0;

  const once = async (method: string, params: unknown[]): Promise<unknown> => {
    stats[method] = (stats[method] ?? 0) + 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new TransportError(
        ctrl.signal.aborted
          ? `no response within ${timeoutMs} ms`
          : `network error (${(e as Error).message})`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new TransportError(`HTTP ${res.status}`, RETRY_STATUS.has(res.status));
    let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      throw new TransportError(`unreadable response (${(e as Error).message})`, true);
    }
    if (body.error) {
      const d = body.error.data !== undefined ? `: ${String(body.error.data)}` : "";
      throw new RpcAnswerError(body.error.code, `${body.error.code}: ${body.error.message}${d}`);
    }
    return body.result;
  };

  const send = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const retry = isIdempotentRead(method);
    let last: TransportError | undefined;
    for (let i = 0; i < (retry ? attempts : 1); i++) {
      if (i > 0) {
        const d = Math.min(cap, base * 2 ** (i - 1));
        await sleep(d + Math.floor(Math.random() * d * 0.25));
      }
      try {
        return (await once(method, params)) as T;
      } catch (e) {
        if (!(e instanceof TransportError)) throw e;
        last = e;
        if (!e.retryable) break;
      }
    }
    throw new SeamChainError(
      "RPC_FAILED",
      retry
        ? `${method} over HTTP failed after ${attempts} attempts: ${last?.message}`
        : `${method} over HTTP: ${last?.message}; it was sent once and is not retried (its effect is unknown)`,
    );
  };

  const num = (h: unknown) => parseInt(String((h as { number?: unknown })?.number ?? "0x0"), 16);

  const watchExtrinsic = (
    sid: string,
    xt: string,
    startBest: number,
    cb: (e: Error | null, r: unknown) => void,
  ) => {
    const stop = subs.get(sid)!;
    const want = hashOf(xt);
    (async () => {
      let scanned = startBest;
      for (;;) {
        let found: { n: number; hash: string } | undefined;
        while (!stop.stopped && !found) {
          const best = num(await send("chain_getHeader", []).catch(() => null));
          for (let n = scanned + 1; n <= best && !found; n++) {
            const hash = await send<string | null>("chain_getBlockHash", [n]).catch(() => null);
            if (!hash) break;
            const blk = await send<{ block: { extrinsics: string[] } } | null>("chain_getBlock", [
              hash,
            ]).catch(() => null);
            if (!blk) break;
            scanned = n;
            if (blk.block.extrinsics.some((x) => hashOf(x) === want)) found = { n, hash };
          }
          if (!found && !stop.stopped) await sleep(pollMs);
        }
        if (stop.stopped || !found) return;
        cb(null, { inBlock: found.hash });
        for (;;) {
          if (stop.stopped) return;
          const fh = await send<string>("chain_getFinalizedHead", []).catch(() => null);
          const f = fh ? await send("chain_getHeader", [fh]).catch(() => null) : null;
          if (f && num(f) >= found.n) {
            const canon = await send<string>("chain_getBlockHash", [found.n]).catch(() => null);
            if (!canon) {
              await sleep(pollMs);
              continue;
            }
            if (canon.toLowerCase() === found.hash.toLowerCase()) {
              cb(null, { finalized: found.hash });
              return;
            }
            cb(null, { retracted: found.hash });
            scanned = found.n - 1; // look again from that height on the new canonical chain
            break;
          }
          await sleep(pollMs);
        }
      }
    })().catch((e) => cb(e as Error, undefined));
  };

  const pollHeads = (
    sid: string,
    method: "chain_getFinalizedHead" | "chain_getBlockHash",
    cb: (e: Error | null, r: unknown) => void,
  ) => {
    const stop = subs.get(sid)!;
    (async () => {
      let lastHash: string | undefined;
      while (!stop.stopped) {
        const h = await send<string>(method, []).catch(() => null);
        if (h && h !== lastHash) {
          const header = await send("chain_getHeader", [h]).catch(() => null);
          if (header && !stop.stopped) {
            lastHash = h;
            cb(null, header);
          }
        }
        await sleep(pollMs);
      }
    })().catch((e) => cb(e as Error, undefined));
  };

  const client: HttpRpcClient = {
    url,
    stats,
    send,
    async subscribe(_type, method, params, cb) {
      const sid = `http-poll-${++id}`;
      if (method === "author_submitAndWatchExtrinsic") {
        const [xt] = params as [string];
        const start = num(await send("chain_getHeader", []));
        subs.set(sid, { stopped: false });
        try {
          await once("author_submitExtrinsic", [xt]); // exactly once, never retried
          cb(null, "ready");
        } catch (e) {
          if (!(e instanceof TransportError)) {
            subs.delete(sid);
            throw e; // the node answered: e.g. "1010: Invalid Transaction ..." (a definite refusal)
          }
          // Response lost: it may or may not have reached the node. Not resent; keep watching for it.
        }
        watchExtrinsic(sid, xt, start, cb);
        return sid;
      }
      if (method === "chain_subscribeFinalizedHeads" || method === "chain_subscribeNewHeads") {
        subs.set(sid, { stopped: false });
        pollHeads(
          sid,
          method === "chain_subscribeFinalizedHeads"
            ? "chain_getFinalizedHead"
            : "chain_getBlockHash",
          cb,
        );
        return sid;
      }
      throw new SeamChainError(
        "RPC_FAILED",
        `httpRpcClient: subscription ${method} is not supported`,
      );
    },
    async unsubscribe(_type, _method, sid) {
      const s = subs.get(String(sid));
      if (s) s.stopped = true;
      return subs.delete(String(sid));
    },
    close() {
      for (const s of subs.values()) s.stopped = true;
      subs.clear();
    },
  };
  return client;
}
