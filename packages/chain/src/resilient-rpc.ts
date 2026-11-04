import type { RpcSend } from "./rpc-core.js";
class RpcRuntimeChangedError extends Error {}

export const V3_RPC_ENDPOINTS = [
  "https://test-node-v3.portaldot.dev",
  "wss://test-node-v3.portaldot.dev",
] as const;
export const V3_RPC_IDENTITY = {
  genesisHash: "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd",
  specName: "portaldot-v3",
};
export const READ_RPC_METHODS = new Set([
  "chain_getBlockHash",
  "chain_getFinalizedHead",
  "chain_getHeader",
  "chain_getBlock",
  "state_getRuntimeVersion",
  "state_getMetadata",
  "state_getStorage",
  "state_getKeysPaged",
  "state_call",
  "system_properties",
  "system_health",
  "system_accountNextIndex",
  "system_dryRun",
  "payment_queryInfo",
  "payment_queryFeeDetails",
  "contracts_call",
  "rpc_methods",
]);

/** Bounded JSON-RPC transport. Does not retry, redirect, or send credentials. */
export function createJsonRpcTransport(
  endpoint: string,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    deadline?: number;
    maximumBytes?: number;
  } = {},
): RpcSend {
  const url = new URL(endpoint);
  if (
    !["https:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Trusted RPC endpoints must use HTTPS/WSS without credentials or query parameters.",
    );
  let id = 0;
  const maximum = options.maximumBytes ?? 8 * 1024 * 1024;
  const decode = (text: string, requestId: number) => {
    if (new TextEncoder().encode(text).byteLength > maximum)
      throw new Error("RPC response is too large.");
    const value = JSON.parse(text);
    if (value?.jsonrpc !== "2.0" || value.id !== requestId || value.error || !("result" in value))
      throw new Error("RPC returned a mismatched or failed response.");
    return value.result;
  };
  return async (method, params) => {
    const requestId = ++id;
    const payload = JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params });
    if (Date.now() >= (options.deadline ?? Infinity))
      throw new Error("RPC verification time budget exhausted.");
    const timeout = Math.max(
      1,
      Math.min(
        options.timeoutMs ?? (method === "state_getMetadata" ? 12000 : 6000),
        (options.deadline ?? Infinity) - Date.now(),
      ),
    );
    if (url.protocol === "wss:")
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url.href);
        let settled = false;
        const finish = (error?: unknown, value?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.close();
          if (error) reject(error);
          else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error("RPC timed out.")), timeout);
        socket.onopen = () => socket.send(payload);
        socket.onerror = () => finish(new Error("RPC WebSocket connection failed."));
        socket.onclose = () => finish(new Error("RPC closed before replying."));
        socket.onmessage = (event) => {
          try {
            finish(undefined, decode(String(event.data), requestId));
          } catch (error) {
            finish(error);
          }
        };
      });
    const response = await (options.fetch ?? fetch)(url.href, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}.`);
    if (Number(response.headers.get("content-length")) > maximum) {
      await response.body?.cancel();
      throw new Error("RPC response is too large.");
    }
    if (!response.body) throw new Error("RPC returned an empty response.");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > maximum) {
          await reader.cancel();
          throw new Error("RPC response is too large.");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return decode(new TextDecoder().decode(bytes), requestId);
  };
}

/** Read-only retries across an explicitly trusted pool. Each endpoint must match genesis and runtime versions.
 * Runtime changes invalidate this reader; create a new reader and rediscover before signing.
 * Submission and subscriptions are always rejected, including when every endpoint is unavailable.
 */
export function createReadFailover(
  options: {
    endpoints?: readonly string[];
    transport?: (endpoint: string) => RpcSend;
    expected?: { genesisHash: string; specName: string };
    deadline?: number;
    rounds?: number;
    onFailover?: (endpoint: string) => void;
  } = {},
): RpcSend {
  const endpoints = [...new Set(options.endpoints ?? V3_RPC_ENDPOINTS)];
  if (!endpoints.length || endpoints.length > 4)
    throw new Error("Configure 1–4 trusted RPC endpoints.");
  const expected = options.expected ?? V3_RPC_IDENTITY;
  const nodes = endpoints.map((endpoint) => ({
    endpoint,
    send: (
      options.transport ?? ((url) => createJsonRpcTransport(url, { deadline: options.deadline }))
    )(endpoint),
    checked: 0,
    invalid: false,
    pending: undefined as Promise<void> | undefined,
  }));
  let active = 0,
    runtime: string | undefined;
  async function validate(node: (typeof nodes)[number]) {
    if (node.invalid) throw new Error("RPC endpoint failed its identity or runtime check.");
    if (node.checked && Date.now() - node.checked < 10000) return;
    node.pending ??= (async () => {
      const [genesis, version] = await Promise.all([
        node.send("chain_getBlockHash", [0]),
        node.send("state_getRuntimeVersion", []),
      ]);
      const v = version as { specName?: string; specVersion?: number; transactionVersion?: number };
      const identity = JSON.stringify([v?.specName, v?.specVersion, v?.transactionVersion]);
      if (
        typeof genesis !== "string" ||
        genesis.toLowerCase() !== expected.genesisHash.toLowerCase() ||
        v?.specName !== expected.specName ||
        !Number.isSafeInteger(v.specVersion) ||
        Number(v.specVersion) < 0 ||
        !Number.isSafeInteger(v.transactionVersion) ||
        Number(v.transactionVersion) < 0
      ) {
        node.invalid = true;
        throw new Error("RPC network identity mismatch.");
      }
      if (runtime !== undefined && runtime !== identity)
        throw new RpcRuntimeChangedError(
          "RPC runtime mismatch. Rediscover the runtime before continuing.",
        );
      runtime ??= identity;
      node.checked = Date.now();
    })();
    try {
      await node.pending;
    } finally {
      node.pending = undefined;
    }
  }
  return async (method, params) => {
    if (!READ_RPC_METHODS.has(method))
      throw new Error("Failover permits read-only RPC methods; submission is never retried.");
    const start = active;
    let last: unknown;
    for (let round = 0; round < Math.min(2, options.rounds ?? 2); round++) {
      for (let offset = 0; offset < nodes.length; offset++) {
        if (Date.now() >= (options.deadline ?? Infinity))
          throw new Error("RPC verification time budget exhausted.");
        const index = (start + offset) % nodes.length,
          node = nodes[index];
        try {
          await validate(node);
          if (Date.now() >= (options.deadline ?? Infinity))
            throw new Error("RPC verification time budget exhausted.");
          const value = await node.send(method, params);
          if (active !== index) options.onFailover?.(node.endpoint);
          active = index;
          return value;
        } catch (error) {
          node.checked = 0;
          if (error instanceof RpcRuntimeChangedError) throw error;
          last = error;
        }
      }
    }
    throw new Error(
      `Trusted testnet RPC connections are unavailable: ${last instanceof Error ? last.message : "read failed"}`,
    );
  };
}
