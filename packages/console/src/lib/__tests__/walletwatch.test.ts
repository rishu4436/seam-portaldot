// @vitest-environment node
// Wallet watch (Chainsmith's real watchSigner): states in plain words, Sign only when ready, assertReadyToSign before
// each signPayload and before each submit; not ready -> stop, nothing broadcast. Nothing is signed here.
import { describe, expect, it, vi } from "vitest";
import { SignerNotReadyError } from "@seam/chain/browser";
import {
  SIGNER_STATUS_TEXT,
  canSign,
  openSignerWatch,
  readyOrStop,
  signerStateText,
  type SignerState,
} from "../walletwatch";
import { runPlanSteps } from "../multistep";
import { newApprovalStore } from "../signflow";

// //Alice dev key address (test only); genesis is a placeholder 32-byte hash.
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const GEN = "0x" + "aa".repeat(32);

function ext(accounts: string[]) {
  let list = accounts.map((address) => ({ address }));
  let cb: ((a: { address: string }[]) => void) | undefined;
  const e = {
    accounts: {
      get: vi.fn(async () => list),
      subscribe: (f: (a: { address: string }[]) => void) => {
        cb = f;
        f(list);
        return () => (cb = undefined);
      },
    },
  };
  return {
    injected: { "polkadot-js": { enable: vi.fn(async () => e) } },
    set(a: string[]) {
      list = a.map((address) => ({ address }));
      cb?.(list);
    },
  };
}
const rpc = (g = GEN) => vi.fn(async (m: string) => (m === "chain_getBlockHash" ? g : null));

describe("wallet watch", () => {
  it("every status has plain words; Sign only when ready", () => {
    for (const s of Object.keys(SIGNER_STATUS_TEXT))
      expect(SIGNER_STATUS_TEXT[s as never]).toBeTruthy();
    expect(canSign({ status: "ready" } as SignerState)).toBe(true);
    for (const s of [
      "unknown",
      "extension_disconnected",
      "account_missing",
      "account_switched",
      "wrong_network",
    ])
      expect(canSign({ status: s } as SignerState)).toBe(false);
    expect(canSign(undefined)).toBe(false);
    expect(signerStateText(undefined)).toBe(SIGNER_STATUS_TEXT.unknown);
    expect(
      signerStateText({ status: "wrong_network", reason: "genesis 0x12" } as SignerState),
    ).toBe(`${SIGNER_STATUS_TEXT.wrong_network} (genesis 0x12)`);
  });

  it("real watchSigner: ready with the expected account on the right chain", async () => {
    const x = ext([ALICE]);
    const onChange = vi.fn();
    const w = await openSignerWatch({
      expectedAddress: ALICE,
      expectedGenesisHash: GEN,
      rpc: rpc(),
      onChange,
      getInjected: () => x.injected,
    });
    expect((await readyOrStop(w, "sign")).ok).toBe(true);
    w.stop();
  });

  it("account missing, wrong network and no extension all stop before signing", async () => {
    const missing = await openSignerWatch({
      expectedAddress: ALICE,
      expectedGenesisHash: GEN,
      rpc: rpc(),
      getInjected: () => ext([BOB]).injected,
    });
    const r1 = await readyOrStop(missing, "sign");
    expect(!r1.ok && r1.code).toBe("account_missing");
    expect(!r1.ok && r1.message).toContain(SIGNER_STATUS_TEXT.account_missing);
    expect(!r1.ok && r1.message).toMatch(/Nothing was signed/);
    missing.stop();
    const wrong = await openSignerWatch({
      expectedAddress: ALICE,
      expectedGenesisHash: GEN,
      rpc: rpc("0x" + "bb".repeat(32)),
      getInjected: () => ext([ALICE]).injected,
    });
    const r2 = await readyOrStop(wrong, "submit");
    expect(!r2.ok && r2.code).toBe("wrong_network");
    expect(!r2.ok && r2.message).toMatch(/Nothing was sent/);
    wrong.stop();
    const none = await openSignerWatch({
      expectedAddress: ALICE,
      expectedGenesisHash: GEN,
      rpc: rpc(),
      getInjected: () => undefined,
    });
    const r3 = await readyOrStop(none, "sign");
    expect(!r3.ok && r3.code).toBe("extension_disconnected");
    none.stop();
  });
});

describe("multi-step run with the wallet watch", () => {
  const plan = {
    mode: "sequential",
    steps: [
      { actionId: "a", encodedCall: "0x01" },
      { actionId: "b", encodedCall: "0x02" },
    ],
  };
  const setup = (watch: { assertReadyToSign: () => Promise<unknown> }) => {
    const sign = vi.fn(async (i: number) => ({
      ok: true as const,
      value: "0x" + `5${i}`.repeat(40),
    }));
    const submitAndWait = vi.fn(async (i: number) => ({
      ok: true as const,
      value: {
        actionId: ["a", "b"][i],
        status: "finalized" as const,
        txHash: "0xaa",
        block: { number: 1, hash: "0xbb" },
        events: [],
        verification: "verified" as const,
        reason: "ok",
      },
    }));
    const gates = {
      preSign: vi.fn(async () => ({
        gate: { ok: true as const, explanations: [] },
        res: {
          ok: true as const,
          value: {
            approval: { hash: "0x" + "ab".repeat(32) },
            approvalInput: { envelope: { expiresAt: new Date(Date.now() + 60_000).toISOString() } },
          } as never,
        },
      })),
      policyGate: vi.fn(() => ({ ok: true as const, explanations: [] })),
      preSubmit: vi.fn(async () => ({ ok: true as const, value: { passed: [] } })),
    };
    const run = () =>
      runPlanSteps({
        watch: watch as never,
        chain: { preflight: vi.fn(async () => ({ steps: [] })) } as never,
        send: async () => null,
        input: { policy: {}, plan },
        facts: {},
        signer: ALICE,
        ctx: { nonce: 0, mortalityBlocks: 64, checkpointNumber: 1, checkpointHash: "0x" },
        now: () => new Date(),
        store: newApprovalStore(),
        freshFingerprint: async () => ({ fingerprint: {} }),
        sign,
        submitAndWait: submitAndWait as never,
        verifyOutcome: (_i, o) => o as never,
        gates: gates as never,
      });
    return { run, sign, submitAndWait };
  };
  const notReady = (status: string) =>
    new SignerNotReadyError({ status, reason: "test", expectedPublicKey: "0x00", seq: 1 } as never);

  it("not ready before the first signPayload: nothing signed, nothing broadcast", async () => {
    const t = setup({
      assertReadyToSign: async () => Promise.reject(notReady("account_switched")),
    });
    const r = await t.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain(SIGNER_STATUS_TEXT.account_switched);
    expect(t.sign).not.toHaveBeenCalled();
    expect(t.submitAndWait).not.toHaveBeenCalled();
  });

  it("the account switches after signing: stopped before submit, nothing broadcast", async () => {
    let n = 0;
    // two sign checks pass, the first submit check fails
    const t = setup({
      assertReadyToSign: async () => (++n <= 2 ? {} : Promise.reject(notReady("account_switched"))),
    });
    const r = await t.run();
    expect(t.sign).toHaveBeenCalledTimes(2);
    expect(t.submitAndWait).not.toHaveBeenCalled();
    expect(r.message).toMatch(/SIGNER_NOT_READY before submit/);
  });

  it("ready throughout: checked before each sign and each submit", async () => {
    const assertReadyToSign = vi.fn(async () => ({}));
    const t = setup({ assertReadyToSign });
    await t.run();
    expect(assertReadyToSign.mock.calls.length).toBe(4);
  });
});
