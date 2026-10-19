/**
 * httpRpcClient against a local mock JSON-RPC HTTP server: dropped connections, 5xx, timeouts and node errors.
 * Idempotent reads are retried; author_submitExtrinsic is sent exactly once, even when its response is lost.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { blake2AsHex } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import { httpRpcClient, isIdempotentRead, withClient } from "../src/index.js";

type Handler = (
  body: { id: number; method: string; params: unknown[] },
  req: IncomingMessage,
  res: ServerResponse,
) => unknown;
const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function mock(handler: Handler) {
  const calls: string[] = [];
  const srv = createServer((req, res) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      const body = JSON.parse(data);
      calls.push(body.method);
      const out = handler(body, req, res);
      if (out === DROP) return req.socket.destroy();
      if (out === HANG) return;
      if (res.writableEnded) return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(out as object) }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  servers.push({ close: () => srv.close() });
  srv.unref();
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { url, calls };
}
const DROP = Symbol("drop");
const HANG = Symbol("hang");
const fast = { backoffMs: 1, maxBackoffMs: 2, pollMs: 5, requestTimeoutMs: 300 };

describe("httpRpcClient: retries only idempotent reads", () => {
  it("classifies methods: reads yes, submissions and unknown methods no", () => {
    for (const m of [
      "chain_getHeader",
      "state_getMetadata",
      "state_call",
      "system_dryRun",
      "payment_queryInfo",
    ])
      expect(isIdempotentRead(m)).toBe(true);
    for (const m of [
      "author_submitExtrinsic",
      "author_submitAndWatchExtrinsic",
      "author_insertKey",
      "foo_bar",
    ])
      expect(isIdempotentRead(m)).toBe(false);
  });

  it("a read survives dropped connections and 503s", async () => {
    let n = 0;
    const { url, calls } = await mock((_b, _q, res) => {
      n++;
      if (n === 1) return DROP;
      if (n === 2) {
        res.statusCode = 503;
        res.end("busy");
        return;
      }
      return { result: { number: "0x10" } };
    });
    const c = httpRpcClient(url, fast);
    await expect(c.send("chain_getHeader", [])).resolves.toEqual({ number: "0x10" });
    expect(calls).toEqual(["chain_getHeader", "chain_getHeader", "chain_getHeader"]);
  });

  it("a read times out per attempt and gives up after the attempt limit", async () => {
    const { url, calls } = await mock(() => HANG);
    const c = httpRpcClient(url, { ...fast, requestTimeoutMs: 50, readAttempts: 3 });
    await expect(c.send("state_getMetadata", [])).rejects.toThrow(
      /RPC_FAILED: state_getMetadata over HTTP failed after 3 attempts: no response within 50 ms/,
    );
    expect(calls).toHaveLength(3);
  });

  it("a JSON-RPC error answer and a 4xx are the node's verdict: not retried", async () => {
    const { url, calls } = await mock((b, _q, res) => {
      if (b.method === "chain_getBlock") {
        res.statusCode = 400;
        res.end("bad");
        return;
      }
      return { error: { code: -32602, message: "Invalid params" } };
    });
    const c = httpRpcClient(url, fast);
    await expect(c.send("chain_getHeader", ["x"])).rejects.toThrow(/-32602: Invalid params/);
    await expect(c.send("chain_getBlock", ["x"])).rejects.toThrow(/HTTP 400/);
    expect(calls).toEqual(["chain_getHeader", "chain_getBlock"]);
  });

  it("author_submitExtrinsic is sent once: a lost response is reported, never resent", async () => {
    const { url, calls } = await mock(() => DROP);
    const c = httpRpcClient(url, fast);
    await expect(c.send("author_submitExtrinsic", ["0x00"])).rejects.toThrow(
      /sent once and is not retried/,
    );
    expect(calls).toEqual(["author_submitExtrinsic"]);
  });

  it("withClient accepts an http(s) URL", async () => {
    const { url } = await mock(() => ({ result: "0xabc" }));
    await expect(withClient(url, (c) => c.send("chain_getBlockHash", [0]))).resolves.toBe("0xabc");
  });
});

describe("httpRpcClient: emulated author_submitAndWatchExtrinsic", () => {
  const XT = "0x280403000b63ce64c10c05";
  const XT_HASH = blake2AsHex(hexToU8a(XT), 256);
  /** A tiny chain: block 5 is best at submit; the extrinsic lands in block 7; block 7 is finalized after a few polls. */
  function chain(opts: { dropSubmit?: boolean; refuse?: boolean; neverIncluded?: boolean } = {}) {
    let best = 5;
    let finalized = 5;
    let polls = 0;
    const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
    return (b: { method: string; params: unknown[] }) => {
      switch (b.method) {
        case "author_submitExtrinsic":
          if (opts.refuse)
            return {
              error: {
                code: 1010,
                message: "Invalid Transaction",
                data: "Transaction has a bad signature",
              },
            };
          return opts.dropSubmit ? DROP : { result: XT_HASH };
        case "chain_getHeader": {
          polls++;
          if (polls > 2 && best < 8) best++;
          if (polls > 6) finalized = best;
          const p = b.params[0] as string | undefined;
          const n = p ? parseInt(p.slice(2), 16) : best;
          return { result: { number: "0x" + n.toString(16) } };
        }
        case "chain_getBlockHash":
          return { result: hash(b.params[0] as number) };
        case "chain_getBlock": {
          const n = parseInt((b.params[0] as string).slice(2), 16);
          return {
            result: {
              block: { extrinsics: n === 7 && !opts.neverIncluded ? ["0x00", XT] : ["0x00"] },
            },
          };
        }
        case "chain_getFinalizedHead":
          return { result: hash(finalized) };
      }
      return { error: { code: -32601, message: "method not found" } };
    };
  }
  const watch = (url: string, until: (u: unknown[]) => boolean, ms = 3000) =>
    new Promise<{ updates: unknown[]; err?: Error }>((resolve, reject) => {
      const c = httpRpcClient(url, fast);
      const updates: unknown[] = [];
      const t = setTimeout(() => {
        c.close();
        resolve({ updates });
      }, ms);
      c.subscribe("author_extrinsicUpdate", "author_submitAndWatchExtrinsic", [XT], (err, u) => {
        if (err) {
          clearTimeout(t);
          c.close();
          return resolve({ updates, err });
        }
        updates.push(u);
        if (until(updates)) {
          clearTimeout(t);
          c.close();
          resolve({ updates });
        }
      }).catch(reject);
    });

  it("submits once, then reports inBlock and finalized from polling", async () => {
    const { url, calls } = await mock(chain());
    const { updates } = await watch(url, (u) => JSON.stringify(u).includes("finalized"));
    expect(updates).toEqual([
      "ready",
      { inBlock: "0x" + "7".padStart(64, "0") },
      { finalized: "0x" + "7".padStart(64, "0") },
    ]);
    expect(calls.filter((m) => m === "author_submitExtrinsic")).toHaveLength(1);
  });

  it("a lost submit response is not resent; the watch still finds the transaction", async () => {
    const { url, calls } = await mock(chain({ dropSubmit: true }));
    const { updates } = await watch(url, (u) => JSON.stringify(u).includes("finalized"));
    expect(updates[0]).toEqual({ inBlock: "0x" + "7".padStart(64, "0") }); // no "ready": delivery was never confirmed
    expect(calls.filter((m) => m === "author_submitExtrinsic")).toHaveLength(1);
  });

  it("a lost submit response that never lands: nothing is reported and nothing is resent", async () => {
    const { url, calls } = await mock(chain({ dropSubmit: true, neverIncluded: true }));
    const { updates, err } = await watch(url, () => false, 400);
    expect(updates).toEqual([]);
    expect(err).toBeUndefined();
    expect(calls.filter((m) => m === "author_submitExtrinsic")).toHaveLength(1);
  });

  it("a node refusal rejects the subscription (definite, nothing is watched)", async () => {
    const { url, calls } = await mock(chain({ refuse: true }));
    const c = httpRpcClient(url, fast);
    await expect(
      c.subscribe(
        "author_extrinsicUpdate",
        "author_submitAndWatchExtrinsic",
        [XT],
        () => undefined,
      ),
    ).rejects.toThrow(/1010: Invalid Transaction/);
    expect(calls.filter((m) => m === "author_submitExtrinsic")).toHaveLength(1);
  });
});
