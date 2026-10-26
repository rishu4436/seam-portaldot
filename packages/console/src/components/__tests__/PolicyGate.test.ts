// @vitest-environment node
// The real @seam/policy/browser gate on the real demo plan, the sequential demo policy and facts from the committed
// V3 spec 3002 metadata. No preflight producer is exported to the browser yet, so the honest result is blocked.
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { factsFromMetadata } from "@seam/compiler/browser";
import { runPolicyGate } from "../../lib/policygate";

// Fixture paths resolve from this test file, not process.cwd(), so `vitest --root packages/console` works from the repo root.
const CONSOLE_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");

const root = (p: string) => resolve(CONSOLE_DIR, "../..", p);
const demo = JSON.parse(
  readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
);
const seq = JSON.parse(
  readFileSync(root("packages/console/src/demo/v3-demo-transfer-policy-sequential.json"), "utf8"),
);
const facts = factsFromMetadata({
  metadataHex: readFileSync(
    root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
    "utf8",
  ).trim(),
  genesisHash: demo.manifest.chain.genesisHash,
  tokenSymbol: "tPOT",
  tokenDecimals: 14,
});

describe("runPolicyGate (real engine)", () => {
  it("blocks the demo plan without a full preflight and explains every rule", () => {
    const g = runPolicyGate({
      policy: seq.policy,
      plan: demo.plan,
      facts,
      manifest: demo.manifest,
    });
    expect(g.ok).toBe(false);
    expect(!g.ok && g.codes.some((c) => /PREFLIGHT/.test(c))).toBe(true);
    expect(g.explanations.length).toBeGreaterThan(1);
    expect(g.explanations.every((x) => ["pass", "fail", "unknown"].includes(x.status))).toBe(true);
  });
  it("blocks with no policy", () => {
    const g = runPolicyGate(undefined);
    expect(!g.ok && g.codes).toEqual(["POLICY_MISSING"]);
  });
  it("blocks the original atomic-only policy on mode", () => {
    const g = runPolicyGate({
      policy: demo.policy,
      plan: demo.plan,
      facts,
      manifest: demo.manifest,
    });
    expect(!g.ok && g.codes).toContain("PLAN_MODE_NOT_ALLOWED");
  });
});
