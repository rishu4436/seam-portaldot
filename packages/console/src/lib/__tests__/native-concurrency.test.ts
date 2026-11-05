import { afterEach, expect, it, vi } from "vitest";
import type { NativeSwapPlan } from "@seam/chain/browser";
const mock = vi.hoisted(() => ({ recheck: vi.fn(async () => ({ facts: {} })) }));
vi.mock("@seam/chain/browser", () => ({
  parseNativeSwapPlan: (value: unknown) => value,
  recheckNativeSwap: mock.recheck,
  nativeSwapSigningRequest: () => ({ payload: {} }),
  assembleSignedExtrinsic: () => "0x1234",
  verifySignedAgainstRequest: () => ({ ok: true }),
  clientFromSend: (send: unknown) => send,
  dryRunOne: async () => ({ outcome: "ok" }),
}));
import { submitNativeSwap } from "../native-swap-execution";
import { NativeSwapStore } from "../native-swap-store";
import { blake2AsHex } from "@polkadot/util-crypto";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const plan = () =>
  ({
    id: `0x${"ab".repeat(32)}`,
    signer: "account",
    expiresAt: Date.now() + 60000,
  }) as unknown as NativeSwapPlan;
function stores() {
  const data = new Map<string, string>();
  const kv = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
  return [new NativeSwapStore(kv), new NativeSwapStore(kv)];
}
function locks() {
  let held = false;
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        work: (lock: unknown) => Promise<unknown>,
      ) => {
        if (held) return work(null);
        held = true;
        try {
          return await work({ name: "wallet" });
        } finally {
          held = false;
        }
      },
    },
  });
}
it("two simultaneous tabs request one signature and broadcast once", async () => {
  locks();
  const [first, second] = stores();
  let resolve!: (v: { signature: string }) => void;
  const sign = vi.fn(
    () =>
      new Promise<{ signature: string }>((r) => {
        resolve = r;
      }),
  );
  const send = vi.fn(async () => blake2AsHex("0x1234", 256));
  const p = plan();
  const a = { send, plan: p, store: first!, sign, assertAccount: async () => {} };
  const active = submitNativeSwap(a);
  await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
  await expect(submitNativeSwap({ ...a, store: second! })).rejects.toThrow("another tab");
  expect(second!.list()[0]!.state).toBe("signing");
  resolve({ signature: "test" });
  await active;
  expect(send).toHaveBeenCalledTimes(1);
  expect(first!.list()[0]!.hash).toBe(blake2AsHex("0x1234", 256));
  await expect(submitNativeSwap(a)).rejects.toThrow("already submitted");
  expect(sign).toHaveBeenCalledTimes(1);
});
it("wallet rejection does not broadcast and permits a fresh quote", async () => {
  locks();
  const [store] = stores(),
    send = vi.fn();
  await expect(
    submitNativeSwap({
      send,
      plan: plan(),
      store: store!,
      sign: async () => {
        throw Error("Rejected by wallet");
      },
      assertAccount: async () => {},
    }),
  ).rejects.toThrow("Rejected by wallet");
  expect(send).not.toHaveBeenCalled();
  expect(store!.list()[0]!.state).toBe("not_sent");
});
