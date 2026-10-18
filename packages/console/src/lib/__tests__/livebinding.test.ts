import { describe, expect, it, vi } from "vitest";
import { runLive, type LiveDeps, type SignedBindingVerifier } from "../live";
import { createBrowserChainClient, findInFinalized, readSigningContext, RpcError, TransportError, type RpcTransport } from "../chainclient";
import { createExtensionSigner } from "../extensionsigner";
import { fingerprintMatches, planCall } from "../liverequest";
import { loadLiveHost, type LiveHost } from "../host";
import type { Plan, RuntimeFacts } from "../types";

// Everything here is a fake host, mock RPC and fake extension. Nothing was run against a real V3 chain.
const URL = "wss://v3.example.invalid";
const H = (c: string) => ("0x" + c.repeat(32)) as `0x${string}`;
const GEN = H("ab");
const plan = (o: Partial<Plan> = {}): Plan => ({ manifestDigest: H("01"), fingerprintDigest: H("02"), signer: "5Alice", mode: "atomic_verified", steps: [{ actionId: "a1", capability: "x", decoded: {}, status: "ok" }], outerCall: { encodedCall: "0x0a01" }, digest: H("03"), ...o });
const toHex = (t: string) => "0x" + Array.from(new TextEncoder().encode(t), (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new TextDecoder().decode(Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16)));
const facts = { fingerprint: { genesisHash: GEN, specVersion: 9, transactionVersion: 2 } } as unknown as RuntimeFacts;

// Fake host: the "extrinsic" is JSON { call, nonce, genesis, sig }. A stand-in for @seam/chain/browser.
const fakeHost = (): LiveHost => ({
  buildRequest: ({ callHex, context }) => ({ ok: true, value: { callHex, nonce: context.nonce, genesis: context.genesisHash, payload: { address: "5Alice", method: callHex } } }),
  verifyBinding: ((signed: string, req: unknown) => {
    const r = req as { callHex: string; nonce: number; genesis: string }; const reasons: string[] = [];
    let x: { call: string; nonce: number; genesis: string }; try { x = JSON.parse(fromHex(signed)); } catch { return { ok: false, reasons: ["not_decodable"] }; }
    if (x.call !== r.callHex) reasons.push("call_mismatch"); if (x.nonce !== r.nonce) reasons.push("nonce_mismatch"); if (x.genesis !== r.genesis) reasons.push("genesis_mismatch");
    return { ok: reasons.length === 0, reasons };
  }) as SignedBindingVerifier,
  assemble: (sig, req) => { const r = req as { callHex: string; nonce: number; genesis: string }; return toHex(JSON.stringify({ call: r.callHex, nonce: r.nonce, genesis: r.genesis, sig })); },
  extrinsicHash: (hex) => "0x" + hex.slice(2, 66).padEnd(64, "0"),
  feeEstimateExtrinsic: () => "0x1234",
});

const TX = "0x" + "12".repeat(32);
const rpcFor = (blocks: Record<string, { number: string; parent: string; exts: string[] }>, head: string, extra: Record<string, (p: unknown[]) => unknown> = {}): RpcTransport => async (m, p) => {
  const h: Record<string, (p: unknown[]) => unknown> = {
    chain_getBlockHash: () => GEN, state_getRuntimeVersion: () => ({ specName: "m", specVersion: 9, transactionVersion: 2 }),
    system_accountNextIndex: () => 7, chain_getFinalizedHead: () => head, chain_getHeader: () => ({ number: "0x64" }),
    chain_getBlock: ([x]) => { const b = blocks[x as string]; return b ? { block: { header: { number: b.number, parentHash: b.parent }, extrinsics: b.exts } } : null; },
    author_submitExtrinsic: () => TX, payment_queryInfo: () => ({ weight: 1, partialFee: "5" }), ...extra,
  };
  if (!h[m]) throw new RpcError(-32601, "no " + m);
  return h[m]!(p);
};
const B1 = H("b1"), B0 = H("b0");
const chainWith = (tx: string[]) => ({ [B1]: { number: "0x65", parent: B0, exts: tx }, [B0]: { number: "0x64", parent: H("b9"), exts: [] } });

describe("plan to request", () => {
  it("takes the real outer call and ids from an atomic plan", () => {
    expect(planCall(plan())).toMatchObject({ ok: true, value: { callHex: "0x0a01", signer: "5Alice", actionIds: ["a1"], planDigest: H("03") } });
  });
  it("blocks missing, unavailable and sequential plans, and a plan without an outer call", () => {
    for (const p of [undefined, plan({ mode: "unavailable" }), plan({ mode: "sequential" }), plan({ outerCall: undefined }), plan({ signer: "" })]) expect(planCall(p).ok).toBe(false);
  });
  it("blocks when the live chain is not the one the plan was compiled for", () => {
    expect(fingerprintMatches({ genesisHash: GEN, specVersion: 9, transactionVersion: 2 }, facts).ok).toBe(true);
    expect(fingerprintMatches({ genesisHash: H("cc"), specVersion: 9, transactionVersion: 2 }, facts).ok).toBe(false);
    expect(fingerprintMatches({ genesisHash: GEN, specVersion: 10, transactionVersion: 2 }, facts).ok).toBe(false);
    expect(fingerprintMatches({ genesisHash: GEN, specVersion: 9, transactionVersion: 2 }, undefined).ok).toBe(false);
  });
  it("no host is installed in this build", async () => { expect(await loadLiveHost()).toBeUndefined(); });
});

