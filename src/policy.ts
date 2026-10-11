import type {
  AddressType, ExecutionMode, Manifest, Plan, PolicyResult, PolicyRuleResult, PreflightResult,
  RuntimeFacts, TypedAddress, Estimate,
} from "./types.js";
import { digest } from "./digest.js";
import { checkTypedAddress, normalizeAccount } from "./address.js";

export type AllowList = "any" | string[];

/** Rules an application sets. Amounts and limits are base-unit integer strings, never floats. */
export interface Policy {
  version: "seam/policy/v1";
  allowedCapabilities: AllowList;
  allowedAssets: AllowList;
  /** Contract addresses (SS58, AccountId32 hex or H160). */
  allowedContracts: AllowList;
  /** Recipient addresses (SS58, AccountId32 hex or H160). Prefix 42 is shared by many chains, so this list is the real guard. */
  allowedRecipients: AllowList;
  /** Max amount per asset id; "*" applies to any asset not listed. */
  maxAmountPerAsset?: Record<string, string>;
  /** Max native value (POT base units) sent with any step, e.g. to a contract. */
  maxNativeValue?: string;
  maxWeight?: string;
  maxFee?: string;
  maxStorageDeposit?: string;
  maxSteps?: number;
  allowedModes: ExecutionMode[];
  requireHumanApproval: boolean;
  maxApprovalSeconds: number;
  /** Which preflight unknowns may pass. Everything unknown is blocked unless listed here. Capabilities are never allowed when unknown. */
  allowUnknown: { fee?: boolean; weight?: boolean; storageDeposit?: boolean; dryRun?: boolean };
}

export const DEFAULT_POLICY: Policy = {
  version: "seam/policy/v1",
  allowedCapabilities: "any",
  allowedAssets: [],
  allowedContracts: [],
  allowedRecipients: [],
  maxSteps: 10,
  allowedModes: ["sequential", "atomic_verified"],
  requireHumanApproval: true,
  maxApprovalSeconds: 600,
  allowUnknown: {},
};

export function definePolicy(overrides: Partial<Policy> = {}): Policy {
  return { ...DEFAULT_POLICY, ...overrides, allowUnknown: { ...DEFAULT_POLICY.allowUnknown, ...overrides.allowUnknown } };
}

export function policyDigest(policy: Policy) {
  return digest("seam/policy/v1", policy);
}

/** Address types each action kind may use. H160 only belongs to Revive (Solidity) calls. */
const ADDRESS_TYPES: Record<string, AddressType[]> = {
  "assets.transfer": ["SS58", "AccountId32"],
  "assets.mint": ["SS58", "AccountId32"],
  "contracts.call": ["SS58", "AccountId32"],
  "nfts.mint": ["SS58", "AccountId32"],
  "revive.call": ["H160"],
};

const isUint = (s: string | undefined): s is string => typeof s === "string" && /^\d+$/.test(s);

function inList(list: AllowList, value: string, normalize = false): boolean {
  if (list === "any") return true;
  if (!normalize) return list.includes(value);
  const v = normalizeAccount(value) ?? value;
  return list.some((x) => (normalizeAccount(x) ?? x) === v);
}

export interface PolicyInput {
  policy: Policy;
  plan: Plan;
  facts: RuntimeFacts;
  preflight?: PreflightResult;
  /** When given, typed addresses in the Manifest are checked too (attack case 5). */
  manifest?: Manifest;
}

/**
 * Checks a compiled plan against the policy. Every rule reports pass, block or unknown with a plain reason;
 * the result is allowed only if no rule blocks and every unknown was explicitly allowed by the policy.
 */
