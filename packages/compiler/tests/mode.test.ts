import { describe, expect, it } from "vitest";
import { compile, type Manifest, type RuntimeFacts } from "../src/index.js";
import { demoManifest, realFacts, withRollback } from "./helpers.js";

const base = realFacts();
const noBatch: RuntimeFacts = {
  ...base,
  capabilities: { ...base.capabilities, "Utility.batch_all": { status: "not_observed" } },
};

describe("mode selection matrix", () => {
  it.each([
    ["batch_all + rollback verified", withRollback(base, "verified"), false, "atomic_verified"],
    [
      "batch_all + rollback verified, allow flag irrelevant",
      withRollback(base, "verified"),
      true,
      "atomic_verified",
    ],
    [
      "batch_all + rollback unknown, default options",
      withRollback(base, "unknown"),
      false,
      "sequential",
    ],
    [
      "batch_all + rollback unknown, allowAtomicUnverified",
      withRollback(base, "unknown"),
      true,
      "atomic_unverified",
    ],
    ["batch_all + rollback not_supported", withRollback(base, "not_supported"), true, "sequential"],
    ["no batch_all on runtime", noBatch, true, "sequential"],
    [
      "no batch_all even if rollback claimed verified",
      withRollback(noBatch, "verified"),
      false,
      "sequential",
    ],
  ] as const)("%s -> %s", (_name, facts, allow, mode) => {
    const p = compile(demoManifest(), facts, { allowAtomicUnverified: allow });
    expect(p.mode).toBe(mode);
    if (mode.startsWith("atomic")) {
      expect(p.outerCall).toMatchObject({
        capability: "Utility.batch_all",
        palletIndex: 1,
        callIndex: 2,
      });
      // batch_all prefix + compact(3) + the three inner calls in order.
      expect(p.outerCall!.encodedCall).toBe(
        `0x01020c${p.steps.map((s) => s.encodedCall!.slice(2)).join("")}`,
      );
    } else {
      expect(p.outerCall).toBeUndefined();
    }
  });

  it("default is safe: unverified rollback never batches unless asked", () => {
    expect(compile(demoManifest(), base).mode).toBe("sequential");
    expect(compile(demoManifest(), base).modeReason).toMatch(/not verified/);
  });

  it("preferredMode 'sequential' opts out of batching", () => {
    const m = demoManifest();
    m.actions[1]!.preferredMode = "sequential";
    expect(compile(m, withRollback(base, "verified")).mode).toBe("sequential");
  });

  it("preferredMode 'atomic' that cannot be honoured falls back to sequential and says so", () => {
    const m = demoManifest();
    m.actions[0]!.preferredMode = "atomic";
    const p = compile(m, base);
    expect(p.mode).toBe("sequential");
    expect(p.modeReason).toMatch(/^Atomic execution was requested but is not available/);
  });

  it("a single step is never wrapped in batch_all", () => {
    const m: Manifest = { ...demoManifest(), actions: [demoManifest().actions[0]!] };
    const p = compile(m, withRollback(base, "verified"));
    expect(p.mode).toBe("sequential");
    expect(p.outerCall).toBeUndefined();
  });

  it("unavailable beats every other mode", () => {
    const m = demoManifest();
    m.actions.push({
      id: "r",
      kind: "revive.call",
      args: { contract: "0x1111111111111111111111111111111111111111", value: "0", data: "0x" },
    });
    expect(compile(m, withRollback(base, "verified"), { allowAtomicUnverified: true }).mode).toBe(
      "unavailable",
    );
  });
});
