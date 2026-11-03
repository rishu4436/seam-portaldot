// @vitest-environment jsdom
import { afterEach, it, expect } from "vitest";
import { browserKV, RUN_STORE_KEY, RunStore, type KV } from "../runstore";
const hash = `0x${"ab".repeat(32)}`;
afterEach(() => localStorage.clear());
it("blocks corrupt, unreadable and non-persistent journals before a send can be claimed", () => {
  localStorage.setItem(RUN_STORE_KEY, "{");
  expect(() => new RunStore(browserKV()).claimSend(hash, 0)).toThrow(/Signing is blocked/);
  expect(new RunStore(undefined).problem()).toMatch(/Signing is blocked/);
  const silent: KV = { getItem: () => null, setItem: () => {} };
  expect(() => new RunStore(silent).claimSend(hash, 0)).toThrow(/could not be persisted/);
});
it("allows only one concurrent claim across browser instances", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => new RunStore(browserKV()).claimSendOnce(hash, 0)),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
});
it("keeps the dedicated send guard after an older tab overwrites its history snapshot", () => {
  const before = JSON.stringify({ version: 1, runs: {}, used: [], sends: {} });
  expect(new RunStore(browserKV()).claimSend(hash, 0)).toBe(true);
  localStorage.setItem(RUN_STORE_KEY, before);
  expect(new RunStore(browserKV()).claimSend(hash, 0)).toBe(false);
});
it("does not turn unfinalized failed inclusion into a terminal failure", async () => {
  const store = new RunStore(browserKV());
  store.upsertRun({
    approvalHash: hash,
    phase: "submitted",
    fromBlock: 1,
    steps: [
      {
        index: 0,
        actionId: "pay",
        status: "submitted",
        txHash: hash,
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  const lookup = async () => ({
    status: "found" as const,
    blockNumber: 2,
    blockHash: hash,
    extrinsicIndex: 0,
    success: false,
    finalized: false,
  });
  await store.recover(lookup);
  expect(store.run(hash)?.phase).toBe("uncertain");
  expect(store.run(hash)?.steps[0].status).toBe("in_block");
  await store.recover(async () => ({ ...(await lookup()), finalized: true }));
  expect(store.run(hash)?.phase).toBe("failed");
});
