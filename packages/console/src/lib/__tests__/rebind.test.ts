// @vitest-environment node
// Facts snapshot + Forge's rebindPlan, before approve and before sign. Offline on the committed real V3 spec 3002
// metadata; the raw-metadata drift is made with the chain package's metadata mutator (same as Forge's tests).
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compile, factsFromMetadata } from "@seam/compiler/browser";
import { withFallback } from "../../../../chain/tests/metadataMutate";
import { approveWithRebind, checkRebind } from "../rebind";

// Fixture paths resolve from this test file, not process.cwd(), so `vitest --root packages/console` works from the repo root.
const CONSOLE_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");

const root = (p: string) => resolve(CONSOLE_DIR, "../..", p);
const v3Hex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim() as `0x${string}`;
const demo = JSON.parse(
  readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
);
const manifest = demo.manifest;
const facts = (hex: string, genesisHash = manifest.chain.genesisHash) =>
  factsFromMetadata({ metadataHex: hex, genesisHash, tokenSymbol: "tPOT", tokenDecimals: 14 });
const snap = facts(v3Hex);
const plan = compile(manifest, snap);
const drifted = facts(withFallback(v3Hex, "Revive", "EthBlockBuilderIR", "0x00"));

describe("facts snapshot and rebindPlan", () => {
  it("same raw facts: the plan stands and the engine check runs on that same read", async () => {
    const check = vi.fn(async () => "gate");
    const o = await approveWithRebind({
      manifest,
      plan,
      planFacts: snap,
      readFacts: async () => facts(v3Hex),
      check,
    });
    expect(o.kind).toBe("checked");
    expect(check).toHaveBeenCalledTimes(1);
  });
  it("different raw hash, same layout: recompiled with a new digest, no approval check, fresh approval required", async () => {
    expect(drifted.fingerprintDigest).not.toBe(snap.fingerprintDigest);
    const check = vi.fn(async () => "gate");
    const o = await approveWithRebind({
      manifest,
      plan,
      planFacts: snap,
      readFacts: async () => drifted,
      check,
    });
    expect(o.kind).toBe("rebound");
    expect(check).not.toHaveBeenCalled(); // never approved in the same step
    if (o.kind !== "rebound") throw new Error();
    const next = o.plan as typeof plan;
    expect(next.planDigest).not.toBe(plan.planDigest);
    expect(o.previousPlanDigest).toBe(plan.planDigest);
    expect(o.message).toMatch(/approve the new plan/);
    // The new plan with the new snapshot then approves normally.
    const again = await approveWithRebind({
      manifest,
      plan: next,
      planFacts: o.liveFacts,
      readFacts: async () => drifted,
      check,
    });
    expect(again.kind).toBe("checked");
  });
  it("before sign: a rebound plan never signs under the old approval", () => {
    const sign = vi.fn();
    const r = checkRebind(manifest, plan, snap, drifted);
    if (r.kind === "same") sign();
    expect(r.kind).toBe("rebound");
    expect(sign).not.toHaveBeenCalled();
  });
  it("identity differs (genesis): RUNTIME_CHANGED, before approve and before sign", async () => {
    const other = facts(v3Hex, "0x" + "12".repeat(32));
    expect(checkRebind(manifest, plan, snap, other)).toMatchObject({
      kind: "changed",
      code: "RUNTIME_CHANGED",
    });
    const o = await approveWithRebind({
      manifest,
      plan,
      planFacts: snap,
      readFacts: async () => other,
      check: async () => "gate",
    });
    expect(o).toMatchObject({ kind: "blocked", code: "RUNTIME_CHANGED" });
  });
  it("a layout change (other storage default) is RUNTIME_CHANGED", () => {
    const bad = facts(withFallback(v3Hex, "System", "Number", "0x2a000000"));
    expect(checkRebind(manifest, plan, snap, bad).kind).toBe("changed");
  });
});
