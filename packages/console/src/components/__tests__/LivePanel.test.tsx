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
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: rpc(b.method, b.params) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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

const renderPanel = (approved = true) =>
  render(
    <LivePanel
      plan={plan}
      facts={facts}
      approval={approved ? approveWalletDemo(plan) : undefined}
      hostLoader={async () => fakeHost()}
      factsStep={factsOk}
    />,
  );
const press = () => fireEvent.click(screen.getByRole("button", { name: /check live|retry/i }));

beforeEach(() => {
  submitted = [];
  calls = [];
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
  });

  it("blocks a tampered signature before submit", async () => {
    mockExtension(BAD_SIG);
    renderPanel();
    press();
    await waitFor(() => expect(screen.getByText(/Signed bytes differ from the approved request/)).toBeTruthy());
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
});
