/** SEAM-018: the preflight reports honestly what was simulated. A per-step 'ok' is never a whole-plan guarantee. */
import { describe, expect, it } from "vitest";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { assembleSignedExtrinsic, buildSigningRequests, preflight } from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import {
  ALICE,
  CHECKPOINT,
  atomicPlan,
  demoPlan,
  devKeys,
  snapshotFacts,
  snapshotInputs,
} from "./helpers.js";

const facts = snapshotFacts();
const env = {
  signer: ALICE,
  nonce: 0,
  mortalityBlocks: 64,
  checkpoint: CHECKPOINT,
  expiresAt: "x",
};
async function signedFor(plan: any, f: any) {
  const keys = await devKeys();
  return buildSigningRequests(plan, f, env).map((q) =>
    assembleSignedExtrinsic(
      q.payload,
      u8aToHex(keys.alice.sign(hexToU8a(q.signBytesHex), { withType: true })),
      f,
    ),
  );
}

describe("SEAM-018: simulation coverage is reported, not implied", () => {
  it("sequential, nothing signed: no whole-plan simulation; each step says what was actually checked", async () => {
    const r = await preflight(
      new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: ["1", "2"] }),
      demoPlan(),
      facts,
    );
    expect(r.coverage.wholePlan).toBe("none");
    expect(r.coverage.steps.map((s) => s.basis)).toEqual([
      "asset_existence_check",
      "contract_dry_run",
      "asset_existence_check",
    ]);
    expect(r.coverage.summary).toMatch(/not simulated as a whole/i);
    for (const s of r.result.steps) expect(s.note).toMatch(/simulation coverage:/);
  });
  it("sequential with signed transactions: still no whole-plan simulation (later steps depend on earlier state)", async () => {
    const plan = demoPlan();
    const r = await preflight(
      new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: ["1", "2"] }),
      plan,
      facts,
      { signedExtrinsics: await signedFor(plan, facts), nonce: 0 },
    );
    expect(r.coverage.wholePlan).toBe("none");
    expect(r.coverage.steps[0]!.basis).toBe("signed_dry_run");
    expect(r.coverage.steps[2]!.basis).not.toBe("signed_dry_run"); // future nonce: unknown
    expect(r.coverage.summary).toMatch(/only the first|later steps/i);
  });
  it("atomic, nothing signed: no whole-plan simulation", async () => {
    const { plan, facts: f } = atomicPlan();
    const r = await preflight(
      new FakeNode({ inputs: snapshotInputs(), facts: f, existingAssets: ["1", "2"] }),
      plan,
      f,
    );
    expect(r.coverage.wholePlan).toBe("none");
  });
  it("atomic with the signed batch dry-run ok: whole plan covered by a signed dry run, and says so", async () => {
    const { plan, facts: f } = atomicPlan();
    const r = await preflight(
      new FakeNode({ inputs: snapshotInputs(), facts: f, existingAssets: ["1", "2"] }),
      plan,
      f,
      { signedExtrinsics: await signedFor(plan, f), nonce: 0 },
    );
    expect(r.coverage.wholePlan).toBe("signed_dry_run");
    expect(r.coverage.summary).toMatch(/signed dry.run of the whole/i);
  });
  it("a failed dry run is never reported as coverage", async () => {
    const { plan, facts: f } = atomicPlan();
    const n = new FakeNode({
      inputs: snapshotInputs(),
      facts: f,
      existingAssets: ["1", "2"],
      failCall: () => ({ index: 1, error: 0 }),
    });
    const r = await preflight(n, plan, f, { signedExtrinsics: await signedFor(plan, f), nonce: 0 });
    expect(r.coverage.wholePlan).toBe("none");
  });
});
