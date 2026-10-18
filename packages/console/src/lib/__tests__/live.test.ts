import { describe, expect, it, vi } from "vitest";
import { runLive, v3RpcUrl, type ChainClient, type WalletSigner, type SignedBindingVerifier } from "../live";

// Mock RPC and fake extension signer: used only here, never in the app bundle.
const URL = "wss://v3.example.invalid";
const fp = { specName: "mock", specVersion: 1 };
const chain = (o: Partial<ChainClient> = {}): ChainClient => ({
  discover: vi.fn(async () => ({ ok: true as const, value: fp })),
  preflight: vi.fn(async () => ({ ok: true as const, value: { coverage: "signed_tx" as const } })),
  submit: vi.fn(async () => ({ ok: true as const, value: { txHash: "0xmock", state: "finalized" as const } })),
  verify: vi.fn(async () => ({ ok: true as const, value: { provenance: "chain_verified" as const } })),
  ...o,
});
const signer = (o: Partial<WalletSigner> = {}): WalletSigner => ({ sign: vi.fn(async () => ({ ok: true as const, value: { signedTx: "0xsigned" } })), ...o });
const bindOk: SignedBindingVerifier = () => ({ ok: true, reasons: [] });

describe("LIVE V3 mode", () => {
  it("is blocked with no RPC URL and contacts nothing", async () => {
    const c = chain();
    const r = await runLive(undefined, {}, { chain: c, signer: signer(), verifyBinding: bindOk });
    expect(r.status).toBe("blocked"); expect(r.provenance).toBe("unknown"); expect(r.coverage).toBe("unknown");
    expect(c.discover).not.toHaveBeenCalled();
  });
  it("rejects malformed URLs", () => { expect(v3RpcUrl("not a url")).toBeUndefined(); expect(v3RpcUrl(URL)).toBe(URL); });
  it("is blocked/unknown with a URL but no client wired", async () => {
    const r = await runLive(URL, {});
    expect(r.status).toBe("blocked"); expect(r.status).not.toBe("verified"); expect(r.submitted).toBe(false);
  });
  it("retries RPC then reports unknown, never success", async () => {
    const c = chain({ discover: vi.fn(async () => ({ ok: false as const, reason: "rpc_error" as const, message: "down" })) });
    const r = await runLive(URL, {}, { chain: c, verifyBinding: bindOk });
    expect(r.status).toBe("unknown"); expect(c.discover).toHaveBeenCalledTimes(3); expect(r.rpcAttempts).toBe(3); expect(r.submitted).toBe(false);
  });
  it("wallet rejection sends nothing and is not success", async () => {
    const c = chain();
    const r = await runLive(URL, {}, { chain: c, signer: signer({ sign: async () => ({ ok: false, reason: "rejected", message: "no" }) }), verifyBinding: bindOk });
    expect(r.status).toBe("rejected"); expect(r.txState).toBe("rejected"); expect(c.submit).not.toHaveBeenCalled();
  });
  it("blocks when no signed-bytes verifier is wired, even with a signer", async () => {
    const c = chain(); const s = signer();
    const r = await runLive(URL, {}, { chain: c, signer: s });
    expect(r.status).toBe("blocked"); expect(s.sign).not.toHaveBeenCalled(); expect(c.submit).not.toHaveBeenCalled();
  });
  it("blocks and sends nothing when signed bytes do not match", async () => {
    const c = chain();
    const r = await runLive(URL, {}, { chain: c, signer: signer(), verifyBinding: () => ({ ok: false, reasons: ["call"] }) });
    expect(r.status).toBe("blocked"); expect(r.signing).toBe("binding_mismatch"); expect(c.submit).not.toHaveBeenCalled();
  });
  it("on-chain failure is failed", async () => {
    const c = chain({ submit: async () => ({ ok: true, value: { txHash: "0xmock", state: "failed" } }) });
    const r = await runLive(URL, {}, { chain: c, signer: signer(), verifyBinding: bindOk });
    expect(r.status).toBe("failed"); expect(r.provenance).toBe("failed");
  });
  it("ambiguous submit is uncertain, distinct from failed", async () => {
    const c = chain({ submit: async () => ({ ok: false, reason: "ambiguous", message: "timeout after send" }) });
    const r = await runLive(URL, {}, { chain: c, signer: signer(), verifyBinding: bindOk });
    expect(r.status).toBe("uncertain"); expect(r.txState).toBe("uncertain");
  });
  it("finalized but only integrity-checked is not success", async () => {
    const c = chain({ verify: async () => ({ ok: true, value: { provenance: "integrity_checked" } }) });
    const r = await runLive(URL, {}, { chain: c, signer: signer(), verifyBinding: bindOk });
    expect(r.status).toBe("unverified");
  });
  it("included-only is not success", async () => {
    const c = chain({ submit: async () => ({ ok: true, value: { txHash: "0xmock", state: "included" } }) });
    expect((await runLive(URL, {}, { chain: c, signer: signer(), verifyBinding: bindOk })).status).toBe("unverified");
  });
  it("verified only when finalized, binding ok and chain_verified", async () => {
    const r = await runLive(URL, {}, { chain: chain(), signer: signer(), verifyBinding: bindOk });
    expect(r.status).toBe("verified"); expect(r.coverage).toBe("signed_tx");
  });
});
