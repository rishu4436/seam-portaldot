import type { Estimate, Manifest, Plan, PlanMode, PolicyResult, PolicyRuleResult, PreflightResult, RuntimeFacts, Hex } from "./types.js";
import { digest } from "./digest.js";
import { checkAddressFor, normalizeAccount } from "./address.js";
import { fingerprintDigest } from "./runtimeLock.js";

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
  /** Optional: allowed 4-byte message selectors per contract (key: contract address). */
  allowedSelectors?: Record<string, string[]>;
  /**
   * Optional: allowed contract message names per contract (key: contract address), e.g. { [addr]: ["settle"] }.
   * Needs the plan step to carry contractMessage (a contracts.call written with `message` and an ABI); a raw-`data`
   * call has no name, so it is blocked for a contract listed here.
   */
  allowedMessages?: Record<string, string[]>;
  /** Optional: required ABI hash per contract (key: contract address). A call using any other ABI, or none, is blocked. */
  pinnedAbiHashes?: Record<string, string>;
  /** Max amount per asset id; "*" applies to any asset not listed. */
  maxAmountPerAsset?: Record<string, string>;
  /** Max native value (POT base units) sent with any step, e.g. to a contract. */
  maxNativeValue?: string;
  /** Max gasLimit a contract call may set (it's inside the plan digest). */
  maxGasLimit?: string;
  /** Max computation weight (refTime) per step from preflight. */
  maxWeight?: string;
  /** Max proof size per step: from preflight, and any proofSize a contract call sets. Two-part-weight runtimes only. */
  maxProofSize?: string;
  maxFee?: string;
  maxStorageDeposit?: string;
  maxSteps?: number;
  allowedModes: PlanMode[];
  requireHumanApproval: boolean;
  maxApprovalSeconds: number;
  /** Require a successful system_dryRun of the signed transaction(s) at the submit gate. A failed one always blocks. */
  requireSignedDryRun: boolean;
  /** Which preflight unknowns may pass. Unknown capabilities are never allowed. */
  allowUnknown: { fee?: boolean; weight?: boolean; storageDeposit?: boolean; dryRun?: boolean; proofSize?: boolean };
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
  requireSignedDryRun: true,
  allowUnknown: {},
};

/**
 * Starting point for today's Portaldot runtime: it never reports a storage deposit, and a real dry run needs the
 * signed transaction, so both are allowed as unknown before signing; the submit gate then requires the dry run of
 * the signed transaction to succeed.
 */
export function portaldotPolicy(overrides: Partial<Policy> = {}): Policy {
  return definePolicy({ ...overrides, allowUnknown: { storageDeposit: true, dryRun: true, ...overrides.allowUnknown } });
}

export function definePolicy(overrides: Partial<Policy> = {}): Policy {
  return { ...DEFAULT_POLICY, ...overrides, allowUnknown: { ...DEFAULT_POLICY.allowUnknown, ...overrides.allowUnknown } };
}

export function policyDigest(policy: Policy): Hex {
  return digest("seam/policy/v1", policy);
}

/** Same value as the compiler's computePlanDigest. */
export function planDigest(plan: Plan): Hex {
  const { planDigest: _ignored, ...rest } = plan;
  return digest("seam/plan/v1", rest);
}

const isUint = (s: string | undefined): s is string => typeof s === "string" && /^\d+$/.test(s);
const hex2 = (n: number) => n.toString(16).padStart(2, "0");

function forContract<T>(map: Record<string, T> | undefined, contract: string): T | undefined {
  if (!map) return undefined;
  const c = normalizeAccount(contract) ?? contract.toLowerCase();
  return Object.entries(map).find(([k]) => (normalizeAccount(k) ?? k.toLowerCase()) === c)?.[1];
}

function inList(list: AllowList, value: string, normalize = false): boolean {
  if (list === "any") return true;
  if (!normalize) return list.includes(value);
  const v = normalizeAccount(value) ?? value.toLowerCase();
  return list.some((x) => (normalizeAccount(x) ?? x.toLowerCase()) === v);
}

