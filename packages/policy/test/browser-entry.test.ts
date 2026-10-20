// P0-02: the browser entry @seam/policy/browser and its pre-sign gate.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, factsFromMetadata } from "@seam/compiler";
import * as Browser from "../src/browser.js";
import {
  assertPolicyAllows,
  codeFor,
  explainPolicy,
  gatePolicy,
  PolicyBlockedError,
  RULE_TITLES,
  evaluatePolicy as evaluateBrowser,
} from "../src/browser.js";
import {
  evaluatePolicy,
  planDigest,
  type Plan,
  type PlanStep,
  type Hex,
  type Policy,
} from "../src/index.js";
import * as H from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src");
const root = resolve(here, "../../..");
const readRoot = (p: string) => readFileSync(resolve(root, p), "utf8");

// ---- import graph -------------------------------------------------------------------------
function importGraph(entry: string) {
  const seen = new Set<string>();
  const external = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const re =
      /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
    for (const m of text.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith(".")) walk(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      else external.add(spec);
    }
  };
  walk(entry);
  return { files: [...seen], external: [...external] };
}

describe("@seam/policy/browser entry", () => {
  const g = importGraph(resolve(src, "browser.ts"));
  it("walks the whole src graph", () => {
    expect(g.files.length).toBeGreaterThanOrEqual(10);
  });
  it("has no node built-in imports anywhere in its graph", () => {
    const builtins = new Set(builtinModules.flatMap((b) => [b, `node:${b}`]));
    const bad = g.external.filter((s) => s.startsWith("node:") || builtins.has(s.split("/")[0]));
    expect(bad).toEqual([]);
    // only pure-JS deps
    expect(
      g.external.every((s) => s.startsWith("@noble/hashes") || s === "@seam/compiler/browser"),
    ).toBe(true);
    for (const f of g.files)
      expect(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(
        /\bprocess\.|\bBuffer\b|__dirname/,
      );
  });
  it("is exported as ./browser in package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));
    expect(pkg.exports["./browser"].import).toBe("./dist/browser.js");
    expect(pkg.exports["."].import).toBe("./dist/index.js");
  });
  it("re-exports the same evaluatePolicy as node", () => {
    expect(evaluateBrowser).toBe(evaluatePolicy);
    expect(typeof Browser.createApproval).toBe("function");
  });
});

// ---- V3 demo (real committed spec-3002 metadata, same inputs as scripts/gen-v3-demo-transfer.mjs) --
const demo = JSON.parse(readRoot("packages/console/src/demo/v3-demo-transfer.json"));
const seqFile = JSON.parse(
  readRoot("packages/console/src/demo/v3-demo-transfer-policy-sequential.json"),
);
const atomicRun = JSON.parse(readRoot("evidence/testnet-v3/runs/plan-atomic-1792411355057.json"));
const fp = atomicRun.facts.fingerprint;
const v3Facts = factsFromMetadata({
  metadataHex: readRoot("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex").trim(),
  genesisHash: fp.genesisHash,
  tokenSymbol: fp.tokenSymbol,
  tokenDecimals: fp.tokenDecimals,
  ss58Prefix: fp.ss58Prefix,
  batchAllRollback: atomicRun.facts.behaviour?.batchAllRollback,
  batchAllRollbackProof: atomicRun.facts.behaviour?.batchAllRollbackProof,
} as never) as never;
// Example preflight (not live data): within the demo's fee cap.
const demoPreflight = (plan: Plan) => ({
  steps: plan.steps.map((s) => ({
    actionId: s.actionId,
    weight: { value: "200000000" },
    fee: { value: "1480000000000" },
    storageDeposit: { value: "0" },
    dryRun: "ok" as const,
  })),
  totalFee: { value: "1480000000000" },
});
const demoInput = (policy: Policy, over: Record<string, unknown> = {}) => ({
  policy,
  plan: demo.plan as Plan,
  facts: v3Facts,
  preflight: demoPreflight(demo.plan),
  manifest: demo.manifest,
  ...over,
});
const OPTS = { acknowledgedDowngrade: true };

