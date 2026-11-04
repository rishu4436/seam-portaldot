import { describe, expect, it, vi } from "vitest";
import {
  createJsonRpcTransport,
  createReadFailover,
  V3_RPC_IDENTITY,
} from "../src/resilient-rpc.js";

const version = { specName: "portaldot-v3", specVersion: 3002, transactionVersion: 2 };
const node = (
  read = vi.fn(async () => "answer"),
  identity = V3_RPC_IDENTITY.genesisHash,
  runtime = version,
) =>
  vi.fn(async (method: string) =>
    method === "chain_getBlockHash"
      ? identity
      : method === "state_getRuntimeVersion"
        ? runtime
        : read(),
  );
describe("trusted read failover", () => {
  it("switches after a transient failure and remembers the usable endpoint", async () => {
    const first = node(
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );
    const second = node();
    const changed = vi.fn();
    const send = createReadFailover({
      endpoints: ["first", "second"],
      transport: (url) => (url === "first" ? first : second),
      onFailover: changed,
    });
    expect(await send("state_getStorage", ["key"])).toBe("answer");
    first.mockClear();
    expect(await send("chain_getHeader", [])).toBe("answer");
    expect(first).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledWith("second");
  });
  it("quarantines a wrong-chain endpoint before sending the requested read", async () => {
    const badRead = vi.fn(),
      bad = node(badRead, "0xwrong"),
      good = node();
    const send = createReadFailover({
      endpoints: ["bad", "good"],
      transport: (url) => (url === "bad" ? bad : good),
    });
    expect(await send("state_getStorage", [])).toBe("answer");
    expect(badRead).not.toHaveBeenCalled();
  });
  it("refuses fallback runtime drift and all transaction submission without contacting a node", async () => {
    const first = node(),
      next = node(undefined, undefined, { ...version, specVersion: 3003 });
    const send = createReadFailover({
      endpoints: ["first", "next"],
      transport: (url) => (url === "first" ? first : next),
    });
    await send("chain_getHeader", []);
    first.mockRejectedValue(new Error("offline"));
    await expect(send("chain_getHeader", [])).rejects.toThrow(/runtime mismatch/);
    first.mockClear();
    next.mockClear();
    await expect(send("author_submitExtrinsic", ["0xdead"])).rejects.toThrow(/never retried/);
    expect(first).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
  it("bounds retries and honors an expired operation deadline", async () => {
    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    const send = createReadFailover({ endpoints: ["one"], transport: () => offline });
    await expect(send("chain_getHeader", [])).rejects.toThrow(/unavailable/);
    expect(offline.mock.calls.length).toBe(4); // two concurrent identity reads, at most two rounds
    const expired = createReadFailover({
      endpoints: ["one"],
      transport: () => offline,
      deadline: 1,
    });
    offline.mockClear();
    await expect(expired("chain_getHeader", [])).rejects.toThrow(/budget/);
    expect(offline).not.toHaveBeenCalled();
  });
  it("validates response IDs and stops oversized HTTP streams", async () => {
    const bad = createJsonRpcTransport("https://rpc.example", {
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: true })),
      ),
    });
    await expect(bad("chain_getHeader", [])).rejects.toThrow(/mismatched/);
    const huge = createJsonRpcTransport("https://rpc.example", {
      maximumBytes: 8,
      fetch: vi.fn(async () => new Response("123456789")),
    });
    await expect(huge("chain_getHeader", [])).rejects.toThrow(/too large/);
  });
});