export interface PolicyInput {
  policy: Policy;
  plan: Plan;
  facts: RuntimeFacts;
  preflight?: PreflightResult;
  /** When given, the plan must belong to this Manifest and its signer. */
  manifest?: Manifest;
}

/**
 * Checks a compiled plan against the policy. Each rule reports pass, block or unknown with a plain reason.
 * The result is allowed only if nothing blocks and every unknown was explicitly allowed by the policy.
 */
export function evaluatePolicy({ policy, plan, facts, preflight, manifest }: PolicyInput): PolicyResult {
  const rules: PolicyRuleResult[] = [];
  const pass = (rule: string, reason: string, actionId?: string) => rules.push({ rule, outcome: "pass", reason, actionId });
  const block = (rule: string, reason: string, actionId?: string) => rules.push({ rule, outcome: "block", reason, actionId });
  const unknown = (rule: string, reason: string, allowed: boolean, actionId?: string) =>
    rules.push(allowed
      ? { rule, outcome: "pass", reason: `${reason} (allowed by policy, weaker proof)`, actionId, weak: true }
      : { rule, outcome: "unknown", reason, actionId });

  // Integrity: the plan wasn't edited after compiling, and belongs to this Manifest.
  if (planDigest(plan) !== plan.planDigest) block("plan_integrity", "Blocked: the plan was changed after it was compiled (its digest doesn't match).");
  else pass("plan_integrity", "plan digest matches its contents");
  if (manifest) {
    if (digest("seam/manifest/v1", manifest) !== plan.manifestDigest) block("manifest_match", "Blocked: this plan was compiled from a different Manifest.");
    const mSigner = normalizeAccount(manifest.signer.value) ?? manifest.signer.value.toLowerCase();
    if (mSigner !== plan.signer.publicKey.toLowerCase()) block("signer_match", "Blocked: the plan's signer is not the signer named in the Manifest.");
  }

  // Runtime: the plan must be for the runtime we see now, and the facts must be self-consistent.
  const factsDigest = fingerprintDigest(facts.fingerprint);
  if (factsDigest !== facts.fingerprintDigest) block("runtime_match", "Blocked: the runtime facts don't match their own fingerprint digest.");
  else if (plan.fingerprintDigest !== factsDigest) block("runtime_match", "Blocked: the runtime changed since this plan was compiled. Rediscover and recompile.");
  else pass("runtime_match", "plan was compiled against the current runtime");

  // Mode.
  if (plan.mode === "unavailable") {
    block("plan_available", `Blocked: ${plan.modeReason}`);
  } else if (!policy.allowedModes.includes(plan.mode)) {
    block("mode_allowed", `Blocked: execution mode ${plan.mode} is not allowed by policy (allowed: ${policy.allowedModes.join(", ")}).`);
  } else if (plan.mode === "atomic_verified" && facts.behaviour.batchAllRollback !== "verified") {
    block("mode_allowed", "Blocked: atomic_verified needs batch_all rollback to be verified on this chain, and it isn't.");
  } else pass("mode_allowed", `execution mode ${plan.mode} is allowed`);
  if (plan.mode.startsWith("atomic") && !plan.outerCall) block("mode_allowed", "Blocked: an atomic plan has no batch call to sign.");
  if (plan.steps.length === 0) block("plan_available", "Blocked: the plan has no steps.");
  if (policy.maxSteps !== undefined && plan.steps.length > policy.maxSteps) {
    block("max_steps", `Blocked: the plan has ${plan.steps.length} steps, more than the limit of ${policy.maxSteps}.`);
  }

  const limits = policy.maxAmountPerAsset;
  for (const step of plan.steps) {
    const id = step.actionId;
    if (step.status !== "ok") { block("step_available", `Blocked: ${step.reason ?? "this step is unavailable"}.`, id); continue; }

    const cap = facts.capabilities[step.capability];
    if (!cap || cap.status === "not_observed") block("capability", `Blocked: ${step.capability} is not available on this chain.`, id);
    else if (cap.status === "unknown") block("capability", `Blocked: SEAM couldn't confirm ${step.capability} exists on this chain, and unknown capabilities are never allowed.`, id);
    else if (!inList(policy.allowedCapabilities, step.capability)) block("capability", `Blocked: ${step.capability} is not on the policy's allowed list.`, id);
    else if (cap.palletIndex !== step.palletIndex || cap.callIndex !== step.callIndex) block("call_index", `Blocked: the step's call index doesn't match ${step.capability} on this runtime.`, id);
    else if (!step.encodedCall || !step.encodedCall.toLowerCase().startsWith("0x" + hex2(step.palletIndex!) + hex2(step.callIndex!))) {
      block("call_index", `Blocked: the encoded call doesn't start with ${step.capability}'s index.`, id);
    } else pass("capability", `${step.capability} is observed and allowed`, id);

    const d = step.decodedArgs;
    const h160 = step.kind === "revive.call";
    for (const key of ["recipient", "contract"] as const) {
      if (d[key] === undefined) continue;
      const r = checkAddressFor(d[key]!, h160 && key === "contract", facts.fingerprint.ss58Prefix);
      if (!r.ok) block("address_check", `Blocked: ${key}: ${r.reason}.`, id);
    }
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
      else {
        pass("contract_allowed", "contract is allowed", id);
        const sel = policy.allowedSelectors && Object.entries(policy.allowedSelectors)
          .find(([c]) => (normalizeAccount(c) ?? c.toLowerCase()) === (normalizeAccount(d.contract!) ?? d.contract!.toLowerCase()));
        if (sel) {
          const s = (d.data ?? "").toLowerCase().slice(0, 10);
          if (!sel[1].map((x) => x.toLowerCase()).includes(s)) block("selector_allowed", `Blocked: contract message ${s || "(none)"} is not on the allowed list for this contract.`, id);
          else pass("selector_allowed", `contract message ${s} is allowed`, id);
        }
        // The compiler records the name and interface hash in step.contractMessage; decodedArgs.message / abiHash are read too.
        const dm = d as Record<string, string | undefined>;
        const cm = step.contractMessage ?? (dm.message !== undefined || dm.abiHash !== undefined
          ? { message: dm.message as string, abiHash: dm.abiHash as string } : undefined);
        const names = forContract(policy.allowedMessages, d.contract);
        if (names) {
          if (!cm || cm.message === undefined) block("message_not_allowed", "Blocked: this contract only allows named messages, and this call has no message name (it was written as raw data).", id);
          else if (!names.includes(cm.message)) block("message_not_allowed", `Blocked: contract message "${cm.message}" is not on the allowed list for this contract (allowed: ${names.join(", ") || "none"}).`, id);
          else pass("message_allowed", `contract message "${cm.message}" is allowed`, id);
        }
        const pinned = forContract(policy.pinnedAbiHashes, d.contract);
        if (pinned !== undefined) {
          if (!cm || cm.abiHash === undefined) block("abi_hash_missing", "Blocked: this contract's interface is pinned, and this call carries no interface (ABI) to check it against.", id);
          else if (cm.abiHash.toLowerCase() !== pinned.toLowerCase()) block("abi_hash_mismatch", `Blocked: this call's contract interface hash ${cm.abiHash} is not the pinned ${pinned}.`, id);
          else pass("abi_pinned", "contract interface (ABI) matches the pinned hash", id);
        }
      }
    }
    if (d.amount !== undefined) {
      if (!isUint(d.amount)) block("amount_limit", `Blocked: amount "${d.amount}" is not a whole number of base units.`, id);
      else if (limits) {
        const limit = (d.assetId !== undefined ? limits[d.assetId] : undefined) ?? limits["*"];
        if (limit === undefined) block("amount_limit", `Blocked: no amount limit is set for asset ${d.assetId ?? "(none)"}.`, id);
        else if (BigInt(d.amount) > BigInt(limit)) block("amount_limit", `Blocked: amount ${d.amount} is over the limit of ${limit} for asset ${d.assetId ?? "*"}.`, id);
        else pass("amount_limit", `amount ${d.amount} is within the limit of ${limit}`, id);
      }
    }
    const capCheck = (rule: string, label: string, v: string | undefined, max: string | undefined) => {
      if (v === undefined) return;
      if (!isUint(v)) block(rule, `Blocked: ${label} "${v}" is not a whole number.`, id);
      else if (max !== undefined && BigInt(v) > BigInt(max)) block(rule, `Blocked: ${label} ${v} is over the limit of ${max}.`, id);
    };
    capCheck("native_value_limit", "native value", d.value, policy.maxNativeValue);
    capCheck("gas_limit", "gas limit", d.gasLimit, policy.maxGasLimit);
    capCheck("proof_size_limit", "proof size limit", d.proofSize, policy.maxProofSize);
    // storageDepositLimit: null means the developer chose "no limit" (Bot 2's compiler never defaults to it).
    const sdl = (d as Record<string, string | null | undefined>).storageDepositLimit;
    if (sdl === null) {
      if (policy.maxStorageDeposit !== undefined) block("storage_limit", `Blocked: this contract call sets no storage deposit limit, so it can't be kept under the policy's limit of ${policy.maxStorageDeposit}.`, id);
      else pass("storage_limit", "no storage deposit limit set, and the policy sets none either", id);
    } else capCheck("storage_limit", "storage deposit limit", sdl, policy.maxStorageDeposit);
  }

  // Preflight: real estimates from the node. Unknowns block unless the policy allows them.
  if (!preflight) {
    unknown("preflight", "No preflight result was given, so fees, weight and dry runs are unknown.", false);
  } else {
    const est = (rule: string, label: string, e: Estimate, max: string | undefined, allow: boolean | undefined, id?: string) => {
      if (e.unknown || e.value === undefined) { unknown(rule, `${label} is unknown`, !!allow, id); return; }
      if (!isUint(e.value)) { block(rule, `Blocked: ${label} "${e.value}" is not a whole number.`, id); return; }
      if (max !== undefined && BigInt(e.value) > BigInt(max)) block(rule, `Blocked: ${label} ${e.value} is over the limit of ${max}.`, id);
      else pass(rule, `${label} ${e.value} is within limits`, id);
    };
    const planIds = new Set(plan.steps.map((s) => s.actionId));
    for (const id of planIds) if (!preflight.steps.some((p) => p.actionId === id)) unknown("preflight", "No preflight was run for this step.", false, id);
    for (const p of preflight.steps) {
      if (!planIds.has(p.actionId)) { block("preflight", "Blocked: preflight includes a step that isn't in the plan.", p.actionId); continue; }
      est("weight_limit", "weight", p.weight, policy.maxWeight, policy.allowUnknown.weight, p.actionId);
      est("storage_limit", "storage deposit", p.storageDeposit, policy.maxStorageDeposit, policy.allowUnknown.storageDeposit, p.actionId);
      if (policy.maxProofSize !== undefined) {
        // A contract call's own proofSize limit already bounds what it can use (checked above), and the node's
        // estimate for it mostly echoes that limit, so the estimate isn't checked again for those steps.
        const own = plan.steps.find((s) => s.actionId === p.actionId)?.decodedArgs.proofSize;
        if (own !== undefined && own !== null) pass("proof_size_limit", `proof size is bounded by the call's own limit of ${own}`, p.actionId);
        else est("proof_size_limit", "proof size", p.proofSize ?? { unknown: true }, policy.maxProofSize, policy.allowUnknown.proofSize, p.actionId);
      }
      if (p.dryRun === "failed") block("dry_run", `Blocked: the dry run failed${p.note ? ` (${p.note})` : ""}.`, p.actionId);
      else if (p.dryRun === "unknown") unknown("dry_run", "The dry run result is unknown.", !!policy.allowUnknown.dryRun, p.actionId);
      else pass("dry_run", "dry run succeeded", p.actionId);
    }
    est("fee_limit", "total fee", preflight.totalFee, policy.maxFee, policy.allowUnknown.fee);
  }

  const weak = rules.filter((r) => r.weak).map((r) => (r.actionId ? `${r.rule}:${r.actionId}` : r.rule));
  return { allowed: rules.every((r) => r.outcome === "pass"), rules, policyDigest: policyDigest(policy), ...(weak.length ? { weakProof: weak } : {}) };
}

/** First blocking or unknown reason, for short messages. */
export function firstBlockReason(result: PolicyResult): string | undefined {
  return result.rules.find((r) => r.outcome !== "pass")?.reason;
}
