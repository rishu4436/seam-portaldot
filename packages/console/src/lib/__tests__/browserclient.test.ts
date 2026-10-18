import { describe, expect, it, vi } from "vitest";
import {
  createBrowserChainClient,
  httpTransport,
  wsTransport,
  RpcError,
  TransportError,
  type RpcTransport,
} from "../chainclient";
import { createExtensionSigner } from "../extensionsigner";
import { runLive } from "../live";

// Mock RPC and fake extension only. No real endpoint, no real keys.
const rpcMock =
  (h: Record<string, (p: unknown[]) => unknown>): RpcTransport =>
  async (m, p) => {
    if (!h[m]) throw new RpcError(-32601, "no method " + m);
    return h[m](p);
  };
const GEN = "0x" + "ab".repeat(32);

type Cb = ((e: unknown) => void) | null;
type WsCtor = Parameters<typeof wsTransport>[1];
const J = (v: unknown) => v as never;
describe("browser chain client against a mock RPC", () => {
  const good = rpcMock({
    chain_getBlockHash: () => GEN,
    state_getRuntimeVersion: () => ({ specName: "mock", specVersion: 9, transactionVersion: 2 }),
    author_submitExtrinsic: () => "0x" + "cd".repeat(32),
  });
  it("discovers genesis and runtime version without inventing a metadata hash", async () => {
    const r = await createBrowserChainClient(good).discover();
    expect(r).toEqual({
      ok: true,
      value: { genesisHash: GEN, specName: "mock", specVersion: 9, transactionVersion: 2 },
    });
  });
  it("rejects malformed discovery replies as rpc_error", async () => {
    const r = await createBrowserChainClient(
      rpcMock({ chain_getBlockHash: () => "nope", state_getRuntimeVersion: () => ({}) }),
    ).discover();
    expect(r.ok).toBe(false);
  });
  it("transport failure on discover is rpc_error", async () => {
    const r = await createBrowserChainClient(async () => {
      throw new TransportError("down");
    }).discover();
    expect(r).toMatchObject({ ok: false, reason: "rpc_error" });
  });
  it("submit returns submitted (never finalized) with the node's hash", async () => {
    const r = await createBrowserChainClient(good).submit({ signedTx: "0x1234" });
    expect(r).toMatchObject({ ok: true, value: { state: "submitted" } });
  });
  it("submit: node refusal is failed, transport loss is ambiguous, non-hex is blocked client-side", async () => {
    const c1 = createBrowserChainClient(async () => {
      throw new RpcError(1010, "Invalid Transaction");
    });
    expect(await c1.submit({ signedTx: "0x12" })).toMatchObject({ ok: false, reason: "failed" });
    const c2 = createBrowserChainClient(async () => {
      throw new TransportError("socket closed");
    });
    expect(await c2.submit({ signedTx: "0x12" })).toMatchObject({ ok: false, reason: "ambiguous" });
    const send = vi.fn();
    const c3 = createBrowserChainClient(send);
    expect(await c3.submit({ signedTx: "nothex" })).toMatchObject({ ok: false, reason: "failed" });
    expect(send).not.toHaveBeenCalled();
  });
  it("verify never claims chain verification; preflight is unavailable", async () => {
    const c = createBrowserChainClient(good);
    expect(await c.verify("0x1")).toMatchObject({ ok: true, value: { provenance: "unknown" } });
    expect(await c.preflight({})).toMatchObject({ ok: false, reason: "unavailable" });
  });
  it("http transport maps JSON-RPC errors, HTTP errors and network errors", async () => {
    const f = (body: unknown, ok = true, status = 200) =>
      (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
    expect(await httpTransport("http://x", f({ result: 5 }))("m", [])).toBe(5);
    await expect(
      httpTransport("http://x", f({ error: { code: 1, message: "bad" } }))("m", []),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(httpTransport("http://x", f({}, false, 500))("m", [])).rejects.toBeInstanceOf(
      TransportError,
    );
    await expect(
      httpTransport("http://x", (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch)("m", []),
    ).rejects.toBeInstanceOf(TransportError);
  });
  it("ws transport round-trips with a fake socket and fails on close", async () => {
    class Fake {
      onopen: Cb = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: Cb = null;
      onclose: Cb = null;
      constructor(_u: string) {
        setTimeout(() => this.onopen?.({}), 0);
      }
      send(d: string) {
        const m = JSON.parse(d);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, result: "ok" }) }), 0);
      }
      close() {}
    }
    expect(await wsTransport("ws://x", Fake as unknown as WsCtor)("m", [])).toBe("ok");
    class Closer extends Fake {
      send() {
        setTimeout(() => this.onclose?.({}), 0);
      }
    }
    await expect(
      wsTransport("ws://x", Closer as unknown as WsCtor)("m", []),
    ).rejects.toBeInstanceOf(TransportError);
  });
  it("LIVE with the real client and no URL contacts nothing; with a URL but no binding verifier it still never signs or sends", async () => {
    const send = vi.fn(good);
    const blocked = await runLive(undefined, {}, { chain: createBrowserChainClient(send) });
    expect(blocked.status).toBe("blocked");
    expect(send).not.toHaveBeenCalled();
    const signer = { sign: vi.fn() };
    const r = await runLive(
      "wss://v3.example.invalid",
      {},
      { chain: createBrowserChainClient(send), signer: J(signer) },
    );
    expect(r.status).toBe("blocked");
    expect(r.signing).toBe("binding_unchecked");
    expect(signer.sign).not.toHaveBeenCalled();
    expect(r.submitted).toBe(false);
  });
  it("full path with a fake signer and binding verifier ends unverified, not success", async () => {
    const signer = createExtensionSigner({
      getInjected: () => ({
        fake: {
          enable: async () => ({
            accounts: { get: async () => [{ address: "5A" }] },
            signer: { signPayload: async () => ({ signature: "0xdead" }) },
          }),
        },
      }),
      assemble: () => "0x1234",
    });
    const r = await runLive(
      "wss://v3.example.invalid",
      { address: "5A", payload: {} },
      {
        chain: createBrowserChainClient(good),
        signer,
        verifyBinding: () => ({ ok: true, reasons: [] }),
      },
    );
    expect(r.status).toBe("unverified");
    expect(r.txState).toBe("submitted");
    expect(r.provenance).toBe("unknown");
  });
});

