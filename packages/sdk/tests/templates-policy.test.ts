// P1-04: every compiler action template goes through the normal policy gate (evaluatePolicy), offline, against the
// REAL committed V3 spec 3002 metadata. Lives in the SDK because @seam/policy depends on @seam/compiler (a compiler
// test importing policy would be circular). The preflight here is SYNTHETIC test data, not a chain reading.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compile,
  factsFromMetadata,
  instantiateTemplate,
  type Manifest,
  type Plan,
  type TemplateId,
  verifyPlan,
} from "@seam/compiler";
import {
  callsToSign,
  checkBeforeSubmit,
  checkDeployStep,
  InMemoryApprovalStore,
  type BoundApproval,
  type DecodedSignedExtrinsic,
  type Hex,
  createApproval,
  definePolicy,
  evaluatePolicy,
  planDigest,
  type Policy,
  type PreflightResult,
  type SigningEnvelope,
} from "@seam/policy";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const v3Hex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const demo = JSON.parse(
  readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
);
const facts = factsFromMetadata({
  metadataHex: v3Hex,
  genesisHash: demo.manifest.chain.genesisHash,
  tokenSymbol: "tPOT",
  tokenDecimals: 14,
});

// Well-known dev accounts: test-only values, never live defaults.
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const CHARLIE = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";
const DAVE = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";
const H160 = "0x1111111111111111111111111111111111111111";
const OTHER_H160 = "0x2222222222222222222222222222222222222222";
const ASSET = "806707";

const transfer2 = {
  signer: ALICE,
  assetId: ASSET,
  recipient1: BOB,
  amount1: "10",
  recipient2: CHARLIE,
  amount2: "20",
};
const deployParams = {
  signer: ALICE,
  code: "0x50564d00deadbeef",
  data: "0x",
  gasLimit: "5000000000",
  proofSize: "200000",
  storageDepositLimit: "10000000000000",
};

interface Case {
  params: Record<string, string>;
  /** Deny-by-default policy allowing exactly this template's action. */
  policy: (codeHash?: string) => Partial<Policy>;
  /** One violation the gate must block. */
  negative: {
    what: string;
    params?: Record<string, string>;
    policy?: (codeHash?: string) => Partial<Policy>;
  };
}

const assetPolicy = (recipients: string[], max = "1000") => ({
  allowedCapabilities: ["Assets.transfer_keep_alive", "Assets.transfer", "Assets.mint"],
  allowedAssets: [ASSET],
  allowedRecipients: recipients,
  maxAmountPerAsset: { [ASSET]: max },
});

const CASES: Record<TemplateId, Case> = {
  "asset-transfer": {
    params: { signer: ALICE, recipient: BOB, assetId: ASSET, amount: "1000" },
    policy: () => assetPolicy([BOB]),
    negative: { what: "recipient not allowlisted", params: { recipient: DAVE } },
  },
  "nft-mint": {
    params: { signer: ALICE, recipient: BOB, collection: "1", item: "7" },
    policy: () => ({ allowedCapabilities: ["Nfts.mint"], allowedRecipients: [BOB] }),
    negative: { what: "recipient not allowlisted", params: { recipient: DAVE } },
  },
  "asset-mint": {
    params: { signer: ALICE, recipient: BOB, assetId: ASSET, amount: "500" },
    policy: () => assetPolicy([BOB]),
    negative: { what: "amount over the asset cap", params: { amount: "1001" } },
  },
  "sequential-transfers": {
    params: transfer2,
    policy: () => ({ ...assetPolicy([BOB, CHARLIE]), maxSteps: 2, allowedModes: ["sequential"] }),
    negative: { what: "step 2 recipient not allowlisted", params: { recipient2: DAVE } },
  },
  "atomic-batch": {
    params: transfer2,
    policy: () => ({
      ...assetPolicy([BOB, CHARLIE]),
      maxSteps: 2,
      allowedModes: ["atomic_unverified"],
    }),
    negative: {
      what: "atomic_unverified not in allowedModes",
      policy: () => ({
        ...assetPolicy([BOB, CHARLIE]),
        maxSteps: 2,
        allowedModes: ["sequential", "atomic_verified"],
      }),
    },
  },
  "revive-call": {
    params: {
      signer: ALICE,
      contract: H160,
      data: "0x12345678",
      value: "0",
      gasLimit: "5000000000",
      proofSize: "1000000",
      storageDepositLimit: "100",
    },
    policy: () => ({
      allowedCapabilities: ["Revive.call"],
      allowedContracts: [H160],
      maxNativeValue: "0",
      maxGasLimit: "5000000000",
      maxProofSize: "1000000",
      maxStorageDeposit: "100",
    }),
    negative: { what: "contract not allowlisted", params: { contract: OTHER_H160 } },
  },
  "restricted-deploy": {
    params: deployParams,
    policy: (codeHash) => ({
      allowedCapabilities: ["Revive.instantiate_with_code"],
      deploy: {
        allowedCodeHashes: [codeHash!],
        maxStorageDepositLimit: "10000000000000",
        maxGasLimit: "5000000000",
        maxProofSize: "200000",
      },
    }),
    negative: { what: "code hash not allowlisted", params: { code: "0x50564d00cafebabe" } },
  },
};

