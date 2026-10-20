// Deploy rules for pallet-revive: instantiate_with_code and map_account.
//
// The compiler has no action kinds for these yet. Until it does, policy accepts plan steps with
//   kind "revive.instantiate_with_code" | "revive.map_account"
// and reads these decodedArgs (base-unit integer strings, hex, or SS58/AccountId32), ASSUMED NAMES for Forge to align:
//   revive.instantiate_with_code:
//     codeHash             0x + 64 hex, hash of the `code` bytes, computed by the compiler (never caller-supplied)
//     value                native value sent to the constructor, integer string
//     gasLimit             weight_limit.ref_time, integer string
//     proofSize            weight_limit.proof_size, integer string
//     storageDepositLimit  storage_deposit_limit, integer string (null / missing = no limit, always blocked here)
//   revive.map_account:
//     account              the account being mapped (pallet-revive maps the origin, so this must be the signer)
// Caps live on Policy.deploy (see DeployPolicy). Every missing or undecodable field blocks: fail closed.
import type { PlanStep, PolicyRuleResult, Hex } from "./types.js";
import { normalizeAccount } from "./address.js";

export const DEPLOY_KINDS = ["revive.instantiate_with_code", "revive.map_account"] as const;
export type DeployKind = (typeof DEPLOY_KINDS)[number];
export const isDeployKind = (k: string): k is DeployKind =>
  (DEPLOY_KINDS as readonly string[]).includes(k);

export interface DeployPolicy {
  /** Code hashes instantiate_with_code may deploy. Missing or empty = every deploy is blocked. */
  allowedCodeHashes?: string[];
  /** Max native value sent with a deploy. Missing = value must be exactly 0. */
  maxValue?: string;
  /** Max storage_deposit_limit. Missing = every deploy is blocked. */
  maxStorageDepositLimit?: string;
  /** Max weight_limit.ref_time. Missing = every deploy is blocked. */
  maxGasLimit?: string;
  /** Max weight_limit.proof_size. Missing = every deploy is blocked. */
  maxProofSize?: string;
}

/** Stable strings; never rename. */
export type DeployReasonCode =
  | "DEPLOY_FIELD_INVALID"
  | "DEPLOY_CODE_HASH_LIST_MISSING"
  | "DEPLOY_CODE_HASH_NOT_ALLOWED"
  | "DEPLOY_VALUE_NOT_ALLOWED"
  | "DEPLOY_STORAGE_CAP_MISSING"
  | "DEPLOY_STORAGE_LIMIT_MISSING"
  | "DEPLOY_STORAGE_LIMIT_OVER_CAP"
  | "DEPLOY_GAS_CAP_MISSING"
  | "DEPLOY_GAS_LIMIT_MISSING"
  | "DEPLOY_GAS_LIMIT_OVER_CAP"
  | "MAP_ACCOUNT_NOT_SIGNER";

const isUint = (s: unknown): s is string => typeof s === "string" && /^\d+$/.test(s);
const isHash = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);

