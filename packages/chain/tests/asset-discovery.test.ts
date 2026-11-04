import { expect, it } from "vitest";
import {
  readAccountReadiness,
  readRecipientReadiness,
  preflight,
  assessRecipientReadiness,
} from "../src/index.js";
import { compile } from "@seam/compiler";
import { FakeNode } from "./fakeNode.js";
import { ALICE, BOB, snapshotFacts, snapshotInputs, demoManifest } from "./helpers.js";
const facts = snapshotFacts();
const make = (extra: Partial<ConstructorParameters<typeof FakeNode>[0]> = {}) =>
  new FakeNode({
    inputs: snapshotInputs(),
    facts,
    nativeBalances: { [ALICE]: { free: 10n ** 25n } },
    assetBalances: [
      { assetId: "1", minBalance: 1n, accounts: { [ALICE]: 9007199254740993123n } },
      { assetId: "2", minBalance: 1n, accounts: { [BOB]: 5n } },
    ],
    ...extra,
  });

it("discovers only held assets across bounded pages at one fixed block", async () => {
  const node = make();
  const first = await readAccountReadiness(node.send.bind(node), facts, ALICE, [], {
    discover: true,
    pageSize: 1,
  });
  expect(first.discovery).toMatchObject({ complete: false, scanned: 1 });
  const second = await readAccountReadiness(node.send.bind(node), facts, ALICE, [], {
    discover: true,
    pageSize: 1,
    after: first.discovery!.nextCursor,
    at: first.block.hash,
  });
  const last = await readAccountReadiness(node.send.bind(node), facts, ALICE, [], {
    discover: true,
    pageSize: 1,
    after: second.discovery!.nextCursor,
    at: first.block.hash,
  });
  expect([...first.assets, ...second.assets].map((a) => a.assetId)).toEqual(["1"]);
  expect(first.assets.concat(second.assets)[0].balance).toMatchObject({
    known: true,
    value: { balance: "9007199254740993123" },
  });
  expect(last.discovery).toMatchObject({ complete: true, scanned: 0 });
  expect(
    node.log
      .filter((e) => e.method === "state_getKeysPaged")
      .every((e) => e.params[3] === first.block.hash),
  ).toBe(true);
  expect(node.submitted).toEqual([]);
});
it("reports discovery failure honestly and preserves manual lookups", async () => {
  const node = make({ failRpc: ["state_getKeysPaged"] });
  const result = await readAccountReadiness(node.send.bind(node), facts, ALICE, ["1"], {
    discover: true,
  });
  expect(result.discovery).toMatchObject({
    complete: false,
    scanned: 0,
    reason: expect.stringContaining("state_getKeysPaged"),
  });
  expect(result.assets[0].balance).toMatchObject({ known: true });
});
it("refuses repeated, oversized and foreign-prefix discovery pages", async () => {
  const node = make();
  for (const bad of [["0x1234"], Array(33).fill("0x1234")]) {
    const result = await readAccountReadiness(
      async (m, p) => (m === "state_getKeysPaged" ? bad : node.send(m, p)),
      facts,
      ALICE,
      [],
      { discover: true },
    );
    expect(result.discovery?.complete).toBe(false);
    expect(result.discovery?.reason).toBeTruthy();
    expect(result.assets).toEqual([]);
  }
  const first = await readAccountReadiness(node.send.bind(node), facts, ALICE, [], {
    discover: true,
    pageSize: 1,
  });
  const repeated = await readAccountReadiness(
    async (m, p) => (m === "state_getKeysPaged" ? [first.discovery!.nextCursor] : node.send(m, p)),
    facts,
    ALICE,
    [],
    { discover: true, after: first.discovery!.nextCursor },
  );
  expect(repeated.discovery?.reason).toMatch(/repeated/);
});
it("distinguishes unfunded recipients, provider accounts and sufficient assets", async () => {
  const node = make();
  const missing = await readRecipientReadiness(node.send.bind(node), facts, BOB, "1", "1");
  expect(missing.status).toBe("needs_funding");
  expect(BigInt(missing.nativeShortfall!)).toBeGreaterThan(0n);
  const funded = make({ nativeBalances: { [BOB]: { free: 10n ** 20n } } });
  expect(
    (await readRecipientReadiness(funded.send.bind(funded), facts, BOB, "1", "1")).status,
  ).toBe("ready");
  const sufficient = make({
    assetBalances: [{ assetId: "1", minBalance: 1n, isSufficient: true, accounts: {} }],
  });
  expect(
    (await readRecipientReadiness(sufficient.send.bind(sufficient), facts, BOB, "1", "1")).status,
  ).toBe("ready");
});
it("leaves unreadable requirements unknown and detects minimum balance and missing assets", async () => {
  const node = make({ failRpc: ["state_getStorage"] });
  expect((await readRecipientReadiness(node.send.bind(node), facts, BOB, "1", "1")).status).toBe(
    "unknown",
  );
  const other = make({
    assetBalances: [{ assetId: "1", minBalance: 5n, accounts: { [BOB]: 0n } }],
  });
  expect((await readRecipientReadiness(other.send.bind(other), facts, BOB, "1", "1")).status).toBe(
    "blocked",
  );
  expect((await readRecipientReadiness(other.send.bind(other), facts, BOB, "9", "1")).status).toBe(
    "blocked",
  );
  const observed = await readAccountReadiness(other.send.bind(other), facts, BOB, ["1"]);
  expect(assessRecipientReadiness(observed, "1", "0").status).toBe("unknown");
});
it("preflight blocks an unfunded first recipient before any wallet signature", async () => {
  const node = make();
  const manifest = demoManifest();
  manifest.actions = [
    { id: "pay", kind: "assets.transfer", args: { assetId: "1", amount: "1", recipient: BOB } },
  ];
  const result = await preflight(node, compile(manifest, facts), facts);
  expect(result.result.steps[0].dryRun).toBe("failed");
  expect(result.result.steps[0].note).toMatch(/Recipient readiness.*native tPOT/);
  expect(node.submitted).toEqual([]);
});
