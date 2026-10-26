// Shared flow for the P1-04 template examples. OFFLINE ONLY: reads committed files, never opens a socket,
// never signs, never submits. Facts come from the committed V3 spec 3002 metadata blob.
// Run from the repo root after `npm run build`: node examples/templates/<name>.mjs (or npm run examples:templates).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compile,
  factsFromMetadata,
  instantiateTemplate,
  listTemplates,
  PLACEHOLDER,
  templateSkeleton,
  verifyPlan,
} from "@seam/compiler";
import { createApproval, definePolicy, evaluatePolicy, planDigest } from "@seam/policy";
import { gatePolicy } from "@seam/policy/browser";

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

/** Real committed V3 runtime (spec 3002) metadata, decoded offline. */
export function v3Facts() {
  const metadataHex = readFileSync(
    root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
    "utf8",
  ).trim();
  const demo = JSON.parse(
    readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
  );
  return factsFromMetadata({
    metadataHex,
    genesisHash: demo.manifest.chain.genesisHash,
    tokenSymbol: "tPOT",
    tokenDecimals: 14,
  });
}

// TEST / DEV ACCOUNTS ONLY: the well-known Substrate dev keys (//Alice, //Bob, //Charlie, //Dave).
// Anyone can sign for them. They are example values, never defaults, and must never hold real funds.
export const DEV = {
  ALICE: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  BOB: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
  CHARLIE: "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y",
  DAVE: "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy",
  // Made-up H160 contract addresses (no contract is deployed there).
  TEST_CONTRACT: "0x1111111111111111111111111111111111111111",
  OTHER_CONTRACT: "0x2222222222222222222222222222222222222222",
  // Example asset id (test value).
  ASSET: "806707",
};

// SYNTHETIC preflight and signing envelope: example data, not chain readings. Nothing is dry-run on a node here.
// Revive steps (revive.call, deploy) carry the dry-run estimate as dryRunProofSize (Revive's weight_required), never
// as the legacy proofSize, which policy reads as payment_queryInfo call info (cap + overhead). Pass callInfoProofSize
// to add a measured query_call_info total, which is what requireMeasuredProofSize needs.
const isRevive = (s) => typeof s.capability === "string" && s.capability.startsWith("Revive.");
const preflightFor = (plan, { callInfoProofSize } = {}) => ({
  steps: plan.steps.map((s) => ({
    actionId: s.actionId,
    weight: { value: "1000" },
    ...(isRevive(s)
      ? {
          dryRunProofSize: { value: "1000" },
          ...(callInfoProofSize ? { callInfoProofSize: { value: callInfoProofSize } } : {}),
        }
      : { proofSize: { value: "1000" } }),
    fee: { value: "1000" },
    storageDeposit: { value: "0" },
    dryRun: "ok",
  })),
  totalFee: { value: String(1000 * plan.steps.length) },
});
const NOW = new Date("2026-10-20T10:00:00Z");
const envelope = {
  signer: DEV.ALICE,
  nonce: 5,
  mortalityBlocks: 64,
  checkpoint: { number: 126000, hash: `0x${"ab".repeat(32)}` },
  expiresAt: "2026-10-20T10:30:00Z",
};

/**
 * Strict proof-size mode (requireMeasuredProofSize: true), as any real testnet deploy or revive.call runs it.
 * Without a measured callInfoProofSize the gate blocks (PROOF_SIZE_CALL_INFO_MISSING); with one strictly above the
 * step cap it passes. The callInfo value here is SYNTHETIC example data, not a chain reading.
 */
export function strictProofSize(g, facts, callInfoProofSize) {
  const run = (pf) =>
    gatePolicy(
      {
        policy: g.policy,
        plan: g.plan,
        facts,
        preflight: pf,
        manifest: g.manifest,
        liveFacts: facts,
      },
      { envelope, now: NOW, requirePlanVerified: true, requireMeasuredProofSize: true },
    );
  const missing = run(preflightFor(g.plan));
  const measured = run(preflightFor(g.plan, { callInfoProofSize }));
  return {
    callInfoProofSize,
    withoutCallInfo: { allowed: missing.allowed, codes: codesOf(missing) },
    withCallInfo: { allowed: measured.allowed, codes: codesOf(measured) },
  };
}

