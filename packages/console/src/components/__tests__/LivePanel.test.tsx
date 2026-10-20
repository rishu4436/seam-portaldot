// @vitest-environment jsdom
// Rendered LIVE V3 flow with a mocked polkadot.js extension (window.injectedWeb3), mocked JSON-RPC (fetch) and a fake host
// standing in for @seam/chain/browser. Nothing here touches a real chain, wallet or keystore.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LivePanel } from "../Modes";
import type { LiveHost } from "../../lib/host";
import type { V3FactsResult } from "../../lib/v3facts";
import {
  approveWalletDemo,
  walletDemo,
  walletDemoFacts,
  walletDemoPlan,
} from "../../lib/walletdemo";

const plan = walletDemoPlan();
const facts = walletDemoFacts();
const fp = walletDemo.fingerprint;
const SIGNER = plan.signer;
const GOOD_SIG = "0x" + "ab".repeat(64);
const BAD_SIG = "0x" + "cd".repeat(64);
const HEAD = "0x" + "11".repeat(32);
const PARENT = "0x" + "22".repeat(32);

const toHex = (t: string) =>
  "0x" + Array.from(new TextEncoder().encode(t), (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) =>
  new TextDecoder().decode(Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16)));
const hashOf = (hex: string) => "0x" + hex.slice(-64).padStart(64, "0");

// Fake host: the "extrinsic" is hex(JSON { call, nonce, sig }); verifyBinding rejects any signature but GOOD_SIG.
const fakeHost = (): LiveHost => ({
  buildRequest: ({ callHex, context, signer }) => ({
    ok: true,
    value: { callHex, nonce: context.nonce, payload: { address: signer, method: callHex } },
  }),
  verifyBinding: (signed, req) => {
    const r = req as { callHex: string; nonce: number };
    const x = JSON.parse(fromHex(signed)) as { call: string; nonce: number; sig: string };
    const reasons: string[] = [];
    if (x.call !== r.callHex) reasons.push("call_mismatch");
    if (x.nonce !== r.nonce) reasons.push("nonce_mismatch");
    if (x.sig !== GOOD_SIG) reasons.push("bad_signature");
    return { ok: reasons.length === 0, reasons };
  },
  assemble: (sig, req) => {
    const r = req as { callHex: string; nonce: number };
    return toHex(JSON.stringify({ call: r.callHex, nonce: r.nonce, sig }));
  },
  extrinsicHash: hashOf,
  feeEstimateExtrinsic: (req) =>
    toHex(JSON.stringify({ fee: (req as { callHex: string }).callHex })),
});
const factsOk = async (): Promise<V3FactsResult> => ({
  ok: true,
  facts: {} as never,
  report: {
    provenance: "snapshot_fingerprint_live_metadata",
    snapshotFrom: "test",
    genesisHash: fp.genesisHash,
    specName: fp.specName,
    specVersion: fp.specVersion,
    transactionVersion: fp.transactionVersion,
    finalizedBlock: 200,
    metadataBytes: 10,
    liveMetadataHash: fp.metadataHash,
    snapshotMetadataHash: fp.metadataHash,
    metadataHashMatchesSnapshot: true,
  },
});

let submitted: string[] = [];
let feeReply: unknown = {
  weight: { ref_time: 1, proof_size: 2 },
  class: "normal",
  partialFee: "1480910852424",
};
let calls: string[] = [];
function mockRpc() {
  const rpc = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "chain_getBlockHash":
        return fp.genesisHash;
      case "state_getRuntimeVersion":
        return {
          specName: fp.specName,
          specVersion: fp.specVersion,
          transactionVersion: fp.transactionVersion,
        };
      case "system_accountNextIndex":
        return 7;
      case "chain_getFinalizedHead":
        return HEAD;
      case "chain_getHeader":
        return { number: "0xc8" };
      case "author_submitExtrinsic":
        submitted.push(params[0] as string);
        return hashOf(params[0] as string);
      case "payment_queryInfo":
        if (feeReply instanceof Error) throw feeReply;
        return feeReply;
      case "chain_getBlock":
        return params[0] === HEAD
          ? { block: { header: { number: "0xc9", parentHash: PARENT }, extrinsics: submitted } }
          : null;
      default:
        throw new Error("unexpected " + method);
    }
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      calls.push(b.method);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: b.id, result: rpc(b.method, b.params) }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }),
  );
}
function mockExtension(signature: string, accounts = [SIGNER]) {
  const signPayload = vi.fn(async () => ({ id: 1, signature }));
  (globalThis as { injectedWeb3?: unknown }).injectedWeb3 = {
    "polkadot-js": {
      enable: vi.fn(async () => ({
        accounts: { get: async () => accounts.map((address) => ({ address })) },
        signer: { signPayload },
      })),
    },
  };
  return signPayload;
}

