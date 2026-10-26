import { WsProvider } from "@polkadot/rpc-provider";
import { SeamChainError } from "./errors.js";
import { httpRpcClient } from "./http-transport.js";
import type { RpcClient } from "./rpc-core.js";
export { rpc, toBigInt, toSafeNumber, type RpcClient } from "./rpc-core.js";

/**
 * A ws(s):// URL (SEAM opens and closes a WebSocket), an http(s):// URL (JSON-RPC over HTTP, see httpRpcClient:
 * idempotent reads retried, submissions sent once), or an already-open client (left open).
 */
export type Endpoint = string | RpcClient;

export interface ConnectOptions {
  /** How long to wait for the WebSocket to open. Default 15 s. */
  connectTimeoutMs?: number;
  /** Per-request timeout. Default 60 s. */
  requestTimeoutMs?: number;
}

export async function connect(url: string, opts: ConnectOptions = {}): Promise<WsProvider> {
  const provider = new WsProvider(url, false, {}, opts.requestTimeoutMs ?? 60_000);
  let timer: NodeJS.Timeout | undefined;
  // Before the first open, fail fast on the provider's first 'error' / 'disconnected' (e.g. ECONNREFUSED) instead
  // of waiting out the timeout while WsProvider retries. The listeners are removed once connected, so after a
  // successful connect WsProvider's own auto-reconnect is unchanged. The timeout stays as a fallback.
  const offs: (() => void)[] = [];
  try {
    const earlyFailure = new Promise<never>((_, reject) => {
      const fail = (kind: string) => (err?: unknown) =>
        reject(
          new SeamChainError(
            "CONNECT_FAILED",
            `could not connect to ${url}: ${kind}${err instanceof Error && err.message ? ` (${err.message})` : ""} before the connection was ready`,
          ),
        );
      offs.push(provider.on("error", fail("connection error")));
      offs.push(provider.on("disconnected", fail("disconnected")));
    });
    earlyFailure.catch(() => undefined);
    await Promise.race([provider.connect(), earlyFailure]);
    await Promise.race([
      provider.isReady,
      earlyFailure,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SeamChainError(
                "CONNECT_FAILED",
                `could not connect to ${url} within ${opts.connectTimeoutMs ?? 15_000} ms`,
              ),
            ),
          opts.connectTimeoutMs ?? 15_000,
        );
      }),
    ]);
    return provider;
  } catch (e) {
    await provider.disconnect().catch(() => undefined);
    if (e instanceof SeamChainError) throw e;
    throw new SeamChainError(
      "CONNECT_FAILED",
      `could not connect to ${url}: ${(e as Error).message}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    for (const off of offs) off();
  }
}

/** Runs fn with a client. Connections SEAM opened are always closed afterwards. */
export async function withClient<T>(
  endpoint: Endpoint,
  fn: (client: RpcClient) => Promise<T>,
  opts: ConnectOptions = {},
): Promise<T> {
  if (typeof endpoint !== "string") return fn(endpoint);
  if (/^https?:\/\//.test(endpoint)) {
    const http = httpRpcClient(endpoint, { requestTimeoutMs: opts.requestTimeoutMs ?? 60_000 });
    try {
      return await fn(http);
    } finally {
      http.close();
    }
  }
  const provider = await connect(endpoint, opts);
  try {
    return await fn(provider as unknown as RpcClient);
  } finally {
    await provider.disconnect().catch(() => undefined);
  }
}

export function endpointLabel(endpoint: Endpoint): string | undefined {
  return typeof endpoint === "string" ? endpoint : undefined;
}
