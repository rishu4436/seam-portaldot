import { it, expect } from "vitest";
import { readAccountReadiness } from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { ALICE, snapshotFacts, snapshotInputs } from "./helpers.js";
const facts = snapshotFacts();
it("reads native and asset balances at a single finalized block without losing integer precision", async () => {
  const node = new FakeNode({
    inputs: snapshotInputs(),
    facts,
    nativeBalances: { [ALICE]: { free: 123456789012345678901234n, frozen: 500n, reserved: 300n } },
    assetBalances: [{ assetId: "1", minBalance: 1n, accounts: { [ALICE]: 9007199254740993123n } }],
  });
  const result = await readAccountReadiness(node.send.bind(node), facts, ALICE, ["1", "2"]);
  expect(result.assets[0].balance).toEqual({
    known: true,
    value: { exists: true, balance: "9007199254740993123", minBalance: "1" },
  });
  expect(result.native).toMatchObject({
    known: true,
    value: { free: "123456789012345678901234", frozen: "500", reserved: "300" },
  });
  expect(result.assets).toMatchObject([
    {
      assetId: "1",
      balance: { known: true, value: { exists: true, balance: "9007199254740993123" } },
    },
    { assetId: "2", balance: { known: true, value: { exists: false, balance: "0" } } },
  ]);
  expect(
    node.log
      .filter((entry) => entry.method === "state_getStorage")
      .every((entry) => entry.params[1] === result.block.hash),
  ).toBe(true);
  expect(node.submitted).toHaveLength(0);
});
it("unreadable storage stays unknown rather than becoming a zero balance", async () => {
  const node = new FakeNode({ inputs: snapshotInputs(), facts, failRpc: ["state_getStorage"] });
  const result = await readAccountReadiness(node.send.bind(node), facts, ALICE, ["1"]);
  expect(result.native.known).toBe(false);
  expect(result.assets[0].balance.known).toBe(false);
});
it("requires a new runtime read when a metadata layout or version has changed", async () => {
  const node = new FakeNode({ inputs: snapshotInputs(), facts });
  await expect(
    readAccountReadiness(
      async (method, params) =>
        method === "state_getRuntimeVersion"
          ? { ...snapshotInputs().runtimeVersion, specVersion: 99999 }
          : node.send(method, params),
      facts,
      ALICE,
    ),
  ).rejects.toThrow(/runtime changed/);
  expect(node.log.some((entry) => entry.method === "state_getStorage")).toBe(false);
});
it("refuses a different genesis and invalid asset identifiers", async () => {
  const node = new FakeNode({ inputs: snapshotInputs(), facts });
  await expect(
    readAccountReadiness(
      async (method, params) =>
        method === "chain_getBlockHash" ? `0x${"01".repeat(32)}` : node.send(method, params),
      facts,
      ALICE,
    ),
  ).rejects.toThrow(/different chain/);
  await expect(readAccountReadiness(node.send.bind(node), facts, ALICE, ["1e5"])).rejects.toThrow(
    /integer asset/,
  );
});