describe("V3 wallet demo policy", () => {
  it("the committed demo plan is still what the compiler produces (fingerprint unchanged)", () => {
    expect((v3Facts as { fingerprintDigest: string }).fingerprintDigest).toBe(
      demo.fingerprintDigest,
    );
    expect(demo.plan.mode).toBe("sequential");
    expect(planDigest(demo.plan)).toBe(demo.plan.planDigest);
    const again = compile(demo.manifest, v3Facts) as unknown as Plan;
    expect(again.planDigest).toBe(demo.plan.planDigest);
  });
  it("the new sequential policy equals the original except allowedModes", () => {
    expect({ ...seqFile.policy, allowedModes: undefined }).toEqual({
      ...demo.policy,
      allowedModes: undefined,
    });
    expect(seqFile.policy.allowedModes).toEqual(["sequential"]);
    expect(demo.policy.allowedModes).toEqual(["atomic_verified"]); // original untouched
  });
  it("sequential policy passes the demo plan", () => {
    const g = gatePolicy(demoInput(seqFile.policy), OPTS);
    expect(g.blockedBy).toEqual([]);
    expect(g.allowed).toBe(true);
    expect(g.explanations.every((x) => x.status === "pass")).toBe(true);
  });
  it("the downgrade still needs an explicit acknowledgement", () => {
    const g = gatePolicy(demoInput(seqFile.policy));
    if (g.result?.approvalRequired?.length) {
      expect(g.allowed).toBe(false);
      expect(g.blockedBy.map((b) => b.code)).toEqual(["MODE_DOWNGRADE_NOT_ACKNOWLEDGED"]);
    } else expect(g.allowed).toBe(true);
  });
  it("the original atomic_verified-only policy blocks with PLAN_MODE_NOT_ALLOWED before signing", async () => {
    const signer = vi.fn(async () => "0xsig");
    await expect(signGated(demoInput(demo.policy), signer)).rejects.toBeInstanceOf(
      PolicyBlockedError,
    );
    expect(signer).not.toHaveBeenCalled();
    const g = gatePolicy(demoInput(demo.policy), OPTS);
    expect(g.blockedBy.map((b) => b.code)).toContain("PLAN_MODE_NOT_ALLOWED");
  });
});

// ---- signing gate: a violation never reaches the signer -------------------------------------
async function signGated(
  input: Parameters<typeof gatePolicy>[0],
  signer: () => Promise<string>,
  opts = OPTS as Browser.GateOptions,
) {
  assertPolicyAllows(input, opts);
  return signer();
}
const seq = seqFile.policy as Policy;
const CODE = ("0x" + "ab".repeat(32)) as Hex;
function deployPlan(codeHash: Hex): Plan {
  const step = {
    actionId: "deploy",
    kind: "revive.instantiate_with_code",
    capability: "Revive.instantiate_with_code",
    palletIndex: 60,
    callIndex: 1,
    decodedArgs: {
      codeHash,
      value: "0",
      gasLimit: "4000000000",
      proofSize: "500000",
      storageDepositLimit: "1",
    },
    encodedCall: "0x3c01",
    status: "ok",
  } as unknown as PlanStep;
  const { planDigest: _d, ...rest } = { ...H.compilePlan(), steps: [step] };
  const plan = { ...rest, planDigest: "0x" } as Plan;
  plan.planDigest = planDigest(plan);
  return plan;
}

const violations: [string, Parameters<typeof gatePolicy>[0], Browser.GateOptions, string][] = [
  ["mode", demoInput({ ...seq, allowedModes: ["atomic_verified"] }), OPTS, "PLAN_MODE_NOT_ALLOWED"],
  ["asset", demoInput({ ...seq, allowedAssets: ["1"] }), OPTS, "ASSET_NOT_ALLOWED"],
  ["recipient", demoInput({ ...seq, allowedRecipients: [H.BOB] }), OPTS, "RECIPIENT_NOT_ALLOWED"],
  [
    "amount",
    demoInput({ ...seq, maxAmountPerAsset: { "806707": "0", "*": "0" } }),
    OPTS,
    "AMOUNT_OVER_LIMIT",
  ],
  [
    "expiry",
    demoInput(seq),
    { ...OPTS, envelope: { expiresAt: "2026-10-20T09:00:00Z" }, now: H.NOW },
    "SIGNING_WINDOW_EXPIRED",
  ],
  [
    "deploy code hash",
    {
      policy: H.policy({
        deploy: {
          allowedCodeHashes: [CODE],
          maxStorageDepositLimit: "10",
          maxGasLimit: "5000000000",
          maxProofSize: "1000000",
        },
      }),
      plan: deployPlan(("0x" + "cd".repeat(32)) as Hex),
      facts: H.realFacts(),
    },
    OPTS,
    "DEPLOY_CODE_HASH_NOT_ALLOWED",
  ],
  [
    "unknown data (no preflight)",
    demoInput(seq, { preflight: undefined }),
    OPTS,
    "PREFLIGHT_UNKNOWN",
  ],
  [
    "unknown data (fee unknown)",
    demoInput(seq, { preflight: { ...demoPreflight(demo.plan), totalFee: { unknown: true } } }),
    OPTS,
    "FEE_LIMIT_UNKNOWN",
  ],
  [
    "tampered plan",
    demoInput(seq, { plan: { ...demo.plan, mode: "atomic_verified" } }),
    OPTS,
    "PLAN_DIGEST_MISMATCH",
  ],
  ["engine throws", demoInput(seq, { facts: undefined }), OPTS, "POLICY_EVALUATION_ERROR"],
];

