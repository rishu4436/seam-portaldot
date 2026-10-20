// Browser ChainClient over plain JSON-RPC (fetch for http(s), WebSocket for ws(s)). No node-only deps and no @seam/chain import.
// Scope is deliberately small and honest: discover reads genesis + runtime version; submit sends an already signed extrinsic
// with author_submitExtrinsic. It never reports inclusion, finality or verification it did not observe: submit returns
// "submitted"; verify re-reads finalized blocks and needs the host's extrinsic hasher; preflight is a payment_queryInfo fee
// estimate only (needs the host's encoder), never a signed dry run.
import type { ChainClient, LiveFingerprint, Res, VerifyResult } from "./live";
import type { SigningContext } from "./host";

export type RpcTransport = (method: string, params: unknown[]) => Promise<unknown>;
export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
export class TransportError extends Error {}

export function httpTransport(
  url: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  timeoutMs = 15000,
): RpcTransport {
  let id = 0;
  return async (method, params) => {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
    let body: { result?: unknown; error?: { code: number; message: string } };
    try {
      const r = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: ctl?.signal,
      });
      if (!r.ok) throw new TransportError(`HTTP ${r.status}`);
      body = await r.json();
    } catch (e) {
      throw e instanceof TransportError
        ? e
        : new TransportError(e instanceof Error ? e.message : String(e));
    } finally {
      if (t) clearTimeout(t);
    }
    if (body.error) throw new RpcError(body.error.code, body.error.message);
    return body.result;
  };
}

interface WsLike {
  send(d: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
}
export function wsTransport(
  url: string,
  WS: new (u: string) => WsLike = (globalThis as { WebSocket?: new (u: string) => WsLike })
    .WebSocket as never,
  timeoutMs = 15000,
): RpcTransport {
  return (method, params) =>
    new Promise((resolve, reject) => {
      if (!WS) return reject(new TransportError("WebSocket is not available in this browser"));
      let settled = false;
      const ws = new WS(url);
      const fin = (f: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        f();
      };
      const timer = setTimeout(
        () => fin(() => reject(new TransportError("RPC timed out"))),
        timeoutMs,
      );
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
      ws.onerror = () => fin(() => reject(new TransportError("WebSocket error")));
      ws.onclose = () => fin(() => reject(new TransportError("WebSocket closed before a reply")));
      ws.onmessage = (e) => {
        let m: { id?: number; result?: unknown; error?: { code: number; message: string } };
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.id !== 1) return;
        fin(() =>
          m.error ? reject(new RpcError(m.error.code, m.error.message)) : resolve(m.result),
        );
      };
    });
}

export function transportFor(url: string): RpcTransport {
  return /^wss?:/i.test(url) ? wsTransport(url) : httpTransport(url);
}

const isHex = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v);
const rpcFail = (e: unknown): Res<never> => ({
  ok: false,
  reason: "rpc_error",
  message: e instanceof Error ? e.message : String(e),
});