// Stable codes from gatePolicy's blockedBy (e.g. RECIPIENT_NOT_ALLOWED, PLAN_BYTES_MISMATCH).
export const codesOf = (gr) => [...new Set(gr.blockedBy.map((x) => x.code))];

// The pre-sign gate the console uses before the wallet opens. requirePlanVerified: true makes it fail closed on
// call bytes when the policy build has Sentinel's pre-sign verifyPlan (a74ad38); older builds ignore the option.
const presignGate = (input) =>
  gatePolicy(
    { ...input, liveFacts: input.facts },
    { envelope, now: NOW, requirePlanVerified: true },
  );

function gate(id, params, policyInput, facts, opts) {
  const inst = instantiateTemplate(id, params, facts, opts);
  if (!inst.ok) return { inst };
  const manifest = inst.manifest;
  const plan = compile(manifest, facts, opts);
  const policy = definePolicy(policyInput);
  const preflight = preflightFor(plan);
  const gr = presignGate({ policy, plan, facts, preflight, manifest });
  // createApproval needs the engine's own result object (it rejects hand-built ones).
  const result = gr.result ?? evaluatePolicy({ policy, plan, facts, preflight, manifest });
  return { inst, manifest, plan, policy, preflight, result, gr };
}

function approve(g, facts, plan = g.plan) {
  return createApproval({
    manifestDigest: plan.manifestDigest,
    plan,
    envelope,
    preflight: g.preflight,
    policy: g.policy,
    policyResult: g.result,
    fingerprint: facts.fingerprint,
    now: NOW,
    manifest: g.manifest,
    liveFacts: facts,
    requirePlanVerified: true,
  });
}

/**
 * Runs one template end to end and returns a JSON-able summary. Spec fields:
 *  id, params, policy (deny-by-default, allowing only this action), opts (compile options),
 *  block: { what, params?, policy? } (one violation the gate must block),
 *  edit: params whose plan is spliced into the approved one (the "edited plan" attack),
 *  extra?: (ctx) => object  (template-specific checks, e.g. checkDeployStep)
 */