/** Deploy-specific rules for one plan step. Returns [] for any other kind. */
export function checkDeployStep(
  step: PlanStep,
  deploy: DeployPolicy | undefined,
  signerPublicKey: Hex,
): PolicyRuleResult[] {
  const kind = step.kind as string;
  if (!isDeployKind(kind)) return [];
  const out: PolicyRuleResult[] = [];
  const id = step.actionId;
  const d = (step.decodedArgs ?? {}) as Record<string, unknown>;
  const block = (rule: string, code: DeployReasonCode, reason: string) =>
    out.push({
      rule,
      outcome: "block",
      reason: `Blocked (${code}): ${reason}`,
      actionId: id,
      code,
    });
  const pass = (rule: string, reason: string) =>
    out.push({ rule, outcome: "pass", reason, actionId: id });

  if (kind === "revive.map_account") {
    const acct = d.account;
    const n = typeof acct === "string" ? normalizeAccount(acct) : undefined;
    if (!n)
      block(
        "map_account_signer",
        "MAP_ACCOUNT_NOT_SIGNER",
        "map_account names no decodable account.",
      );
    else if (n.toLowerCase() !== signerPublicKey.toLowerCase())
      block(
        "map_account_signer",
        "MAP_ACCOUNT_NOT_SIGNER",
        "map_account may only map the signer's own account.",
      );
    else pass("map_account_signer", "map_account maps the signer's own account");
    return out;
  }

  // 1. Code hash allow-list.
  const list = deploy?.allowedCodeHashes;
  if (!Array.isArray(list) || list.length === 0)
    block(
      "deploy_code_hash",
      "DEPLOY_CODE_HASH_LIST_MISSING",
      "the policy has no allowedCodeHashes, so no deploy is allowed.",
    );
  else if (!isHash(d.codeHash))
    block(
      "deploy_code_hash",
      "DEPLOY_FIELD_INVALID",
      "codeHash is missing or not a 32-byte hex hash.",
    );
  else if (
    !list.some(
      (h) => typeof h === "string" && h.toLowerCase() === (d.codeHash as string).toLowerCase(),
    )
  )
    block(
      "deploy_code_hash",
      "DEPLOY_CODE_HASH_NOT_ALLOWED",
      `code hash ${d.codeHash} is not on the allowed list.`,
    );
  else pass("deploy_code_hash", "code hash is allowed");

  // 2. Value: 0 unless the policy sets maxValue.
  const maxValue = deploy?.maxValue;
  if (!isUint(d.value))
    block("deploy_value", "DEPLOY_FIELD_INVALID", "value is missing or not a whole number.");
  else if (maxValue !== undefined && !isUint(maxValue))
    block(
      "deploy_value",
      "DEPLOY_FIELD_INVALID",
      "the policy's deploy maxValue is not a whole number.",
    );
  else if (BigInt(d.value) > BigInt(maxValue ?? "0"))
    block(
      "deploy_value",
      "DEPLOY_VALUE_NOT_ALLOWED",
      `value ${d.value} is over the allowed ${maxValue ?? "0"}.`,
    );
  else pass("deploy_value", `value ${d.value} is allowed`);

  // 3. Storage deposit limit: set, and within a cap that must exist.
  const bounded = (
    rule: string,
    label: string,
    v: unknown,
    cap: string | undefined,
    capMissing: DeployReasonCode,
    vMissing: DeployReasonCode,
    over: DeployReasonCode,
  ) => {
    if (cap === undefined)
      block(rule, capMissing, `the policy sets no cap for ${label}, so no deploy is allowed.`);
    else if (!isUint(cap))
      block(rule, "DEPLOY_FIELD_INVALID", `the policy's cap for ${label} is not a whole number.`);
    else if (v === undefined || v === null) block(rule, vMissing, `${label} is not set.`);
    else if (!isUint(v))
      block(rule, "DEPLOY_FIELD_INVALID", `${label} "${String(v)}" is not a whole number.`);
    else if (BigInt(v) > BigInt(cap)) block(rule, over, `${label} ${v} is over the cap of ${cap}.`);
    else pass(rule, `${label} ${v} is within the cap of ${cap}`);
  };
  bounded(
    "deploy_storage_limit",
    "storage deposit limit",
    d.storageDepositLimit,
    deploy?.maxStorageDepositLimit,
    "DEPLOY_STORAGE_CAP_MISSING",
    "DEPLOY_STORAGE_LIMIT_MISSING",
    "DEPLOY_STORAGE_LIMIT_OVER_CAP",
  );
  // 4. Weight limit: both parts set and bounded.
  bounded(
    "deploy_gas_limit",
    "gas limit (ref_time)",
    d.gasLimit,
    deploy?.maxGasLimit,
    "DEPLOY_GAS_CAP_MISSING",
    "DEPLOY_GAS_LIMIT_MISSING",
    "DEPLOY_GAS_LIMIT_OVER_CAP",
  );
  bounded(
    "deploy_gas_limit",
    "proof size limit",
    d.proofSize,
    deploy?.maxProofSize,
    "DEPLOY_GAS_CAP_MISSING",
    "DEPLOY_GAS_LIMIT_MISSING",
    "DEPLOY_GAS_LIMIT_OVER_CAP",
  );
  return out;
}
