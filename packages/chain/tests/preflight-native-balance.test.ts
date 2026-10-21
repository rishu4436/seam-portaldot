/* eslint-disable @typescript-eslint/no-explicit-any -- decorated consts */
/** Native (tPOT) balance + existential deposit check before signing: fee + value + ED. Offline FakeNode. */
import { describe, expect, it } from "vitest";
import { compile, type Manifest } from "@seam/compiler";
import { decodeRuntime, preflight } from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { ALICE, BOB, snapshot, snapshotFacts, snapshotInputs } from "./helpers.js";

const facts = snapshotFacts();
const ED: bigint = (
  decodeRuntime(facts).decorated().consts as any
).balances.existentialDeposit.toBigInt();
const FEE = 1500000000n; // FakeNode payment_queryInfo partialFee
const ASSET = "806707";
const manifest = (n = 2): Manifest => ({
  version: 1,
  chain: { genesisHash: snapshot.genesis, specVersion: 1002 },
  signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
  actions: Array.from({ length: n }, (_, i) => ({
    id: `step${i + 1}`,
    kind: "assets.transfer" as const,
    args: { assetId: ASSET, amount: "1", recipient: BOB },
  })),
});
const node = (native?: Record<string, { free: bigint; reserved?: bigint; frozen?: bigint }>) =>
  new FakeNode({
    inputs: snapshotInputs(),
    facts,
    assetBalances: [{ assetId: ASSET, minBalance: 1n, accounts: { [ALICE]: 100n } }],
    ...(native ? { nativeBalances: native } : {}),
  });
const run = (n: FakeNode, steps = 2) => preflight(n, compile(manifest(steps), facts), facts);

describe("preflight: native balance and existential deposit (fee + value + ED)", () => {
  it("enough for both fees plus ED: no failure, and a pass never makes a step ok", async () => {
    const r = await run(node({ [ALICE]: { free: 2n * FEE + ED } }));
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["unknown", "unknown"]);
    expect(r.result.steps.every((s) => !/native balance check/.test(s.note ?? ""))).toBe(true);
  });

  it("enough for step 1 only: step 2 fails (the fee would take the signer below ED)", async () => {
    const r = await run(node({ [ALICE]: { free: 2n * FEE + ED - 1n } }));
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["unknown", "failed"]);
    expect(r.result.steps[1]!.note).toContain(
      `native balance check: step 2 needs ${FEE} (fee) but ${ALICE} (the signer) would keep ${ED - 1n}`,
    );
  });

  it("no System.Account entry (balance 0): step 1 fails", async () => {
    const r = await run(node({}));
    expect(r.result.steps[0]!.dryRun).toBe("failed");
    expect(r.result.steps[0]!.note).toMatch(/native balance check: step 1/);
  });

  it("frozen funds above ED are kept too", async () => {
    const r = await run(node({ [ALICE]: { free: FEE + 10n * ED - 1n, frozen: 10n * ED } }), 1);
    expect(r.result.steps[0]!.dryRun).toBe("failed");
    expect(r.result.steps[0]!.note).toMatch(/frozen amount/);
  });

  it("a read error leaves every step unknown", async () => {
    const r = await run(node()); // System.Account read throws
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["unknown", "unknown"]);
  });

  it("an unknown fee leaves every step unknown", async () => {
    const n = node({});
    n.breakRpc("payment_queryInfo");
    const r = await run(n);
    expect(r.result.steps.every((s) => !/native balance check/.test(s.note ?? ""))).toBe(true);
  });
});