describe("end to end with fake host, mock RPC and fake extension", () => {
  const ext = (tamper = false) => createExtensionSigner({
    getInjected: () => ({ fake: { enable: async () => ({ accounts: { get: async () => [{ address: "5Alice" }] }, signer: { signPayload: async () => ({ signature: "0xdead" }) } }) } }),
    assemble: (sig, _p, req) => { const x = fakeHost().assemble(sig, tamper ? { ...(req as object), callHex: "0xffff" } : req); return x as string; },
  });
  const deps = (rpc: RpcTransport, tamper = false, host = fakeHost(), p: Plan | null = plan()): LiveDeps => ({
    chain: createBrowserChainClient(rpc, { extrinsicHash: host.extrinsicHash, feeExtrinsic: host.feeEstimateExtrinsic, sleep: async () => {}, polls: 2 }),
    signer: ext(tamper), verifyBinding: host.verifyBinding,
    prepare: async (fp) => {
      const call = planCall(p ?? undefined); if (!call.ok) return call; const m = fingerprintMatches(fp, facts); if (!m.ok) return m;
      const c = await readSigningContext(rpc, call.value.signer); if (!c.ok) return c;
      return host.buildRequest({ signer: call.value.signer, callHex: call.value.callHex, actionIds: call.value.actionIds, context: c.value });
    },
  });

  it("assembler output is stable for the same request", () => {
    const h = fakeHost(); const req = { callHex: "0x0a01", nonce: 7, genesis: GEN };
    expect(h.assemble("0xdead", req)).toBe(h.assemble("0xdead", req));
  });
  it("tampered call is rejected by the verifier and nothing is submitted", async () => {
    const submit = vi.fn(() => TX);
    const r = await runLive(URL, undefined, deps(rpcFor(chainWith([]), B1, { author_submitExtrinsic: submit }), true));
    expect(r.status).toBe("blocked"); expect(r.signing).toBe("binding_mismatch"); expect(r.message).toContain("call_mismatch"); expect(submit).not.toHaveBeenCalled(); expect(r.submitted).toBe(false);
  });
  it("preflight is a fee estimate only, never a signed dry run", async () => {
    const r = await runLive(URL, undefined, deps(rpcFor(chainWith([]), B1)));
    expect(r.simulation).toBe("fee_estimate_only");
  });
  it("found in a finalized block: finalized with block evidence, chain_verified, but effect not claimed", async () => {
    const ext1 = "0x" + "12".repeat(32) + "ff";
    const r = await runLive(URL, undefined, deps(rpcFor(chainWith([ext1]), B1)));
    expect(r.txState).toBe("finalized"); expect(r.provenance).toBe("chain_verified");
    expect(r.block).toEqual({ number: 101, hash: B1 }); expect(r.coverage).toBe("extrinsic_finalized");
    expect(r.coverage).not.toBe("effect_proven"); expect(r.coverage).not.toBe("contract_emitted"); expect(r.status).toBe("unverified");
  });
  it("not found: stays submitted, never finalized", async () => {
    const r = await runLive(URL, undefined, deps(rpcFor(chainWith(["0x" + "99".repeat(33)]), B1)));
    expect(r.txState).toBe("submitted"); expect(r.provenance).toBe("unknown"); expect(r.block).toBeUndefined();
  });
  it("transport loss while re-reading is uncertain", async () => {
    const rpc = rpcFor(chainWith([]), B1, { chain_getBlock: () => { throw new TransportError("down"); } });
    const r = await runLive(URL, undefined, deps(rpc));
    expect(r.status).toBe("uncertain"); expect(r.txState).toBe("uncertain"); expect(r.provenance).not.toBe("chain_verified");
  });
  it("blocks before signing when the plan is missing, unapproved flows aside", async () => {
    const sign = vi.fn();
    const d = deps(rpcFor(chainWith([]), B1), false, fakeHost(), null); d.signer = { sign };
    const r = await runLive(URL, undefined, d);
    expect(r.status).toBe("blocked"); expect(sign).not.toHaveBeenCalled();
  });
  it("blocks when the live chain differs from the plan's runtime", async () => {
    const rpc = rpcFor(chainWith([]), B1, { chain_getBlockHash: () => H("cc") });
    const r = await runLive(URL, undefined, deps(rpc));
    expect(r.status).toBe("failed"); expect(r.submitted).toBe(false);
  });
  it("without an installed host or hasher nothing is verified", async () => {
    const r = await findInFinalized(rpcFor(chainWith(["0x12"]), B1), TX, (x) => x, { sleep: async () => {}, polls: 1 });
    expect(r).toMatchObject({ ok: true, value: { provenance: "unknown" } });
    const v = await createBrowserChainClient(rpcFor({}, B1)).verify(TX);
    expect(v).toMatchObject({ ok: true, value: { provenance: "unknown" } });
    expect(await createBrowserChainClient(rpcFor({}, B1)).preflight({})).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
