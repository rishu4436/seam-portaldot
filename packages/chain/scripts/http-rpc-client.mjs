// An RpcClient (packages/chain/src/rpc.ts) over JSON-RPC HTTP, for nodes whose WebSocket drops connections
// (the Portaldot V3 test node closes with 1006 several times a minute, often on the 1.1 MB state_getMetadata).
// SEAM's chain functions accept an RpcClient wherever they accept a ws:// URL.
//  - send(): HTTP POST, retried on network errors and 5xx. author_submitExtrinsic is retried too: resending the same
//    signed bytes can only be accepted once (same hash and nonce); a duplicate is rejected by the node.
//  - subscribe(author_submitAndWatchExtrinsic): author_submitExtrinsic, then polling the best chain for the
//    extrinsic (inBlock) and the finalized head (finalized). Updates use the node's own status shapes.
//  - subscribe(chain_subscribeFinalizedHeads): polls chain_getFinalizedHead.
// Responses are not interpreted here: SEAM still decodes every byte with the pinned runtime.
import { extrinsicHash } from "../dist/index.js";

export function httpRpcClient(url, { pollMs = 3000, tries = 8 } = {}) {
  let id = 0;
  const subs = new Map();
  const post = async (method, params) => {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (j.error) {
          const e = new Error(
            `${j.error.code}: ${j.error.message}${j.error.data ? `: ${j.error.data}` : ""}`,
          );
          e.rpcError = true;
          throw e;
        }
        return j.result;
      } catch (e) {
        if (e.rpcError) throw e;
        last = e;
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    throw last;
  };
  const num = (h) => parseInt(h.number, 16);
  const client = {
    url,
    send: (method, params = []) => post(method, params),
    async subscribe(type, method, params, cb) {
      const sid = `poll-${++id}`;
      const stop = { stopped: false };
      subs.set(sid, stop);
      if (method === "author_submitAndWatchExtrinsic") {
        const [xt] = params;
        const want = extrinsicHash(xt);
        const start = num(await post("chain_getHeader", []));
        try {
          await post("author_submitExtrinsic", [xt]); // rejects like the WS subscribe would (e.g. 1010 invalid)
        } catch (e) {
          // 1013 after a retried POST: the first attempt reached the pool but its response was lost. Keep watching.
          if (!/^1013:/.test(String(e.message))) throw e;
        }
        (async () => {
          cb(null, "ready");
          let scanned = start - 1;
          let found;
          while (!stop.stopped && !found) {
            const best = num(await post("chain_getHeader", []).catch(() => ({ number: "0x0" })));
            for (let n = scanned + 1; n <= best && !found; n++) {
              const hash = await post("chain_getBlockHash", [n]).catch(() => null);
              if (!hash) break;
              const blk = await post("chain_getBlock", [hash]).catch(() => null);
              if (!blk) break;
              scanned = n;
              if (blk.block.extrinsics.some((x) => extrinsicHash(x) === want)) found = { n, hash };
            }
            if (!found) await new Promise((r) => setTimeout(r, pollMs));
          }
          if (stop.stopped) return;
          cb(null, { inBlock: found.hash });
          while (!stop.stopped) {
            const fh = await post("chain_getFinalizedHead", []).catch(() => null);
            const f = fh ? await post("chain_getHeader", [fh]).catch(() => null) : null;
            if (f && num(f) >= found.n) {
              const canon = await post("chain_getBlockHash", [found.n]).catch(() => null);
              if (canon && canon.toLowerCase() === found.hash.toLowerCase())
                cb(null, { finalized: found.hash });
              else cb(null, { retracted: found.hash });
              return;
            }
            await new Promise((r) => setTimeout(r, pollMs));
          }
        })().catch((e) => cb(e));
        return sid;
      }
      if (method === "chain_subscribeFinalizedHeads") {
        (async () => {
          let lastHash;
          while (!stop.stopped) {
            const fh = await post("chain_getFinalizedHead", []).catch(() => null);
            if (fh && fh !== lastHash) {
              lastHash = fh;
              const h = await post("chain_getHeader", [fh]).catch(() => null);
              if (h && !stop.stopped) cb(null, h);
            }
            await new Promise((r) => setTimeout(r, pollMs));
          }
        })();
        return sid;
      }
      throw new Error(`httpRpcClient: subscription ${method} is not supported`);
    },
    async unsubscribe(_type, _method, sid) {
      const s = subs.get(sid);
      if (s) s.stopped = true;
      subs.delete(sid);
      return true;
    },
  };
  return client;
}