// Test-only stand-in for the policy gate so the later steps can be exercised. The real gate is tested below and in policygate.test.ts.
const passGates = {
  preSign: async () => ({
    gate: { ok: true as const, explanations: [] },
    res: { ok: true as const, value: {} as never },
  }),
  preSubmit: vi.fn(async () => ({ ok: true as const, value: { passed: [] } })),
};
const fakeChain = async () =>
  ({
    preflight: vi.fn(async () => ({
      steps: [{ actionId: "pay", dryRun: "unknown" }],
      totalFee: "1",
    })),
    signedExtrinsicDecoder: () => () => null,
    blockTimeFromFacts: () => 6000,
    buildSigningEnvelope: (i: { signer: string; nonce: number; now: Date }) => ({
      ...i,
      mortalityBlocks: 64,
      checkpoint: { number: 1, hash: "0x" + "11".repeat(32) },
      expiresAt: new Date(i.now.getTime() + 63 * 6000).toISOString(),
    }),
  }) as never;
const noChain = async () => ({}) as never;

const renderPanel = (approved = true) =>
  render(
    <LivePanel
      plan={plan}
      facts={facts}
      approval={approved ? approveWalletDemo(plan) : undefined}
      hostLoader={async () => fakeHost()}
      factsStep={factsOk}
      gates={passGates}
      chainLoader={noChain}
    />,
  );
const press = () => fireEvent.click(screen.getByRole("button", { name: /check live|retry/i }));

beforeEach(() => {
  submitted = [];
  calls = [];
  feeReply = {
    weight: { ref_time: 1, proof_size: 2 },
    class: "normal",
    partialFee: "1480910852424",
  };
  mockRpc();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as { injectedWeb3?: unknown }).injectedWeb3;
});