describe("extension signer with a fake window.injectedWeb3", () => {
  const ext = (
    signPayload: () => Promise<{ signature: string }>,
    accounts = [{ address: "5A" }],
  ) => ({
    fake: {
      enable: async () => ({ accounts: { get: async () => accounts }, signer: { signPayload } }),
    },
  });
  const req = { address: "5A", payload: { x: 1 } };
  it("is unavailable with no extension, no assembler or no payload", async () => {
    expect(await createExtensionSigner({ getInjected: () => undefined }).sign(req)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(await createExtensionSigner({ getInjected: () => ({}) }).sign(req)).toMatchObject({
      reason: "unavailable",
    });
    expect(
      await createExtensionSigner({
        getInjected: () => ext(async () => ({ signature: "0xaa" })),
      }).sign(req),
    ).toMatchObject({ reason: "unavailable" });
    expect(
      await createExtensionSigner({
        getInjected: () => ext(async () => ({ signature: "0xaa" })),
        assemble: () => "0x1",
      }).sign({}),
    ).toMatchObject({ reason: "failed" });
  });
  it("maps cancel/reject errors to rejected and others to failed", async () => {
    const mk = (msg: string) =>
      createExtensionSigner({
        getInjected: () =>
          ext(async (): Promise<{ signature: string }> => {
            throw new Error(msg);
          }),
        assemble: () => "0x1",
      });
    expect(await mk("Cancelled").sign(req)).toMatchObject({ reason: "rejected" });
    expect(await mk("User rejected the request").sign(req)).toMatchObject({ reason: "rejected" });
    expect(await mk("boom").sign(req)).toMatchObject({ reason: "failed" });
  });
  it("signs via signPayload then assembles; wrong account or bad signature fails", async () => {
    const ok = await createExtensionSigner({
      getInjected: () => ext(async () => ({ signature: "0xbeef" })),
      assemble: (s) => "0xtx" + s.slice(2),
    }).sign(req);
    expect(ok).toEqual({ ok: true, value: { signedTx: "0xtxbeef" } });
    expect(
      await createExtensionSigner({
        getInjected: () => ext(async () => ({ signature: "0xbeef" }), []),
        assemble: () => "0x1",
      }).sign(req),
    ).toMatchObject({ reason: "failed" });
    expect(
      await createExtensionSigner({
        getInjected: () => ext(async () => ({ signature: "zz" })),
        assemble: () => "0x1",
      }).sign(req),
    ).toMatchObject({ reason: "failed" });
  });
  it("a wallet rejection yields LIVE status rejected with nothing submitted", async () => {
    const signer = createExtensionSigner({
      getInjected: () =>
        ext(async (): Promise<{ signature: string }> => {
          throw new Error("Rejected by user");
        }),
      assemble: () => "0x1",
    });
    const send = vi.fn(async () => "0x");
    const r = await runLive("wss://v3.example.invalid", req, {
      chain: createBrowserChainClient(
        rpcMock({
          chain_getBlockHash: () => GEN,
          state_getRuntimeVersion: () => ({ specVersion: 1 }),
          author_submitExtrinsic: send,
        }),
      ),
      signer,
      verifyBinding: () => ({ ok: true, reasons: [] }),
    });
    expect(r.status).toBe("rejected");
    expect(r.txState).toBe("rejected");
    expect(r.submitted).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