export interface ClientOptions {
  /** Hash an encoded extrinsic like the chain does (from the host). Without it verify() cannot find anything and stays unknown. */
  extrinsicHash?: (hex: string) => string;
  /** Encoded extrinsic for payment_queryInfo (from the host). Without it preflight is unavailable. */
  feeExtrinsic?: (request: unknown) => string | Promise<string>;
  /** How many finalized blocks back from the head to scan, and how many polls (with sleep between) to wait for finality. */
  lookback?: number;
  polls?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Reads the chain state a signing request needs. Read-only. */
export async function readSigningContext(
  rpc: RpcTransport,
  address: string,
  mortalityBlocks = 64,
): Promise<Res<SigningContext>> {
  try {
    const [genesis, rv, nonce, head] = await Promise.all([
      rpc("chain_getBlockHash", [0]),
      rpc("state_getRuntimeVersion", []),
      rpc("system_accountNextIndex", [address]),
      rpc("chain_getFinalizedHead", []),
    ]);
    const hdr = (await rpc("chain_getHeader", [head])) as { number?: string } | null;
    const r = rv as { specVersion?: number; transactionVersion?: number } | null;
    const num = hdr && typeof hdr.number === "string" ? Number(BigInt(hdr.number)) : NaN;
    if (
      !isHex(genesis) ||
      !isHex(head) ||
      !r ||
      typeof r.specVersion !== "number" ||
      typeof r.transactionVersion !== "number" ||
      typeof nonce !== "number" ||
      !Number.isFinite(num)
    )
      return {
        ok: false,
        reason: "rpc_error",
        message: "Node returned an unexpected signing-context reply.",
      };
    return {
      ok: true,
      value: {
        genesisHash: genesis,
        specVersion: r.specVersion,
        transactionVersion: r.transactionVersion,
        nonce,
        checkpointHash: head,
        checkpointNumber: num,
        mortalityBlocks,
      },
    };
  } catch (e) {
    return rpcFail(e);
  }
}

type Block = {
  block?: { header?: { number?: string; parentHash?: string }; extrinsics?: unknown[] };
} | null;

/**
 * Finds the extrinsic by hash in a FINALIZED block by re-reading the chain (finalized head, then parents). Found: included +
 * finalized with block number and hash. Not found after the polls: still "submitted" (not proven absent). Any RPC loss: error.
 * It decodes no events, so coverage is at most extrinsic_finalized.
 */
export async function findInFinalized(
  rpc: RpcTransport,
  txHash: string,
  hashOf: (hex: string) => string,
  opts: ClientOptions = {},
): Promise<Res<VerifyResult>> {
  const want = txHash.toLowerCase();
  const lookback = opts.lookback ?? 30,
    polls = opts.polls ?? 5,
    sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    for (let p = 0; p < polls; p++) {
      let h: unknown = await rpc("chain_getFinalizedHead", []);
      for (let i = 0; i < lookback && isHex(h); i++) {
        const b = (await rpc("chain_getBlock", [h])) as Block;
        const hd = b?.block?.header;
        if (!hd) break;
        const exts = b?.block?.extrinsics ?? [];
        if (exts.some((x) => isHex(x) && hashOf(x).toLowerCase() === want)) {
          return {
            ok: true,
            value: {
              provenance: "chain_verified",
              state: "finalized",
              coverage: "extrinsic_finalized",
              block: { number: Number(BigInt(hd.number ?? "0x0")), hash: h as string },
              note: "Found in a finalized block. Events and effects were not decoded.",
            },
          };
        }
        h = hd.parentHash;
      }
      if (p < polls - 1) await sleep(3000);
    }
    return {
      ok: true,
      value: {
        provenance: "unknown",
        note: "Not found in recent finalized blocks yet. Not proven absent.",
      },
    };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof RpcError ? "failed" : "rpc_error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export function createBrowserChainClient(rpc: RpcTransport, opts: ClientOptions = {}): ChainClient {
  return {
    async discover() {
      try {
        const genesis = await rpc("chain_getBlockHash", [0]);
        const rv = (await rpc("state_getRuntimeVersion", [])) as {
          specName?: string;
          specVersion?: number;
          transactionVersion?: number;
        } | null;
        if (!isHex(genesis) || !rv || typeof rv.specVersion !== "number")
          return {
            ok: false,
            reason: "rpc_error",
            message: "Node returned an unexpected discovery reply.",
          };
        // metadataHash and digest are not computed here (no hashing dependency): left undefined, never invented.
        const value: LiveFingerprint = {
          genesisHash: genesis,
          specName: rv.specName,
          specVersion: rv.specVersion,
          transactionVersion: rv.transactionVersion,
        };
        return { ok: true, value };
      } catch (e) {
        return rpcFail(e);
      }
    },
    async preflight(request) {
      if (!opts.feeExtrinsic)
        return {
          ok: false,
          reason: "unavailable",
          message:
            "No fee-estimate encoder is wired. A signed dry run needs signed bytes, which exist only after the wallet signs.",
        };
      try {
        const info = (await rpc("payment_queryInfo", [await opts.feeExtrinsic(request)])) as {
          partialFee?: unknown;
          weight?: unknown;
        } | null;
        if (!info || typeof info !== "object")
          return { ok: false, reason: "rpc_error", message: "Node returned no fee info." };
        const pf = info.partialFee;
        const fee =
          typeof pf === "number" || typeof pf === "bigint"
            ? BigInt(pf).toString()
            : typeof pf === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(pf)
              ? BigInt(pf).toString()
              : undefined;
        if (fee === undefined)
          return { ok: false, reason: "rpc_error", message: "Node fee info has no partialFee." };
        // payment_queryInfo is a fee/weight estimate only, never a dry run of the signed transaction.
        return {
          ok: true,
          value: { simulation: "fee_estimate_only", partialFee: fee, weight: info.weight },
        };
      } catch (e) {
        return rpcFail(e);
      }
    },
    async submit(signed) {
      if (!isHex(signed.signedTx))
        return {
          ok: false,
          reason: "failed",
          message: "Signed transaction is not hex. Nothing was sent.",
        };
      try {
        const h = await rpc("author_submitExtrinsic", [signed.signedTx]);
        if (!isHex(h))
          return {
            ok: false,
            reason: "ambiguous",
            message: "Node replied without a transaction hash",
          };
        return { ok: true, value: { txHash: h, state: "submitted" } };
      } catch (e) {
        // A JSON-RPC error means the node refused it (not in the pool). A transport failure after sending is ambiguous.
        if (e instanceof RpcError)
          return {
            ok: false,
            reason: "failed",
            message: `Node refused the transaction: ${e.message} (${e.code})`,
          };
        return {
          ok: false,
          reason: "ambiguous",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
    async verify(txHash) {
      if (!opts.extrinsicHash)
        return {
          ok: true,
          value: {
            provenance: "unknown",
            note: "No extrinsic hasher is wired, so the chain cannot be searched.",
          },
        };
      return findInFinalized(rpc, txHash, opts.extrinsicHash, opts);
    },
  };
}