const opts = (id: TemplateId) => (id === "atomic-batch" ? { allowAtomicUnverified: true } : {});
const preflightFor = (plan: Plan): PreflightResult => ({
  steps: plan.steps.map((s) => ({
    actionId: s.actionId,
    weight: { value: "1000" },
    proofSize: { value: "1000" },
    fee: { value: "1000" },
    storageDeposit: { value: "0" },
    dryRun: "ok" as const,
  })),
  totalFee: { value: String(1000 * plan.steps.length) },
});

function gate(
  id: TemplateId,
  params: Record<string, string>,
  policyOf: Case["policy"],
  hashFrom?: string,
) {
  const r = instantiateTemplate(id, params, facts, opts(id));
  if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r.issues)}`);
  const manifest: Manifest = r.manifest;
  const plan = compile(manifest, facts, opts(id));
  const policy = definePolicy(policyOf(hashFrom ?? r.codeHash));
  const preflight = preflightFor(plan);
  const result = evaluatePolicy({ policy, plan, facts, preflight, manifest });
  return Object.assign(result, { ctx: { manifest, plan, policy, preflight } });
}

// Example signing envelope (test data, not a chain reading). Signer = the template's signer.
const NOW = new Date("2026-10-20T10:00:00Z");
const envelope: SigningEnvelope = {
  signer: ALICE,
  nonce: 5,
  mortalityBlocks: 64,
  checkpoint: { number: 126000, hash: `0x${"ab".repeat(32)}` },
  expiresAt: "2026-10-20T10:30:00Z",
};
function approve(res: ReturnType<typeof gate>, plan = res.ctx.plan) {
  const { manifest, policy, preflight } = res.ctx;
  return createApproval({
    manifestDigest: plan.manifestDigest,
    plan: plan as never,
    envelope,
    preflight,
    policy,
    policyResult: res,
    fingerprint: facts.fingerprint as never,
    now: NOW,
    manifest: manifest as never,
    liveFacts: facts as never,
    requirePlanVerified: true,
  });
}

const blockers = (res: ReturnType<typeof evaluatePolicy>) =>
  res.rules.filter((x) => x.outcome !== "pass").map((x) => `${x.rule}: ${x.reason}`);

describe.each(Object.keys(CASES) as TemplateId[])(
  "template %s through the policy gate (V3 spec 3002, offline)",
  (id) => {
    const c = CASES[id];
    it("is allowed by a deny-by-default policy that allows exactly its action", () => {
      const res = gate(id, c.params, c.policy);
      expect(res.allowed, blockers(res).join("\n")).toBe(true);
    });
    it("verifyPlan(manifest, plan, V3 facts) is ok", () => {
      const { manifest, plan } = gate(id, c.params, c.policy).ctx;
      const v = verifyPlan(manifest, plan, facts, opts(id));
      expect(v.ok, JSON.stringify(v)).toBe(true);
    });
    it("passes createApproval with manifest + liveFacts + requirePlanVerified", () => {
      const out = approve(gate(id, c.params, c.policy));
      expect(out.ok, (out as { reason?: string }).reason).toBe(true);
    });
    it(`is blocked: ${c.negative.what}`, () => {
      // For the deploy, the allowlist keeps the ORIGINAL code's hash while the manifest deploys different code.
      const orig = instantiateTemplate(id, c.params).ok
        ? (instantiateTemplate(id, c.params) as { codeHash?: string }).codeHash
        : undefined;
      const res = gate(
        id,
        { ...c.params, ...c.negative.params },
        c.negative.policy ?? c.policy,
        orig,
      );
      expect(res.allowed).toBe(false);
      expect(res.rules.some((x) => x.outcome === "block")).toBe(true);
    });
  },
);

it("the default policy (empty allowlists) blocks a template transfer", () => {
  const res = gate("asset-transfer", CASES["asset-transfer"].params, () => ({}));
  expect(res.allowed).toBe(false);
});

it("createApproval refuses a template plan whose bytes were edited (digest recomputed)", () => {
  const res = gate(
    "asset-transfer",
    CASES["asset-transfer"].params,
    CASES["asset-transfer"].policy,
  );
  const other = instantiateTemplate("asset-transfer", {
    ...CASES["asset-transfer"].params,
    recipient: CHARLIE,
  });
  if (!other.ok) throw new Error("instantiate");
  const evil = compile(other.manifest, facts);
  const forged = { ...res.ctx.plan, steps: evil.steps } as Plan;
  const edited = { ...forged, planDigest: planDigest(forged as never) } as Plan;
  const out = approve(res, edited);
  expect(out.ok).toBe(false);
  expect((out as { reason: string }).reason).toMatch(/call bytes/);
});

// ---- Live submit gate (checkBeforeSubmit live: true, Sentinel's call shape from 4dd5e1a) ----
// Synthetic: the "signed extrinsics" are opaque indices and the test decoder (metadataHashMode 0) returns the call
// bytes for each; nothing is signed or sent.
function liveSubmit(
  id: TemplateId,
  over: Record<string, unknown> = {},
  edit?: (calls: Hex[]) => Hex[],
) {
  const c = CASES[id];
  const res = gate(id, c.params, c.policy);
  const out = approve(res);
  if (!out.ok) throw new Error(`${id}: ${(out as { reason: string }).reason}`);
  const { manifest, plan, policy, preflight } = res.ctx;
  const calls = callsToSign(plan as never) as Hex[];
  const decoded = edit ? edit(calls) : calls;
  const xts = calls.map((_, n) => `0x${n.toString(16).padStart(2, "0")}` as Hex);
  const decodeSignedExtrinsic = (x: Hex): DecodedSignedExtrinsic => {
    const n = Number.parseInt(x.slice(2), 16);
    return {
      call: decoded[n]!,
      signer: ALICE,
      nonce: envelope.nonce + n,
      genesisHash: facts.fingerprint.genesisHash as Hex,
      signatureValid: true,
      metadataHashMode: 0,
    };
  };
  return checkBeforeSubmit({
    manifestDigest: plan.manifestDigest,
    plan: plan as never,
    envelope,
    preflight,
    policy,
    policyResult: res,
    approval: (out as { approval: BoundApproval }).approval,
    preparedFingerprint: facts.fingerprint as never,
    currentFingerprint: facts.fingerprint as never,
    signedCalls: calls,
    signedExtrinsics: xts,
    decodeSignedExtrinsic,
    requireTrustedDecoder: true,
    signedDryRun: calls.map(() => "ok" as const),
    // Sequential plans send one step at a time; an atomic plan is one transaction (no sendIndex).
    ...(plan.mode === "sequential" ? { sendIndex: 0, previousSteps: [] } : {}),
    store: new InMemoryApprovalStore(),
    now: NOW,
    live: true,
    manifest: manifest as never,
    liveFacts: facts as never,
    currentBlockNumber: envelope.checkpoint.number + 1,
    currentAccountNonce: envelope.nonce,
    requireEvaluatedPolicyResult: true,
    policyEvaluation: { facts: facts as never, manifest: manifest as never },
    ...over,
  });
}
const codesOf = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe.each(Object.keys(CASES) as TemplateId[])(
  "template %s through the live submit gate (offline, synthetic chain reads)",
  (id) => {
    it("honest live send passes with plan_bytes_verified", () => {
      const r = liveSubmit(id);
      expect(r.ok, JSON.stringify(r.reasons)).toBe(true);
      expect(r.passed.map((x) => x.code)).toContain("plan_bytes_verified");
    });
    it.each([
      ["live_block_missing", { currentBlockNumber: undefined }],
      ["live_nonce_missing", { currentAccountNonce: undefined }],
      ["live_manifest_missing", { manifest: undefined }],
      ["live_facts_missing", { liveFacts: undefined }],
    ] as const)("blocks %s", (code, over) => {
      const r = liveSubmit(id, over);
      expect(r.ok).toBe(false);
      expect(codesOf(r)).toContain(code);
    });
    it("blocks edited signed call bytes with plan_bytes_mismatch", () => {
      const r = liveSubmit(id, {}, (calls) =>
        calls.map((x, n) =>
          n === 0 ? ((x.slice(0, -2) + (x.endsWith("00") ? "01" : "00")) as Hex) : x,
        ),
      );
      expect(r.ok).toBe(false);
      expect(codesOf(r)).toContain("plan_bytes_mismatch");
    });
    it("blocks a stale nonce with nonce_stale", () => {
      const r = liveSubmit(id, { currentAccountNonce: envelope.nonce + 1 });
      expect(codesOf(r)).toContain("nonce_stale");
    });
    it("blocks an expired mortality with mortality_expired", () => {
      const r = liveSubmit(id, {
        currentBlockNumber: envelope.checkpoint.number + envelope.mortalityBlocks,
      });
      expect(codesOf(r)).toContain("mortality_expired");
    });
  },
);

it("live gate: missing signed calls and extrinsics blocks with live_signed_calls_missing", () => {
  const r = liveSubmit("asset-transfer", {
    signedCalls: [],
    signedExtrinsics: undefined,
    decodeSignedExtrinsic: undefined,
    requireTrustedDecoder: false,
  });
  expect(r.ok).toBe(false);
  expect(codesOf(r)).toContain("live_signed_calls_missing");
});

// ---- restricted-deploy: proof_size 0 / missing must count as UNKNOWN (Sentinel's deploy rule), never as a pass ----
// deploy.ts proofSize "0" is fixed by Sentinel's 66b29c8 (not on this base yet). Remaining GAP: packages/policy/src/policy.ts proof_size_limit skips the preflight estimate whenever the step
// has its own decodedArgs.proofSize, so a preflight proofSize of 0 or missing is never looked at. Written as it.fails
// until the policy fix (bot3/presign-fixture) lands; flip to it() then.
describe("restricted-deploy with proof_size 0 or missing", () => {
  const deployCase = CASES["restricted-deploy"];
  // Enabled once 66b29c8 (Sentinel, bot3/presign-fixture) merges: proofSize "0" -> DEPLOY_PROOF_SIZE_UNKNOWN.
  it.fails("a manifest proofSize of 0 is blocked as DEPLOY_PROOF_SIZE_UNKNOWN", () => {
    const res = gate("restricted-deploy", { ...deployParams, proofSize: "0" }, deployCase.policy);
    expect(res.allowed).toBe(false);
    expect(
      res.rules.some(
        (x) =>
          x.rule === "deploy_gas_limit" &&
          x.outcome === "block" &&
          JSON.stringify(x).includes("DEPLOY_PROOF_SIZE_UNKNOWN"),
      ),
    ).toBe(true);
  });
  it("a deploy step with no proof size blocks with DEPLOY_GAS_LIMIT_MISSING", () => {
    const r = instantiateTemplate("restricted-deploy", deployParams, facts);
    if (!r.ok) throw new Error("instantiate");
    const plan = compile(r.manifest, facts);
    const step = plan.steps[0]!;
    const args = { ...(step.decodedArgs as Record<string, unknown>) };
    delete args.proofSize;
    const out = checkDeployStep(
      { ...step, decodedArgs: args } as never,
      deployCase.policy(r.codeHash).deploy as never,
      plan.signer.publicKey as Hex,
    );
    expect(
      out.some(
        (x) =>
          x.rule === "deploy_gas_limit" &&
          x.outcome === "block" &&
          JSON.stringify(x).includes("DEPLOY_GAS_LIMIT_MISSING"),
      ),
    ).toBe(true);
  });
  for (const [what, proofSize] of [
    ["0", { value: "0" }],
    ["missing", undefined],
  ] as const) {
    it.fails(`a preflight proof_size ${what} is treated as unknown and blocked`, () => {
      const r = instantiateTemplate("restricted-deploy", deployParams, facts);
      if (!r.ok) throw new Error("instantiate");
      const plan = compile(r.manifest, facts);
      const preflight = preflightFor(plan);
      preflight.steps = preflight.steps.map((s) => ({ ...s, proofSize: proofSize as never }));
      const policy = definePolicy({ ...deployCase.policy(r.codeHash), maxProofSize: "200000" });
      const res = evaluatePolicy({ policy, plan, facts, preflight, manifest: r.manifest });
      expect(res.allowed).toBe(false);
    });
  }
});
