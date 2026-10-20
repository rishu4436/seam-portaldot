import { SeamChainError } from "./errors.js";

/**
 * The JSON-RPC surface SEAM needs. @polkadot/rpc-provider's WsProvider satisfies it, and tests use a
 * fake node with the same shape. Raw RPC on purpose: SEAM reads the exact bytes the node returns and
 * decodes them with the pinned runtime (the one in the fingerprint), never with whatever the node says now.
 */
export interface RpcClient {
  send<T = unknown>(method: string, params: unknown[]): Promise<T>;
  subscribe(
    type: string,
    method: string,
    params: unknown[],
    cb: (error: Error | null, result: unknown) => void,
  ): Promise<number | string>;
  unsubscribe(type: string, method: string, id: number | string): Promise<boolean>;
}

/** send() that turns node errors into SeamChainError('RPC_FAILED') naming the method. */
export async function rpc<T>(
  client: RpcClient,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  try {
    return await client.send<T>(method, params);
  } catch (e) {
    throw new SeamChainError("RPC_FAILED", `${method} failed: ${(e as Error).message}`);
  }
}

/** Parses a JSON-RPC number (number, decimal string or 0x hex) to bigint. */
export function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`unsafe number ${v}`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return BigInt(v);
  throw new Error(`not a number: ${JSON.stringify(v)}`);
}

export function toSafeNumber(v: unknown): number {
  const b = toBigInt(v);
  if (b > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`number too large: ${b}`);
  return Number(b);
}

const HASH_RE = /^0x[0-9a-f]{64}$/;

/** A 32-byte hash from the node, lower-cased; anything else is NODE_MISSING_VALUE. */
export function asHash(v: unknown, what: string): `0x${string}` {
  if (typeof v !== "string" || !HASH_RE.test(v.toLowerCase())) {
    throw new SeamChainError(
      "NODE_MISSING_VALUE",
      `node returned no valid ${what} (got ${JSON.stringify(v)})`,
    );
  }
  return v.toLowerCase() as `0x${string}`;
}

/** Best block hash and number. */
export async function readHead(
  client: RpcClient,
): Promise<{ number: number; hash: `0x${string}` }> {
  const hash = asHash(await rpc(client, "chain_getBlockHash", []), "best block hash");
  const header = await rpc<{ number: unknown } | null>(client, "chain_getHeader", [hash]);
  if (!header) throw new SeamChainError("NODE_MISSING_VALUE", `no header for best block ${hash}`);
  return { number: toSafeNumber(header.number), hash };
}

/** Minimal JSON-RPC sender (a fetch wrapper in the browser, or httpRpcClient().send). */
export type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;

/** An RpcClient over a plain `send`. Subscriptions are refused: everything SEAM reads through it is a single request. */
export function clientFromSend(send: RpcSend): RpcClient {
  return {
    send: <T>(method: string, params: unknown[]) => send(method, params) as Promise<T>,
    subscribe: () => Promise.reject(new Error("subscriptions are not available over a plain send")),
    unsubscribe: () => Promise.resolve(false),
  };
}