export function evaluatePolicy({ policy, plan, facts, preflight, manifest }: PolicyInput): PolicyResult {
  const rules: PolicyRuleResult[] = [];
  const pass = (rule: string, reason: string, actionId?: string) => rules.push({ rule, outcome: "pass", reason, actionId });
  const block = (rule: string, reason: string, actionId?: string) => rules.push({ rule, outcome: "block", reason, actionId });
  const unknown = (rule: string, reason: string, allowed: boolean, actionId?: string) =>
    rules.push({ rule, outcome: allowed ? "pass" : "unknown", reason: allowed ? `${reason} (allowed by policy)` : reason, actionId });

  // Runtime: the plan must be for the runtime we see now.
  if (plan.fingerprintDigest !== facts.fingerprint.digest) {
    block("runtime_match", "Blocked: the runtime changed since this plan was compiled. Rediscover and recompile.");
  } else pass("runtime_match", "plan was compiled against the current runtime");

  // Whole-plan availability and mode.
  if (plan.mode === "unavailable") {
    const why = plan.steps.filter((s) => s.status === "unavailable").map((s) => `${s.actionId}: ${s.reason ?? "unavailable"}`);
    block("plan_available", `Blocked: the plan can't run on this chain (${why.join("; ") || "no reason given"}).`);
  } else if (!policy.allowedModes.includes(plan.mode)) {
    block("mode_allowed", `Blocked: execution mode ${plan.mode} is not allowed by policy (allowed: ${policy.allowedModes.join(", ")}).`);
  } else if (plan.mode === "atomic_verified" &&
    facts.behaviour.find((b) => b.id === "batch_all_rollback")?.status !== "confirmed") {
    block("mode_allowed", "Blocked: atomic_verified needs batch_all rollback to be confirmed on this chain, and it isn't.");
  } else pass("mode_allowed", `execution mode ${plan.mode} is allowed`);

  if (policy.maxSteps !== undefined && plan.steps.length > policy.maxSteps) {
    block("max_steps", `Blocked: the plan has ${plan.steps.length} steps, more than the limit of ${policy.maxSteps}.`);
  }
  if (plan.steps.length === 0) block("plan_available", "Blocked: the plan has no steps.");

  // Signer must match the Manifest.
  if (manifest && (normalizeAccount(manifest.signer.value) ?? manifest.signer.value) !== (normalizeAccount(plan.signer) ?? plan.signer)) {
    block("signer_match", "Blocked: the plan's signer is not the signer named in the Manifest.");
  }

  const capById = new Map(facts.capabilities.map((c) => [c.id, c]));
  const amountLimits = policy.maxAmountPerAsset;

  for (const step of plan.steps) {
    const id = step.actionId;
    if (step.status !== "ok") { block("step_available", `Blocked: ${step.reason ?? "this step is unavailable"}.`, id); continue; }

    const cap = capById.get(step.capability);
    if (!cap || cap.status === "not_observed") {
      block("capability", `Blocked: ${step.capability} is not available on this chain.`, id);
    } else if (cap.status === "unknown") {
      block("capability", `Blocked: SEAM couldn't confirm ${step.capability} exists on this chain, and unknown capabilities are never allowed.`, id);
    } else if (!inList(policy.allowedCapabilities, step.capability)) {
      block("capability", `Blocked: ${step.capability} is not on the policy's allowed list.`, id);
    } else pass("capability", `${step.capability} is observed and allowed`, id);

    const d = step.decoded;
    if (d.assetId !== undefined) {
      if (!inList(policy.allowedAssets, d.assetId)) block("asset_allowed", `Blocked: asset ${d.assetId} is not on the allowed list.`, id);
      else pass("asset_allowed", `asset ${d.assetId} is allowed`, id);
    }
    if (d.recipient !== undefined) {
      if (!inList(policy.allowedRecipients, d.recipient, true)) block("recipient_allowed", `Blocked: recipient ${d.recipient} is not on the allowed list.`, id);
      else pass("recipient_allowed", "recipient is allowed", id);
    }
    if (d.contract !== undefined) {
      if (!inList(policy.allowedContracts, d.contract, true)) block("contract_allowed", `Blocked: contract ${d.contract} is not on the allowed list.`, id);
      else pass("contract_allowed", "contract is allowed", id);
    }
    if (d.amount !== undefined) {
      if (!isUint(d.amount)) block("amount_limit", `Blocked: amount "${d.amount}" is not a whole number of base units.`, id);
      else if (amountLimits) {
        const limit = (d.assetId !== undefined ? amountLimits[d.assetId] : undefined) ?? amountLimits["*"];
        if (limit === undefined) block("amount_limit", `Blocked: no amount limit is set for asset ${d.assetId ?? "(none)"}.`, id);
        else if (BigInt(d.amount) > BigInt(limit)) block("amount_limit", `Blocked: amount ${d.amount} is over the limit of ${limit} for asset ${d.assetId ?? "*"}.`, id);
        else pass("amount_limit", `amount ${d.amount} is within the limit of ${limit}`, id);
      }
    }
    if (d.value !== undefined) {
      if (!isUint(d.value)) block("native_value_limit", `Blocked: value "${d.value}" is not a whole number of base units.`, id);
      else if (policy.maxNativeValue !== undefined && BigInt(d.value) > BigInt(policy.maxNativeValue)) {
        block("native_value_limit", `Blocked: sends ${d.value} POT base units, over the limit of ${policy.maxNativeValue}.`, id);
      }
    }
  }

  // Typed addresses from the Manifest (wrong type, bad checksum, wrong network prefix).
  if (manifest) {
    const sig = checkTypedAddress(manifest.signer, facts.fingerprint.ss58Prefix, ["SS58", "AccountId32"]);
    if (!sig.ok) block("address_check", `Blocked: signer address: ${sig.reason}.`);
    for (const action of manifest.actions) {
      const allowed = ADDRESS_TYPES[action.kind] ?? ["SS58", "AccountId32"];
      for (const [arg, v] of Object.entries(action.args)) {
        if (typeof v !== "object" || v === null) continue;
        const r = checkTypedAddress(v as TypedAddress, facts.fingerprint.ss58Prefix, allowed);
        if (!r.ok) block("address_check", `Blocked: ${arg}: ${r.reason}.`, action.id);
      }
    }
  }

  // Preflight: real estimates from the node; unknowns block unless the policy allows them.
  if (!preflight) {
    unknown("preflight", "No preflight result was given, so fees, weight and dry runs are unknown.", false);
  } else {
    const limitCheck = (rule: string, label: string, est: Estimate, max: string | undefined, allowUnknown: boolean | undefined, id?: string) => {
      if (est.unknown || est.value === undefined) { unknown(rule, `${label} is unknown`, !!allowUnknown, id); return; }
      if (!isUint(est.value)) { block(rule, `Blocked: ${label} "${est.value}" is not a whole number.`, id); return; }
      if (max !== undefined && BigInt(est.value) > BigInt(max)) block(rule, `Blocked: ${label} ${est.value} is over the limit of ${max}.`, id);
      else pass(rule, `${label} ${est.value} is within limits`, id);
    };
    const planIds = new Set(plan.steps.map((s) => s.actionId));
    for (const id of planIds) {
      if (!preflight.steps.some((p) => p.actionId === id)) unknown("preflight", "No preflight was run for this step.", false, id);
    }
    for (const p of preflight.steps) {
      if (!planIds.has(p.actionId)) { block("preflight", "Blocked: preflight includes a step that isn't in the plan.", p.actionId); continue; }
      limitCheck("weight_limit", "weight", p.weight, policy.maxWeight, policy.allowUnknown.weight, p.actionId);
      limitCheck("storage_limit", "storage deposit", p.storageDeposit, policy.maxStorageDeposit, policy.allowUnknown.storageDeposit, p.actionId);
      if (p.dryRun === "failed") block("dry_run", `Blocked: the dry run failed${p.note ? ` (${p.note})` : ""}.`, p.actionId);
      else if (p.dryRun === "unknown") unknown("dry_run", "The dry run result is unknown.", !!policy.allowUnknown.dryRun, p.actionId);
      else pass("dry_run", "dry run succeeded", p.actionId);
    }
    limitCheck("fee_limit", "total fee", preflight.totalFee, policy.maxFee, policy.allowUnknown.fee);
  }

  const allowed = rules.every((r) => r.outcome === "pass");
  return { allowed, rules, policyDigest: policyDigest(policy) };
}

/** First blocking or unknown reason, for short messages. */
export function firstBlockReason(result: PolicyResult): string | undefined {
  return result.rules.find((r) => r.outcome !== "pass")?.reason;
}