describe("gate: a violation never reaches the signer", () => {
  it.each(violations)("%s", async (_n, input, opts, code) => {
    const signer = vi.fn(async () => "0xsig");
    const err = await signGated(input, signer, opts).catch((e) => e);
    expect(err).toBeInstanceOf(PolicyBlockedError);
    expect(signer).not.toHaveBeenCalled();
    const g = gatePolicy(input, opts);
    expect(g.allowed).toBe(false);
    expect((err as PolicyBlockedError).codes).toContain(code);
  });
  it("the happy path does reach the signer exactly once", async () => {
    const signer = vi.fn(async () => "0xsig");
    await expect(
      signGated(demoInput(seq), signer, {
        ...OPTS,
        envelope: { expiresAt: "2026-10-20T10:05:00Z" },
        now: H.NOW,
      }),
    ).resolves.toBe("0xsig");
    expect(signer).toHaveBeenCalledTimes(1);
  });
  it("an unacknowledged mode downgrade blocks", async () => {
    const base = {
      ...demo.plan,
      modeDowngrade: {
        from: "atomic",
        to: "sequential",
        requiresApproval: true,
        reason: "rollback proof not accepted",
      },
    } as Plan;
    base.planDigest = planDigest(base);
    const c = demoInput(seq, { plan: base });
    expect(evaluatePolicy(c as never).approvalRequired?.length).toBe(1);
    const signer = vi.fn(async () => "0xsig");
    const err = await signGated(c, signer, {}).catch((e) => e);
    expect((err as PolicyBlockedError).codes).toEqual(["MODE_DOWNGRADE_NOT_ACKNOWLEDGED"]);
    expect(signer).not.toHaveBeenCalled();
    expect(gatePolicy(c, OPTS).allowed).toBe(true);
  });
  it("a result that says allowed but has an unknown rule is still blocked", () => {
    const r = {
      allowed: true,
      policyDigest: "0x" as Hex,
      rules: [{ rule: "dry_run", outcome: "unknown" as const, reason: "x" }],
    };
    expect(explainPolicy(r)[0].status).toBe("unknown");
  });
});

// ---- parity with node on fixtures -------------------------------------------------------------
describe("parity with the node engine", () => {
  const cases = [
    {
      policy: H.policy(),
      plan: H.compilePlan(),
      facts: H.realFacts(),
      preflight: H.preflight(H.compilePlan()),
    },
    { policy: H.policy({ allowedAssets: ["2"] }), plan: H.compilePlan(), facts: H.realFacts() },
    {
      policy: H.policy(),
      plan: H.compilePlan(H.demoManifest(), H.withRollback(H.realFacts())),
      facts: H.withRollback(H.realFacts()),
      preflight: H.preflight(H.compilePlan()),
    },
    demoInput(seq),
    demoInput(demo.policy),
  ];
  it.each(cases.map((c, i) => [i, c] as const))("case %i: same result and gate agrees", (_i, c) => {
    const a = evaluatePolicy(c as never);
    const b = Browser.evaluatePolicy(c as never);
    expect(b).toEqual(a);
    const g = gatePolicy(c as never, OPTS);
    expect(g.result).toEqual(a);
    if (!a.allowed) expect(g.allowed).toBe(false);
    expect(g.explanations.length).toBeGreaterThanOrEqual(a.rules.length);
  });
});

// ---- readable explanations --------------------------------------------------------------------
describe("explanations", () => {
  const emitted = new Set<string>();
  for (const f of ["policy.ts", "deploy.ts"]) {
    const t = readFileSync(resolve(src, f), "utf8");
    for (const m of t.matchAll(/(?:pass|block|unknown|est|rule:)\(?\s*"([a-z_]+)"/g))
      emitted.add(m[1]);
  }
  const deployCodes = [
    ...readFileSync(resolve(src, "deploy.ts"), "utf8").matchAll(/"((?:DEPLOY|MAP)_[A-Z_]+)"/g),
  ].map((m) => m[1]);
  it("found the emitted rules", () => {
    expect(emitted.has("mode_allowed")).toBe(true);
    expect(emitted.size).toBeGreaterThan(15);
  });
  it("every emitted rule has a readable title", () => {
    for (const r of emitted) expect(RULE_TITLES[r], r).toBeTruthy();
  });
  it.each([...emitted])("rule %s yields a readable line for each outcome", (rule) => {
    for (const outcome of ["pass", "block", "unknown"] as const) {
      const [e] = explainPolicy({
        allowed: false,
        policyDigest: "0x",
        rules: [{ rule, outcome, reason: "some reason", actionId: "pay" }],
      });
      expect(e.status).toBe(outcome === "block" ? "fail" : outcome);
      expect(e.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(e.message).toMatch(
        new RegExp(
          `^${RULE_TITLES[rule].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(step pay\\): (Pass|Fail|Unknown, so blocked)\\. Some reason\\.$`,
        ),
      );
    }
  });
  it.each(deployCodes)("deploy code %s is kept and explained", (code) => {
    const [e] = explainPolicy({
      allowed: false,
      policyDigest: "0x",
      rules: [{ rule: "deploy_code_hash", outcome: "block", reason: "Blocked: x.", code }],
    });
    expect(e.code).toBe(code);
    expect(e.status).toBe("fail");
    expect(e.message.length).toBeGreaterThan(10);
  });
  it("codeFor prefers an explicit code", () => {
    expect(codeFor({ rule: "mode_allowed", outcome: "block" })).toBe("PLAN_MODE_NOT_ALLOWED");
    expect(codeFor({ rule: "x", outcome: "block", code: "Y" })).toBe("Y");
    expect(codeFor({ rule: "fee_limit", outcome: "unknown" })).toBe("FEE_LIMIT_UNKNOWN");
  });
});
