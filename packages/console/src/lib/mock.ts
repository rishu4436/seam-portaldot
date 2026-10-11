// EXAMPLE DATA. Call indexes are real (Bot 2 compiler on spec 1002). Runtime fingerprint fields come from Bot 4's real read-only
// snapshot of wss://mainnet.portaldot.io (block 2,721,455). Digests, hashes,
// fees and addresses below are placeholders until the SDK is wired in.
import type { Manifest, Plan, PolicyResult, PreflightResult, Receipt, RuntimeFacts, SigningEnvelope, Approval } from "./types";

const h = (seed: string): `0x${string}` => {
  let x = 2166136261;
  let out = "";
  for (let i = 0; i < 64; i++) {
    x ^= seed.charCodeAt(i % seed.length) + i;
    x = Math.imul(x, 16777619) >>> 0;
    out += (x & 15).toString(16);
  }
  return `0x${out}`;
};

export const EXAMPLE_SIGNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"; // well-known dev account (Alice)
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

export function discover(endpoint: string, upgraded = false): RuntimeFacts {
  const specVersion = upgraded ? 1003 : 1002;
  return {
    endpoint,
    discoveredAtBlock: upgraded ? 2721502 : 2721455,
    fingerprint: {
      genesisHash: "0x83b5212c69f85f3996f8696bb35bf913af51b176a5f53d0a74fd3a83dc0b8a54",
      specName: "portaldot",
      specVersion,
      transactionVersion: 2,
      metadataHash: upgraded ? h("meta-upgraded") : "0x8b91f644a913a1008086c2e0732a8a2184c1da79909e9384d432c3c5ffac5150",
      metadataVersion: 13,
      typesFileHash: h("types-v1"),
      ss58Prefix: 42,
      tokenSymbol: "POT",
      tokenDecimals: 14,
      digest: h(`fp-${specVersion}`),
    },
    capabilities: [
      { id: "Assets.transfer_keep_alive", status: "observed", pallet: "Assets", callIndex: [26, 6], argTypesPartial: true },
      { id: "Assets.mint", status: "observed", pallet: "Assets", callIndex: [26, 3], argTypesPartial: true },
      { id: "Contracts.call", status: "observed", pallet: "Contracts", callIndex: [13, 0], argTypesPartial: true },
      { id: "Utility.batch_all", status: "observed", pallet: "Utility", callIndex: [1, 2], argTypesPartial: true },
      { id: "Revive.call", status: "not_observed" },
      { id: "Nfts.mint", status: "not_observed" },
    ],
    behaviour: [
      { id: "batch_all_rollback", status: "unknown", note: "Needs a real test run on a dev node or testnet." },
      { id: "fee_estimate", status: "confirmed", note: "payment_queryInfo is available." },
      { id: "contract_dry_run", status: "confirmed", note: "contracts_call is available." },
      { id: "storage_deposit", status: "unknown" },
    ],
  };
}

export const DEMO_CONTRACT = "5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL";

export function demoManifest(withNft: boolean): Manifest {
  const actions: Manifest["actions"] = [
    { id: "pay", kind: "assets.transfer", requires: "Assets.transfer_keep_alive", args: { assetId: "1", amount: "2500000000000000", recipient: { type: "SS58", value: BOB, ss58Prefix: 42 } } },
    { id: "settle", kind: "contracts.call", requires: "Contracts.call", args: { contract: { type: "SS58", value: DEMO_CONTRACT, ss58Prefix: 42 }, value: "0", gasLimit: "5000000000", data: "0x633aa551" } },
    withNft
      ? { id: "receipt", kind: "nfts.mint", requires: "Nfts.mint", args: { collection: "7", item: "1", owner: { type: "SS58", value: EXAMPLE_SIGNER, ss58Prefix: 42 } } }
      : { id: "receipt", kind: "assets.mint", requires: "Assets.mint", args: { assetId: "2", amount: "1", recipient: { type: "SS58", value: EXAMPLE_SIGNER, ss58Prefix: 42 } } },
  ];
  return { version: "seam/manifest/v1", expectedChain: { genesisHash: "0x83b5212c69f85f3996f8696bb35bf913af51b176a5f53d0a74fd3a83dc0b8a54", specVersion: 1002 }, signer: { type: "SS58", value: EXAMPLE_SIGNER, ss58Prefix: 42 }, preferredMode: "sequential", actions };
}

export function manifestDigest(m: Manifest) { return h("manifest" + JSON.stringify(m)); }

