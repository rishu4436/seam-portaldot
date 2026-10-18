import { describe, expect, it, vi } from "vitest";
import { runLive, v3RpcUrl, type ChainClient, type WalletSigner, type SignedBindingVerifier } from "../live";

// Mock RPC and fake extension signer: used only here, never in the app bundle.
const URL = "wss://v3.example.invalid";
const fp = { specName: "mock", specVersion: 1 };
const chain = (o: Partial<ChainClient> = {}): ChainClient => ({
  discover: vi.fn(async () => ({ ok: true as const, value: fp })),
  preflight: vi.fn(async () => ({ ok: true as const, value: { simulation: "signed_dry_run" as const } })),
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
    expect(r.status).toBe("blocked"); expect(r.provenance).toBe("unknown"); expect(r.coverage).toBe("none");
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
    expect(r.status).toBe("verified"); expect(r.simulation).toBe("signed_dry_run");
  });
});

import { classifyReceipt, isWeakProof, COVERAGE_LABEL, PROVENANCE_LABEL } from "../modes";
describe("final names and honest labels", () => {
  it("coverage names match the SDK", () => { expect(Object.keys(COVERAGE_LABEL)).toEqual(["none", "call_dispatched", "extrinsic_finalized", "contract_emitted", "effect_proven"]); });
  it("contract_emitted is not called verified", () => { expect(COVERAGE_LABEL.contract_emitted).toMatch(/unknown/); expect(COVERAGE_LABEL.contract_emitted).not.toMatch(/^Effect proven/); });
  it("integrity_checked is labelled integrity only", () => { expect(PROVENANCE_LABEL.integrity_checked.text).toBe("Integrity only, not on-chain proof"); });
  it("classifyReceipt: uncertain > failed > result; verified only when result says so", () => {
    expect(classifyReceipt({ result: "verified", steps: [{ status: "finalized" }, { status: "uncertain" }] })).toBe("uncertain");
    expect(classifyReceipt({ result: "verified", steps: [{ status: "failed" }] })).toBe("tx_failed");
    expect(classifyReceipt({ overall: "partial", steps: [{ status: "finalized" }] })).toBe("partial");
    expect(classifyReceipt({ steps: [] })).toBe("not_verified");
    expect(classifyReceipt({ result: "verified", steps: [{ status: "finalized" }] })).toBe("verified");
  });
  it("weak proof from policy flag or signed_dry_run_not_checked", () => {
    expect(isWeakProof({})).toBe(false);
    expect(isWeakProof({ weakProof: ["rule:a1"] })).toBe(true);
    expect(isWeakProof({ gatePassedCodes: ["signed_dry_run_not_checked"] })).toBe(true);
  });
  it("verifyBinding gets only the signed bytes, never a wallet-reported call", async () => {
    const seen: unknown[] = [];
    const vb: SignedBindingVerifier = (tx, req) => { seen.push(tx, req); return { ok: true, reasons: [] }; };
    await runLive(URL, { r: 1 }, { chain: chain(), signer: signer({ sign: async () => ({ ok: true, value: { signedTx: "0xsigned", signedCall: "0xevil" } as any }) }), verifyBinding: vb });
    expect(seen).toEqual(["0xsigned", { r: 1 }]);
  });
  it("preflight simulation is separate from receipt coverage", async () => {
    const r = await runLive(URL, {}, { chain: chain(), signer: signer(), verifyBinding: bindOk });
    expect(r.simulation).toBe("signed_dry_run"); expect(r.coverage).toBe("none");
  });
});
