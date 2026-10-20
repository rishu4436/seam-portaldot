import { describe, expect, it } from "vitest";
import { compile, type Manifest } from "@seam/compiler";
import { preflight } from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { ALICE, BOB, snapshot, snapshotFacts, snapshotInputs } from "./helpers.js";

const facts = snapshotFacts();
const ASSET = "806707";

/** The live V3 case: seam-demo held 2 units, minBalance 1, two keep-alive transfers of 1 each. */
const twoTransfers = (amounts: string[] = ["1", "1"]): Manifest => ({
  version: 1,
  chain: { genesisHash: snapshot.genesis, specVersion: 1002 },
  signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
  actions: amounts.map((amount, i) => ({
    id: `step${i + 1}`,
    kind: "assets.transfer" as const,
    args: { assetId: ASSET, amount, recipient: BOB },
  })),
});
const node = (
  balance?: bigint,
  minBalance = 1n,
  o: Partial<ConstructorParameters<typeof FakeNode>[0]> = {},
) =>
  new FakeNode({
    inputs: snapshotInputs(),
    facts,
    assetBalances: [
      { assetId: ASSET, minBalance, accounts: balance === undefined ? {} : { [ALICE]: balance } },
    ],
    ...o,
  });

describe("preflight: running asset balance for assets.transfer (transfer_keep_alive)", () => {
  it("compiles assets.transfer to Assets.transfer_keep_alive", () => {
    const plan = compile(twoTransfers(), facts);
    expect(plan.mode).toBe("sequential");
    expect(plan.steps.map((s) => s.kind)).toEqual(["assets.transfer", "assets.transfer"]);
  });

  it("balance 2, minBalance 1, keep-alive 1 + 1: step 2 fails before signing, step 1 does not", async () => {
    const r = await preflight(node(2n), compile(twoTransfers(), facts), facts);
    const [s1, s2] = r.result.steps;
    expect(s1!.dryRun).toBe("unknown");
    expect(s1!.note).not.toMatch(/asset balance check/);
    expect(s2!.dryRun).toBe("failed");
    expect(s2!.note).toContain(
      `asset balance check: step 2 would leave ${ALICE} (the signer) with 0 of asset ${ASSET}, below minBalance 1; transfer_keep_alive cannot empty the account`,
    );
    expect(r.coverage.steps[1]!.basis).toBe("fee_estimate_only");
  });

  it("an amount above the running balance fails that step", async () => {
    const r = await preflight(node(3n), compile(twoTransfers(["2", "5"]), facts), facts);
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["unknown", "failed"]);
    expect(r.result.steps[1]!.note).toMatch(
      /step 2 would transfer 5 of asset 806707 but .* would hold only 1/,
    );
  });

  it("no Assets.Account entry means balance 0: step 1 fails", async () => {
    const r = await preflight(node(undefined), compile(twoTransfers(), facts), facts);
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["failed", "unknown"]);
    expect(r.result.steps[0]!.note).toMatch(/would hold only 0/);
  });

  it("balance 6 (after the top-up): both steps pass the check and stay unknown, never ok", async () => {
    const r = await preflight(node(6n), compile(twoTransfers(), facts), facts);
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["unknown", "unknown"]);
    for (const s of r.result.steps) expect(s.note).not.toMatch(/asset balance check/);
  });

  it("minBalance above what would be left: keep-alive fails even with a non-zero remainder", async () => {
    const r = await preflight(node(6n, 3n), compile(twoTransfers(["2", "2"]), facts), facts);
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["unknown", "failed"]);
    expect(r.result.steps[1]!.note).toMatch(/with 2 of asset 806707, below minBalance 3/);
  });

  it("reads that fail leave the steps unknown (fail closed via policy, never ok)", async () => {
    const r = await preflight(
      node(2n, 1n, { failRpc: ["state_getStorage"] }),
      compile(twoTransfers(), facts),
      facts,
    );
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["unknown", "unknown"]);
    for (const s of r.result.steps) expect(s.note).not.toMatch(/asset balance check/);
  });

  it("asset details that do not decode leave the steps unknown", async () => {
    const r = await preflight(
      new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: [ASSET] }),
      compile(twoTransfers(), facts),
      facts,
    );
    expect(r.result.steps.map((s) => s.dryRun)).toEqual(["unknown", "unknown"]);
  });
});
