// connect(): an unreachable endpoint rejects on the provider's first error, not after the 15 s timeout.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { connect } from "../src/rpc.js";

describe("connect fast fail", () => {
  it("ws://127.0.0.1:1 (nothing listening) rejects within 3 s with the endpoint in the message", async () => {
    const t0 = Date.now();
    await expect(connect("ws://127.0.0.1:1")).rejects.toMatchObject({
      code: "CONNECT_FAILED",
      message: expect.stringContaining("ws://127.0.0.1:1"),
    });
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 20_000);

  it("a reachable endpoint still resolves (local mock JSON-RPC WebSocket server)", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) =>
      ws.on("message", (m) => {
        const req = JSON.parse(String(m));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0xabc" }));
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const p = await connect(`ws://127.0.0.1:${port}`);
      expect(p.isConnected).toBe(true);
      expect(await p.send("chain_getBlockHash", [0])).toBe("0xabc");
      await p.disconnect();
    } finally {
      wss.close();
      server.close();
    }
  });
});
