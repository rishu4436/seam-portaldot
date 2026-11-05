import { beforeAll, expect, it, vi } from "vitest";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { nativeSwapSigningRequest, quoteNativeSwap } from "@seam/chain/browser";
import { nativeSwapNode } from "./nativeSwapNode.js";
import { submitNativeSwap } from "../../console/src/lib/native-swap-execution";
import { NATIVE_SWAP_STORE, NativeSwapStore } from "../../console/src/lib/native-swap-store";
const alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const input = {
  signer: alice,
  assetId: 8801000,
  reverse: false,
  amountIn: "1000000000000",
  slippageBps: 50,
  feeLimit: "5000000000000",
};
beforeAll(async () => {
  await cryptoWaitReady();
});
async function setup(options: Parameters<typeof nativeSwapNode>[0] = {}) {
  const fake = nativeSwapNode(options),
    { ctx, plan } = await quoteNativeSwap(fake.send, input),
    req = nativeSwapSigningRequest(ctx, plan),
    key = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
  const memory = new Map<string, string>(),
    kv = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memory.set(k, v);
      },
    },
    store = new NativeSwapStore(kv);
  const sign = vi.fn(async () => ({
      signature: u8aToHex(key.sign(req.signBytesHex, { withType: true })),
    })),
    assertAccount = vi.fn(async () => {}),
    exclusive = async <T>(_n: string, fn: () => Promise<T>) => fn();
  return { ...fake, ctx, plan, store, kv, memory, sign, assertAccount, exclusive };
}
it("persists the exact hash before broadcasting once and never stores a signature or signed extrinsic", async () => {
  const s = await setup(),
    broadcast = vi.fn(async (_m: string, p: unknown[]) => {
      expect(s.store.list()[0].state).toBe("submitted");
      expect(s.store.list()[0].hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(s.memory.get(NATIVE_SWAP_STORE)).not.toContain(String(p[0]));
      return s.store.list()[0].hash;
    });
  const send = async (m: string, p: unknown[]) =>
    m === "author_submitExtrinsic" ? broadcast(m, p) : s.send(m, p);
  const row = await submitNativeSwap({ ...s, send });
  expect(row.state).toBe("submitted");
  expect(broadcast).toHaveBeenCalledTimes(1);
  expect(s.sign).toHaveBeenCalledTimes(1);
  expect(s.assertAccount).toHaveBeenCalledTimes(2);
  await expect(submitNativeSwap({ ...s, send })).rejects.toThrow(/Recover/);
  expect(broadcast).toHaveBeenCalledTimes(1);
});
it("keeps a recoverable hash after a lost response and refuses a second request", async () => {
  const s = await setup(),
    broadcast = vi.fn(async () => {
      throw Error("lost response");
    }),
    send = async (m: string, p: unknown[]) =>
      m === "author_submitExtrinsic" ? broadcast() : s.send(m, p);
  await expect(submitNativeSwap({ ...s, send })).rejects.toThrow(/lost response/);
  expect(s.store.list()[0]).toMatchObject({
    state: "uncertain",
    hash: expect.stringMatching(/^0x/),
  });
  await expect(submitNativeSwap({ ...s, send })).rejects.toThrow(/Recover/);
  expect(broadcast).toHaveBeenCalledTimes(1);
});
it("wallet rejection is not sent, has no hash and permits a new quote", async () => {
  const s = await setup();
  s.sign.mockRejectedValueOnce(Error("Rejected by wallet"));
  await expect(submitNativeSwap(s)).rejects.toThrow(/Rejected/);
  expect(s.store.list()[0]).toMatchObject({ state: "not_sent" });
  expect(s.store.list()[0].hash).toBeUndefined();
  expect(() => s.store.assertReady()).not.toThrow();
  expect(s.log.some((e) => e.method.startsWith("author_"))).toBe(false);
});
it("invalid signatures and failed signed dry runs never reach broadcast", async () => {
  const invalid = await setup();
  invalid.sign.mockResolvedValueOnce({ signature: `0x00${"ab".repeat(64)}` });
  await expect(submitNativeSwap(invalid)).rejects.toThrow(/signature/);
  expect(invalid.log.some((e) => e.method.startsWith("author_"))).toBe(false);
  const dry = await setup({ badDryRun: true });
  await expect(submitNativeSwap(dry)).rejects.toThrow(/dry run/);
  expect(dry.store.list()[0].state).toBe("not_sent");
  expect(dry.log.some((e) => e.method.startsWith("author_"))).toBe(false);
});
it("losing the approved wallet account after signing prevents submission", async () => {
  const s = await setup();
  s.assertAccount.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error("account removed"));
  await expect(submitNativeSwap(s)).rejects.toThrow(/account removed/);
  expect(s.store.list()[0].state).toBe("not_sent");
  expect(s.log.some((e) => e.method.startsWith("author_"))).toBe(false);
});
it("unavailable journal storage blocks signing", async () => {
  const s = await setup();
  s.kv.setItem = () => {
    throw Error("storage denied");
  };
  await expect(submitNativeSwap(s)).rejects.toThrow(/storage denied/);
  expect(s.sign).not.toHaveBeenCalled();
});
it("archives deduplicate, discard imported verification claims and restore atomically", async () => {
  const s = await setup();
  s.store.save({
    plan: s.plan,
    state: "verified",
    hash: `0x${"ab".repeat(32)}`,
    verification: { status: "verified", message: "claim" },
  });
  const archive = s.store.export(),
    target = new NativeSwapStore({ getItem: s.kv.getItem, setItem: s.kv.setItem });
  s.memory.clear();
  expect(target.restore(archive)).toBe(1);
  expect(target.list()[0]).toMatchObject({ state: "submitted" });
  expect(target.list()[0].verification).toBeUndefined();
  expect(target.restore(archive)).toBe(1);
  expect(target.list()).toHaveLength(1);
  const saved = s.memory.get(NATIVE_SWAP_STORE);
  expect(() => target.restore({ ...archive, rows: [archive.rows[0], { plan: {} }] })).toThrow();
  expect(s.memory.get(NATIVE_SWAP_STORE)).toBe(saved);
});
it("reload abandons only unsigned requests and retains uncertain broadcasts", async () => {
  const s = await setup();
  s.store.save({ plan: s.plan, state: "signing" });
  s.store.abandonUnsigned();
  expect(s.store.list()[0].state).toBe("not_sent");
  s.store.save({ plan: s.plan, state: "uncertain", hash: `0x${"ab".repeat(32)}` });
  s.store.abandonUnsigned();
  expect(s.store.list()[0].state).toBe("uncertain");
});