export function compile(m: Manifest, facts: RuntimeFacts): Plan {
  const steps = m.actions.map((a) => {
    const cap = facts.capabilities.find((c) => c.id === a.requires);
    const ok = cap?.status === "observed";
    const addr = (k: string) => { const v = a.args[k]; return typeof v === "object" ? v.value : undefined; };
    return {
      actionId: a.id,
      capability: a.requires,
      callIndex: ok ? cap!.callIndex : undefined,
      encodedCall: ok ? h("call" + a.id + facts.fingerprint.digest) : undefined,
      decoded: { assetId: a.args.assetId as string | undefined, amount: a.args.amount as string | undefined, recipient: addr("recipient") ?? addr("beneficiary") ?? addr("owner"), contract: addr("contract"), value: a.args.value as string | undefined },
      status: ok ? ("ok" as const) : ("unavailable" as const),
      reason: ok ? undefined : `${a.requires} is ${cap?.status === "unknown" ? "unknown" : "not observed"} on this runtime (spec ${facts.fingerprint.specVersion}), so this step can't run here.`,
    };
  });
  const unavailable = steps.some((s) => s.status === "unavailable");
  const md = manifestDigest(m);
  return { manifestDigest: md, fingerprintDigest: facts.fingerprint.digest, signer: m.signer.value, mode: unavailable ? "unavailable" : "sequential", steps, digest: h("plan" + md + facts.fingerprint.digest) };
}

export function preflight(plan: Plan): PreflightResult {
  return {
    steps: plan.steps.map((s, i) => ({ actionId: s.actionId, weight: { value: `${(180 + i * 95).toLocaleString()}M` }, fee: { value: (0.0124 + i * 0.0031).toFixed(4) + " POT" }, storageDeposit: s.capability === "Contracts.call" ? { unknown: true } : { value: "0 POT" }, dryRun: s.status === "ok" ? "ok" : "unknown", note: s.capability === "Contracts.call" ? "Storage deposit couldn't be estimated; policy allows this unknown." : undefined })),
    totalFee: { value: "0.0465 POT" },
  };
}

export function checkPolicy(plan: Plan): PolicyResult {
  const rules: PolicyResult["rules"] = [
    { rule: "capability_allowed", outcome: "pass", reason: "Every requested capability is on the allowed list." },
    { rule: "asset_allowed", outcome: "pass", reason: "Assets 1 and 2 are allowed.", actionId: "pay" },
    { rule: "contract_allowed", outcome: "pass", reason: "The settlement contract is on the allowed list.", actionId: "settle" },
    { rule: "amount_limit", outcome: "pass", reason: "25 units is under the 100 unit limit for asset 1.", actionId: "pay" },
    { rule: "unknown_storage_deposit", outcome: "pass", reason: "This policy allows an unknown storage deposit up to 1 POT.", actionId: "settle" },
    { rule: "mode_allowed", outcome: "pass", reason: "Sequential mode is allowed. Atomic unverified is off." },
  ];
  for (const s of plan.steps.filter((s) => s.status === "unavailable")) {
    rules.unshift({ rule: "capability_observed", outcome: "block", reason: s.reason ?? "Capability not observed.", actionId: s.actionId });
  }
  return { allowed: rules.every((r) => r.outcome !== "block"), rules, policyDigest: h("policy-v1") };
}

export function envelope(): SigningEnvelope {
  return { signer: EXAMPLE_SIGNER, nonce: 17, mortalityBlocks: 64, expiresAt: new Date(Date.now() + 6 * 60_000).toISOString() };
}

export function approve(plan: Plan, policy: PolicyResult, env: SigningEnvelope): Approval {
  return { hash: h("approval" + plan.digest + policy.policyDigest + env.nonce), covers: ["Manifest digest", "Plan digest", "Runtime fingerprint", "Policy digest and result", "Preflight result", "Signer, nonce, mortality and expiry"], expiresAt: env.expiresAt, used: false };
}

export function receipt(plan: Plan, policy: PolicyResult, approval: Approval, failAt?: string): Receipt {
  let stopped = false;
  const steps = plan.steps.map((s, i) => {
    if (stopped) return { actionId: s.actionId, status: "not_run" as const, events: [], verification: "unknown" as const, reason: "Not run, because an earlier step failed." };
    if (s.actionId === failAt) { stopped = true; return { actionId: s.actionId, status: "failed" as const, txHash: h("tx" + s.actionId), block: { number: 2721460 + i * 2, hash: h("blk" + i) }, events: ["System.ExtrinsicFailed"], verification: "not_verified" as const, reason: "The contract call reverted, so SEAM stopped before the next step." }; }
    const ev = s.capability.startsWith("Assets.transfer") ? ["Assets.Transferred", "System.ExtrinsicSuccess"] : s.capability === "Contracts.call" ? ["Contracts.ContractEmitted", "System.ExtrinsicSuccess"] : ["Assets.Issued", "System.ExtrinsicSuccess"];
    return { actionId: s.actionId, status: "finalized" as const, txHash: h("tx" + s.actionId), block: { number: 2721460 + i * 2, hash: h("blk" + i) }, events: ev, verification: "verified" as const, reason: s.capability === "Contracts.call" ? "The contract emitted the expected settlement event." : "Asset, amount and recipient match the plan." };
  });
  const confirmed = steps.filter((s) => s.verification === "verified").length;
  return { manifestDigest: plan.manifestDigest, planDigest: plan.digest, fingerprintDigest: plan.fingerprintDigest, policyDigest: policy.policyDigest, approvalHash: approval.hash, mode: plan.mode, steps, overall: confirmed === steps.length ? "verified" : confirmed > 0 ? "partial" : "not_verified", checks: { confirmed, expected: steps.length }, digest: h("receipt" + approval.hash + confirmed) };
}