export function runTemplate(spec, { quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const facts = v3Facts();
  const opts = spec.opts ?? {};
  const info = listTemplates().find((t) => t.id === spec.id);
  log(`\n=== ${info.id}: ${info.title} (requested mode: ${info.mode}) ===`);
  log(
    `required: ${info.params
      .filter((p) => !p.optional)
      .map((p) => p.name)
      .join(", ")}`,
  );
  if (info.note) log(`note: ${info.note}`);
  const out = { id: spec.id, offline: true, signed: false, submitted: false };

  // 1. Unfilled placeholder: the skeleton has "{{name}}" markers; filling one param with it is rejected.
  const skeleton = templateSkeleton(spec.id);
  const firstParam = info.params[0].name;
  const unfilled = instantiateTemplate(spec.id, {
    ...spec.params,
    [firstParam]: `{{${firstParam}}}`,
  });
  out.placeholder = {
    skeletonHasPlaceholder: PLACEHOLDER.test(skeleton),
    rejected: !unfilled.ok,
    codes: unfilled.ok ? [] : [...new Set(unfilled.issues.map((i) => i.code))],
    paths: unfilled.ok ? [] : unfilled.issues.map((i) => i.path),
  };
  log(
    `[error] unfilled ${firstParam}: rejected=${out.placeholder.rejected} codes=${out.placeholder.codes.join(",")} at ${out.placeholder.paths.join(",")}`,
  );

  // 2. Honest run: fill -> serializeManifest/parseManifest (inside instantiateTemplate) -> compile on V3 facts.
  const g = gate(spec.id, spec.params, spec.policy, facts, opts);
  if (!g.inst.ok) throw new Error(`${spec.id}: ${JSON.stringify(g.inst.issues)}`);
  const v = verifyPlan(g.manifest, g.plan, facts, opts);
  const ap = approve(g, facts);
  out.mode = g.plan.mode;
  out.steps = g.plan.steps.length;
  out.planDigest = g.plan.planDigest;
  out.manifestDigest = g.plan.manifestDigest;
  out.specVersion = facts.fingerprint.specVersion;
  out.policyAllowed = g.gr.allowed;
  out.policyBlockers = codesOf(g.gr);
  out.verifyPlanOk = v.ok;
  out.approvalOk = ap.ok;
  log(`compiled on V3 spec ${out.specVersion} (offline): mode=${out.mode} steps=${out.steps}`);
  for (const s of g.plan.steps)
    log(`  step ${s.actionId}: ${s.kind} -> ${s.encodedCall.slice(0, 26)}…`);
  log(`planDigest: ${out.planDigest}`);
  log(`policy (deny-by-default, only this action): allowed=${out.policyAllowed}`);
  if (!out.policyAllowed) for (const x of g.gr.blockedBy) log(`  ${x.code}: ${x.message}`);
  log(`verifyPlan(manifest, plan, liveFacts): ok=${v.ok}`);
  log(`createApproval(requirePlanVerified: true): ok=${ap.ok}${ap.ok ? "" : ` (${ap.reason})`}`);
  if (out.mode === "atomic_unverified")
    log(
      "label: atomic_unverified. Atomicity is REQUESTED, not proven: no rollback proof for this runtime is in the facts.",
    );

  // 3. Policy block.
  const b = gate(
    spec.id,
    { ...spec.params, ...(spec.block.params ?? {}) },
    spec.block.policy ?? spec.policy,
    facts,
    opts,
  );
  out.policyBlock = {
    what: spec.block.what,
    allowed: b.gr.allowed,
    codes: codesOf(b.gr),
  };
  log(
    `[error] ${spec.block.what}: allowed=${b.result.allowed} blocked by ${out.policyBlock.codes.join(", ")}`,
  );

  // 4. Edited plan: steps compiled from a different manifest spliced in, digest recomputed so it looks consistent.
  const other = instantiateTemplate(spec.id, { ...spec.params, ...spec.edit }, facts, opts);
  if (!other.ok) throw new Error(`${spec.id} edit: ${JSON.stringify(other.issues)}`);
  const evil = compile(other.manifest, facts, opts);
  const forgedBody = { ...evil, manifestDigest: g.plan.manifestDigest };
  const forged = { ...forgedBody, planDigest: planDigest(forgedBody) };
  const fv = verifyPlan(g.manifest, forged, facts, opts);
  const fgate = presignGate({
    policy: g.policy,
    plan: forged,
    facts,
    preflight: g.preflight,
    manifest: g.manifest,
  });
  const fap = approve(g, facts, forged);
  out.editedPlan = {
    digestSelfConsistent: planDigest(forged) === forged.planDigest,
    verifyPlanOk: fv.ok,
    verifyPlanCodes: fv.ok ? [] : [...new Set(fv.issues.map((i) => i.code))],
    approvalOk: fap.ok,
    approvalReason: fap.ok ? null : fap.reason,
    // Pre-sign gate: PLAN_BYTES_MISMATCH once Sentinel's a74ad38 is in the build. Without it the gate (policy rules
    // only) still allows the forged plan, and createApproval / verifyPlan are what refuse it.
    gateAllowed: fgate.allowed,
    gateCodes: codesOf(fgate),
  };
  log(
    `[error] edited plan (digest recomputed): verifyPlan ok=${fv.ok} codes=${out.editedPlan.verifyPlanCodes.join(",")}; ` +
      `createApproval ok=${fap.ok}${fap.ok ? "" : ` (${fap.reason})`}; pre-sign gate allowed=${fgate.allowed}${fgate.allowed ? " (no plan_bytes check in this policy build)" : ` codes=${out.editedPlan.gateCodes.join(",")}`}`,
  );

  if (spec.extra)
    Object.assign(
      out,
      spec.extra({ g, facts, log, gate: (p, pol) => gate(spec.id, p, pol, facts, opts) }),
    );
  log(`summary: ${spec.summary(out)}`);
  log("nothing was signed or submitted; no network was used.");
  return out;
}

/** True when this module is the script node was started with. */
export const isMain = (url) => process.argv[1] && fileURLToPath(url) === process.argv[1];