describe("LivePanel, V3 wallet demo (rendered)", () => {
  it("shows the approval request before anything is contacted", () => {
    renderPanel();
    const box = screen.getByRole("group", { name: "Approval request" });
    expect(within(box).getByText("approved")).toBeTruthy();
    expect(within(box).getAllByText(plan.digest)).toHaveLength(2); // plan digest + the approval bound to it
    expect(within(box).getByText(plan.steps[0].encodedCall!)).toBeTruthy();
    expect(within(box).getByText(/Assets\.transfer_keep_alive 1 of asset 806707/)).toBeTruthy();
    expect(screen.getByText(/Nothing checked yet/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("connects the extension, passes the binding check and the gate, then shows finality and the receipt", async () => {
    const sign = mockExtension(GOOD_SIG);
    renderPanel();
    press();
    await waitFor(() => expect(screen.getByRole("group", { name: "Receipt" })).toBeTruthy());
    expect(sign).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveLength(1);
    const rc = screen.getByRole("group", { name: "Receipt" });
    expect(within(rc).getByText(hashOf(submitted[0]))).toBeTruthy();
    expect(within(rc).getByText("#201")).toBeTruthy();
    expect(within(rc).getByText("unverified")).toBeTruthy(); // effects not decoded: never "verified"
    expect(screen.getByRole("group", { name: "Transaction confirmation" })).toBeTruthy();
    expect(screen.getByText("Signed bytes match the approval")).toBeTruthy();
    expect(calls).toContain("author_submitExtrinsic");
    expect(screen.getByText("1480910852424 base units (payment_queryInfo)")).toBeTruthy();
    expect(calls.indexOf("payment_queryInfo")).toBeLessThan(
      calls.indexOf("author_submitExtrinsic"),
    );
  });

  it("fee estimate RPC error: blocked before the wallet is asked", async () => {
    feeReply = new Error("boom");
    const sign = mockExtension(GOOD_SIG);
    renderPanel();
    press();
    await waitFor(() =>
      expect(screen.getByText(/Fee estimate failed, so nothing will be signed/)).toBeTruthy(),
    );
    expect(sign).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(0);
  });

  it("fee estimate without partialFee: blocked", async () => {
    feeReply = { weight: 1, class: "normal" };
    const sign = mockExtension(GOOD_SIG);
    renderPanel();
    press();
    await waitFor(() => expect(screen.getByText(/Fee estimate failed/)).toBeTruthy());
    expect(sign).not.toHaveBeenCalled();
  });

  it("host without a fee encoder: blocked", async () => {
    const sign = mockExtension(GOOD_SIG);
    const h = fakeHost();
    delete h.feeEstimateExtrinsic;
    render(
      <LivePanel
        plan={plan}
        facts={facts}
        approval={approveWalletDemo(plan)}
        hostLoader={async () => h}
        factsStep={factsOk}
        gates={passGates}
        chainLoader={noChain}
      />,
    );
    press();
    await waitFor(() => expect(screen.getByText(/Fee estimate failed/)).toBeTruthy());
    expect(sign).not.toHaveBeenCalled();
  });

  it("blocks a tampered signature before submit", async () => {
    mockExtension(BAD_SIG);
    renderPanel();
    press();
    await waitFor(() =>
      expect(screen.getByText(/Signed bytes differ from the approved request/)).toBeTruthy(),
    );
    expect(screen.getByText(/bad_signature/)).toBeTruthy();
    expect(submitted).toHaveLength(0);
    expect(calls).not.toContain("author_submitExtrinsic");
    expect(screen.queryByRole("group", { name: "Receipt" })).toBeNull();
  });

  it("gate: an unapproved plan is blocked before the wallet is asked", async () => {
    const sign = mockExtension(GOOD_SIG);
    renderPanel(false);
    press();
    await waitFor(() => expect(screen.getByText("The plan is not approved yet.")).toBeTruthy());
    expect(sign).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(0);
  });

  it("gate: the approval is single use, so a second send is blocked", async () => {
    const sign = mockExtension(GOOD_SIG);
    renderPanel();
    press();
    await waitFor(() => expect(screen.getByRole("group", { name: "Receipt" })).toBeTruthy());
    press();
    await waitFor(() => expect(screen.getByText("This approval was already used.")).toBeTruthy());
    expect(sign).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveLength(1);
  });

  it("gate: the approved signer must be in the wallet", async () => {
    mockExtension(GOOD_SIG, ["5Someone"]);
    renderPanel();
    press();
    await waitFor(() =>
      expect(screen.getByText(/approved signer account is not available/)).toBeTruthy(),
    );
    expect(submitted).toHaveLength(0);
  });

  it("no extension installed: blocked, nothing sent", async () => {
    renderPanel();
    press();
    await waitFor(() => expect(screen.getByText(/No wallet extension found/)).toBeTruthy());
    expect(submitted).toHaveLength(0);
  });

  it("policy gate: no policy means blocked before the wallet is asked", async () => {
    const sign = mockExtension(GOOD_SIG);
    render(
      <LivePanel
        plan={plan}
        facts={facts}
        approval={approveWalletDemo(plan)}
        hostLoader={async () => fakeHost()}
        factsStep={factsOk}
      />,
    );
    press();
    await waitFor(() =>
      expect(screen.getByTestId("policy-codes").textContent).toBe("POLICY_MISSING"),
    );
    expect(sign).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(0);
  });

  it("policy gate: a violation is shown per rule and never reaches the signer", async () => {
    const sign = mockExtension(GOOD_SIG);
    const gate = vi.fn(() => ({
      ok: false as const,
      codes: ["PREFLIGHT_UNKNOWN"],
      message: "blocked",
      explanations: [
        {
          rule: "capability",
          status: "pass" as const,
          code: "OK",
          message: "Capability allowed: Pass.",
        },
        {
          rule: "preflight",
          status: "unknown" as const,
          code: "PREFLIGHT_UNKNOWN",
          message: "Preflight ran: Unknown, so blocked.",
        },
      ],
    }));
    render(
      <LivePanel
        plan={plan}
        facts={facts}
        approval={approveWalletDemo(plan)}
        hostLoader={async () => fakeHost()}
        factsStep={factsOk}
        policyInput={{ policy: {}, plan: walletDemo.plan, manifest: walletDemo.manifest }}
        policyGate={gate}
        chainLoader={fakeChain}
      />,
    );
    press();
    const box = await screen.findByRole("group", { name: "Policy gate" });
    expect(within(box).getByText("blocked")).toBeTruthy();
    expect(within(box).getByText(/Preflight ran: Unknown, so blocked/)).toBeTruthy();
    expect(within(box).getByText(/Capability allowed: Pass/)).toBeTruthy();
    expect(gate).toHaveBeenCalledTimes(1);
    expect((gate.mock.calls[0] as unknown[])[0]).toMatchObject({ preflight: { totalFee: "1" } });
    expect(sign).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(0);
  });

  it("submit gate: a blocked signed transaction is never sent", async () => {
    const sign = mockExtension(GOOD_SIG);
    const gates = {
      preSign: passGates.preSign,
      preSubmit: vi.fn(async () => ({
        ok: false as const,
        reason: "unavailable" as const,
        message: "Blocked at submit (signed_dry_run_missing). Nothing was sent.",
      })),
    };
    render(
      <LivePanel
        plan={plan}
        facts={facts}
        approval={approveWalletDemo(plan)}
        hostLoader={async () => fakeHost()}
        factsStep={factsOk}
        gates={gates}
        chainLoader={noChain}
      />,
    );
    press();
    await waitFor(() => expect(screen.getByText(/signed_dry_run_missing/)).toBeTruthy());
    expect(sign).toHaveBeenCalledTimes(1);
    expect(gates.preSubmit).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveLength(0);
    expect(calls).not.toContain("author_submitExtrinsic");
  });
});
