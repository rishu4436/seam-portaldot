// Browser ChainClient over plain JSON-RPC (fetch for http(s), WebSocket for ws(s)). No node-only deps and no @seam/chain import.
// Scope is deliberately small and honest: discover reads genesis + runtime version; submit sends an already signed extrinsic
// with author_submitExtrinsic. It never reports inclusion, finality or verification it did not observe: submit returns
// "submitted", verify returns provenance "unknown" (verification needs the chain package's verifier, injected by the host),
// and preflight is unavailable (a signed dry run needs signed bytes, which exist only after the wallet signs).
import type { ChainClient, LiveFingerprint, Res } from "./live";

export type RpcTransport = (method: string, params: unknown[]) => Promise<unknown>;
export class RpcError extends Error { code: number; constructor(code: number, message: string) { super(message); this.code = code; } }
export class TransportError extends Error {}

export function httpTransport(url: string, fetchImpl: typeof fetch = (...a) => fetch(...a), timeoutMs = 15000): RpcTransport {
  let id = 0;
  return async (method, params) => {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
    let body: { result?: unknown; error?: { code: number; message: string } };
    try {
      const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: ctl?.signal });
      if (!r.ok) throw new TransportError(`HTTP ${r.status}`);
      body = await r.json();
    } catch (e) { throw e instanceof TransportError ? e : new TransportError(e instanceof Error ? e.message : String(e)); }
    finally { if (t) clearTimeout(t); }
    if (body.error) throw new RpcError(body.error.code, body.error.message);
    return body.result;
  };
}

interface WsLike { send(d: string): void; close(): void; onopen: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onerror: ((e: unknown) => void) | null; onclose: ((e: unknown) => void) | null }
export function wsTransport(url: string, WS: new (u: string) => WsLike = (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket as never, timeoutMs = 15000): RpcTransport {
  return (method, params) => new Promise((resolve, reject) => {
    if (!WS) return reject(new TransportError("WebSocket is not available in this browser"));
    let settled = false;
    const ws = new WS(url);
    const fin = (f: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } f(); };
    const timer = setTimeout(() => fin(() => reject(new TransportError("RPC timed out"))), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    ws.onerror = () => fin(() => reject(new TransportError("WebSocket error")));
    ws.onclose = () => fin(() => reject(new TransportError("WebSocket closed before a reply")));
    ws.onmessage = (e) => {
      let m: { id?: number; result?: unknown; error?: { code: number; message: string } };
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id !== 1) return;
      fin(() => (m.error ? reject(new RpcError(m.error.code, m.error.message)) : resolve(m.result)));
    };
  });
}

export function transportFor(url: string): RpcTransport { return /^wss?:/i.test(url) ? wsTransport(url) : httpTransport(url); }

const isHex = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v);
const rpcFail = (e: unknown): Res<never> => ({ ok: false, reason: "rpc_error", message: e instanceof Error ? e.message : String(e) });

export function createBrowserChainClient(rpc: RpcTransport): ChainClient {
  return {
    async discover() {
      try {
        const genesis = await rpc("chain_getBlockHash", [0]);
        const rv = (await rpc("state_getRuntimeVersion", [])) as { specName?: string; specVersion?: number; transactionVersion?: number } | null;
        if (!isHex(genesis) || !rv || typeof rv.specVersion !== "number") return { ok: false, reason: "rpc_error", message: "Node returned an unexpected discovery reply." };
        // metadataHash and digest are not computed here (no hashing dependency): left undefined, never invented.
        const value: LiveFingerprint = { genesisHash: genesis, specName: rv.specName, specVersion: rv.specVersion, transactionVersion: rv.transactionVersion };
        return { ok: true, value };
      } catch (e) { return rpcFail(e); }
    },
    async preflight() { return { ok: false, reason: "unavailable", message: "A signed dry run needs signed bytes, which exist only after the wallet signs." }; },
    async submit(signed) {
      if (!isHex(signed.signedTx)) return { ok: false, reason: "failed", message: "Signed transaction is not hex. Nothing was sent." };
      try {
        const h = await rpc("author_submitExtrinsic", [signed.signedTx]);
        if (!isHex(h)) return { ok: false, reason: "ambiguous", message: "Node replied without a transaction hash" };
        return { ok: true, value: { txHash: h, state: "submitted" } };
      } catch (e) {
        // A JSON-RPC error means the node refused it (not in the pool). A transport failure after sending is ambiguous.
        if (e instanceof RpcError) return { ok: false, reason: "failed", message: `Node refused the transaction: ${e.message} (${e.code})` };
        return { ok: false, reason: "ambiguous", message: e instanceof Error ? e.message : String(e) };
      }
    },
    async verify() { return { ok: true, value: { provenance: "unknown", note: "Chain verification is not wired in the browser build." } }; },
  };
}
