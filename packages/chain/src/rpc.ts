import { WsProvider } from '@polkadot/rpc-provider';
import { SeamChainError } from './errors.js';

/**
 * The JSON-RPC surface SEAM needs. @polkadot/rpc-provider's WsProvider satisfies it, and tests use a
 * fake node with the same shape. Raw RPC on purpose: SEAM reads the exact bytes the node returns and
 * decodes them with the pinned runtime (the one in the fingerprint), never with whatever the node says now.
 */
export interface RpcClient {
  send<T = unknown>(method: string, params: unknown[]): Promise<T>;
  subscribe(type: string, method: string, params: unknown[], cb: (error: Error | null, result: unknown) => void): Promise<number | string>;
  unsubscribe(type: string, method: string, id: number | string): Promise<boolean>;
}

/** A WebSocket URL (SEAM opens and closes the connection) or an already-open client (left open). */
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
  try {
    await provider.connect();
    await Promise.race([
      provider.isReady,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SeamChainError('CONNECT_FAILED', `could not connect to ${url} within ${opts.connectTimeoutMs ?? 15_000} ms`)), opts.connectTimeoutMs ?? 15_000);
      })
    ]);
    return provider;
  } catch (e) {
    await provider.disconnect().catch(() => undefined);
    if (e instanceof SeamChainError) throw e;
    throw new SeamChainError('CONNECT_FAILED', `could not connect to ${url}: ${(e as Error).message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs fn with a client. Connections SEAM opened are always closed afterwards. */
export async function withClient<T>(endpoint: Endpoint, fn: (client: RpcClient) => Promise<T>, opts: ConnectOptions = {}): Promise<T> {
  if (typeof endpoint !== 'string') return fn(endpoint);
  const provider = await connect(endpoint, opts);
  try {
    return await fn(provider as unknown as RpcClient);
  } finally {
    await provider.disconnect().catch(() => undefined);
  }
}

export function endpointLabel(endpoint: Endpoint): string | undefined {
  return typeof endpoint === 'string' ? endpoint : undefined;
}

/** send() that turns node errors into SeamChainError('RPC_FAILED') naming the method. */
export async function rpc<T>(client: RpcClient, method: string, params: unknown[] = []): Promise<T> {
  try {
    return await client.send<T>(method, params);
  } catch (e) {
    throw new SeamChainError('RPC_FAILED', `${method} failed: ${(e as Error).message}`);
  }
}

/** Parses a JSON-RPC number (number, decimal string or 0x hex) to bigint. */
export function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`unsafe number ${v}`);
    return BigInt(v);
  }
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return BigInt(v);
  throw new Error(`not a number: ${JSON.stringify(v)}`);
}

export function toSafeNumber(v: unknown): number {
  const b = toBigInt(v);
  if (b > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`number too large: ${b}`);
  return Number(b);
}
