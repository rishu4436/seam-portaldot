import type { PlanMode } from "./types.js";
import { type Policy, definePolicy, portaldotPolicy } from "./policy.js";

export interface PolicyIssue { path: string; message: string }
export type ParsedPolicy =
  | { ok: true; policy: Policy; warnings: PolicyIssue[] }
  | { ok: false; issues: PolicyIssue[] };

const MODES: PlanMode[] = ["atomic_verified", "atomic_unverified", "sequential", "unavailable"];
const LISTS = ["allowedCapabilities", "allowedAssets", "allowedContracts", "allowedRecipients"] as const;
const UINTS = ["maxNativeValue", "maxGasLimit", "maxWeight", "maxProofSize", "maxFee", "maxStorageDeposit"] as const;
const UNKNOWN_KEYS = ["fee", "weight", "storageDeposit", "dryRun", "proofSize"];
const KNOWN = new Set<string>([
  "version", "base", ...LISTS, ...UINTS, "allowedSelectors", "maxAmountPerAsset", "maxSteps", "allowedModes",
  "requireHumanApproval", "maxApprovalSeconds", "requireSignedDryRun", "allowUnknown",
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isUint = (v: unknown) => typeof v === "string" && /^\d+$/.test(v);

/**
 * Reads a policy from JSON (e.g. a file given to `seam check --policy`). Anything wrong is reported with its path
 * and a plain reason, and nothing is guessed: unknown fields, floats, negative or non-numeric limits and bad modes
 * all fail. Missing fields take the defaults of `base` ("default" or "portaldot"; "default" if not given).
 */
export function parsePolicy(input: unknown): ParsedPolicy {
  let raw = input;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch (e) { return { ok: false, issues: [{ path: "$", message: `not valid JSON: ${(e as Error).message}` }] }; }
  }
  const issues: PolicyIssue[] = [];
  const warnings: PolicyIssue[] = [];
  if (!isObj(raw)) return { ok: false, issues: [{ path: "$", message: "a policy must be a JSON object" }] };

  for (const k of Object.keys(raw)) if (!KNOWN.has(k)) issues.push({ path: k, message: `unknown field "${k}"; check the spelling` });
  if (raw.version !== undefined && raw.version !== "seam/policy/v1") issues.push({ path: "version", message: 'version must be "seam/policy/v1"' });
  if (raw.base !== undefined && raw.base !== "default" && raw.base !== "portaldot") issues.push({ path: "base", message: 'base must be "default" or "portaldot"' });

  for (const k of LISTS) {
    const v = raw[k];
    if (v === undefined) continue;
    if (v === "any") { if (k !== "allowedCapabilities") warnings.push({ path: k, message: `${k} is "any", so this rule allows everything` }); continue; }
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === "")) issues.push({ path: k, message: `${k} must be "any" or a list of non-empty strings` });
  }
  for (const k of UINTS) {
    if (raw[k] !== undefined && !isUint(raw[k])) issues.push({ path: k, message: `${k} must be a whole number in base units, written as a string like "1000"` });
  }
  if (raw.maxAmountPerAsset !== undefined) {
    if (!isObj(raw.maxAmountPerAsset)) issues.push({ path: "maxAmountPerAsset", message: 'maxAmountPerAsset must map asset ids (or "*") to amounts' });
    else for (const [a, v] of Object.entries(raw.maxAmountPerAsset)) {
      if (!isUint(v)) issues.push({ path: `maxAmountPerAsset.${a}`, message: `the limit for asset ${a} must be a whole number in base units, written as a string` });
    }
  }
  if (raw.allowedSelectors !== undefined) {
    if (!isObj(raw.allowedSelectors)) issues.push({ path: "allowedSelectors", message: "allowedSelectors must map contract addresses to lists of selectors" });
    else for (const [c, v] of Object.entries(raw.allowedSelectors)) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(x))) {
        issues.push({ path: `allowedSelectors.${c}`, message: "selectors must be 4-byte hex values like 0x633aa551" });
      }
    }
  }
  if (raw.maxSteps !== undefined && !(Number.isSafeInteger(raw.maxSteps) && (raw.maxSteps as number) > 0)) issues.push({ path: "maxSteps", message: "maxSteps must be a whole number above 0" });
  if (raw.maxApprovalSeconds !== undefined && !(Number.isSafeInteger(raw.maxApprovalSeconds) && (raw.maxApprovalSeconds as number) > 0)) {
    issues.push({ path: "maxApprovalSeconds", message: "maxApprovalSeconds must be a whole number of seconds above 0" });
  }
  if (raw.allowedModes !== undefined) {
    const m = raw.allowedModes;
    if (!Array.isArray(m) || m.length === 0 || m.some((x) => !MODES.includes(x as PlanMode))) issues.push({ path: "allowedModes", message: `allowedModes must be a non-empty list of ${MODES.join(", ")}` });
    else if (m.includes("atomic_unverified")) warnings.push({ path: "allowedModes", message: "atomic_unverified is allowed, so batches may run without a tested rollback" });
  }
  for (const k of ["requireHumanApproval", "requireSignedDryRun"]) {
    if (raw[k] !== undefined && typeof raw[k] !== "boolean") issues.push({ path: k, message: `${k} must be true or false` });
    else if (raw[k] === false) warnings.push({ path: k, message: `${k} is turned off` });
  }
  if (raw.allowUnknown !== undefined) {
    if (!isObj(raw.allowUnknown)) issues.push({ path: "allowUnknown", message: "allowUnknown must be an object" });
    else for (const [k, v] of Object.entries(raw.allowUnknown)) {
      if (!UNKNOWN_KEYS.includes(k)) issues.push({ path: `allowUnknown.${k}`, message: `allowUnknown.${k} isn't a known check (use ${UNKNOWN_KEYS.join(", ")}; capabilities can never be unknown)` });
      else if (typeof v !== "boolean") issues.push({ path: `allowUnknown.${k}`, message: "must be true or false" });
    }
  }
  if (issues.length) return { ok: false, issues };

  const { base, ...fields } = raw as Record<string, unknown>;
  const policy = (base === "portaldot" ? portaldotPolicy : definePolicy)({ ...(fields as Partial<Policy>), version: "seam/policy/v1" });
  return { ok: true, policy, warnings };
}
