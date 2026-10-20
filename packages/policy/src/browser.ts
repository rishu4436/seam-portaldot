/**
 * Browser-safe entry for the authoritative SEAM policy engine: `@seam/policy/browser`.
 * No node built-ins anywhere in this import graph (checked by test/browser-entry.test.ts).
 *
 * The console must call `gatePolicy` / `assertPolicyAllows` right before it asks the wallet to sign.
 * Fail-closed: anything other than "every rule passed" is blocked, including unknowns, a thrown
 * evaluation, an unacknowledged mode downgrade, or an expired signing envelope.
 */
import { evaluatePolicy, type PolicyInput } from "./policy.js";
import type { PolicyResult, PolicyRuleResult, SigningEnvelope } from "./types.js";

export * from "./index.js";

export type ExplanationStatus = "pass" | "fail" | "unknown";
export interface RuleExplanation {
  rule: string;
  status: ExplanationStatus;
  /** Stable code: the rule's own code when it has one (deploy rules), else derived from the rule name. */
  code: string;
  /** Plain sentence a person can read. */
  message: string;
  actionId?: string;
  /** True when the rule passed only because the policy allows an unknown (weaker proof). */
  weak?: boolean;
}

/** Readable title for each rule the engine can emit. Unknown rule names still get a generic title. */
export const RULE_TITLES: Record<string, string> = {
  plan_integrity: "Plan integrity",
  manifest_match: "Plan belongs to the Manifest",
  signer_match: "Signer matches the Manifest",
  runtime_match: "Plan matches the current runtime",
  plan_available: "Plan can run",
  step_available: "Step can run",
  mode_allowed: "Execution mode allowed",
  mode_downgrade: "Atomic-to-sequential downgrade",
  max_steps: "Number of steps",
  capability: "Capability allowed",
  call_index: "Call index matches runtime",
  asset_allowed: "Asset allowed",
  amount_limit: "Amount within limit",
  recipient_allowed: "Recipient allowed",
  address_check: "Address valid",
  contract_allowed: "Contract allowed",
  selector_allowed: "Contract message allowed",
  message_allowed: "Contract message allowed",
  message_not_allowed: "Contract message allowed",
  abi_pinned: "Contract ABI pinned",
  abi_hash_missing: "Contract ABI hash present",
  abi_hash_mismatch: "Contract ABI hash matches",
  native_value_limit: "Native value within limit",
  gas_limit: "Gas limit",
  proof_size_limit: "Proof size within limit",
  storage_limit: "Storage deposit within limit",
  weight_limit: "Weight within limit",
  fee_limit: "Fee within limit",
  preflight: "Preflight ran",
  dry_run: "Dry run",
  deploy_code_hash: "Deploy code hash allowed",
  deploy_value: "Deploy value",
  deploy_gas_limit: "Deploy gas limit",
  deploy_storage_limit: "Deploy storage limit",
  map_account_signer: "map_account is for the signer",
  envelope_expiry: "Signing window not expired",
  evaluation: "Policy evaluation",
};

/** Codes for a failing rule. `mode_allowed` -> PLAN_MODE_NOT_ALLOWED etc.; others -> RULE_NAME_BLOCKED. */
const FAIL_CODES: Record<string, string> = {
  mode_allowed: "PLAN_MODE_NOT_ALLOWED",
  plan_integrity: "PLAN_DIGEST_MISMATCH",
  manifest_match: "MANIFEST_MISMATCH",
  signer_match: "SIGNER_MISMATCH",
  runtime_match: "RUNTIME_MISMATCH",
  plan_available: "PLAN_UNAVAILABLE",
  step_available: "STEP_UNAVAILABLE",
  max_steps: "MAX_STEPS_EXCEEDED",
  capability: "CAPABILITY_NOT_ALLOWED",
  call_index: "CALL_INDEX_MISMATCH",
  asset_allowed: "ASSET_NOT_ALLOWED",
  amount_limit: "AMOUNT_OVER_LIMIT",
  recipient_allowed: "RECIPIENT_NOT_ALLOWED",
  contract_allowed: "CONTRACT_NOT_ALLOWED",
  native_value_limit: "NATIVE_VALUE_OVER_LIMIT",
  fee_limit: "FEE_OVER_LIMIT",
  dry_run: "DRY_RUN_FAILED",
  mode_downgrade: "MODE_DOWNGRADE_NOT_ACKNOWLEDGED",
  envelope_expiry: "SIGNING_WINDOW_EXPIRED",
  evaluation: "POLICY_EVALUATION_ERROR",
};

const upper = (s: string) => s.replace(/[^a-z0-9]+/gi, "_").toUpperCase();
const title = (rule: string) => RULE_TITLES[rule] ?? rule.replace(/_/g, " ");

export function codeFor(r: Pick<PolicyRuleResult, "rule" | "outcome" | "code">): string {
  if (r.code) return r.code;
  if (r.outcome === "pass") return "OK";
  if (r.outcome === "unknown") return `${upper(r.rule)}_UNKNOWN`;
  return FAIL_CODES[r.rule] ?? `${upper(r.rule)}_BLOCKED`;
}

/** One readable line per rule. Never drops a rule; unknown outcomes stay "unknown" (and block in the gate). */
export function explainPolicy(result: PolicyResult): RuleExplanation[] {
  const out: RuleExplanation[] = result.rules.map((r) => {
    const status: ExplanationStatus =
      r.outcome === "pass" ? "pass" : r.outcome === "unknown" ? "unknown" : "fail";
    const where = r.actionId ? ` (step ${r.actionId})` : "";
    const lead = status === "pass" ? "Pass" : status === "fail" ? "Fail" : "Unknown, so blocked";
    const reason = r.reason.trim().replace(/\.$/, "");
    return {
      rule: r.rule,
      status,
      code: codeFor(r),
      message: `${title(r.rule)}${where}: ${lead}. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`,
      ...(r.actionId ? { actionId: r.actionId } : {}),
      ...(r.weak ? { weak: true } : {}),
    };
  });
  for (const a of result.approvalRequired ?? [])
    out.push({
      rule: "mode_downgrade",
      status: "unknown",
      code: FAIL_CODES.mode_downgrade,
      message: `${title("mode_downgrade")}: needs a person to acknowledge it. ${a.reason}`,
    });
  return out;
}

export interface GateOptions {
  /** The person explicitly acknowledged an atomic-to-sequential downgrade in the UI. */
  acknowledgedDowngrade?: boolean;
  /** When given, the signing window must not have expired at `now`. */
  envelope?: Pick<SigningEnvelope, "expiresAt">;
  now?: Date;
}
export interface GateResult {
  allowed: boolean;
  /** The raw engine result (absent only if evaluation threw). */
  result?: PolicyResult;
  explanations: RuleExplanation[];
  /** Everything that stops signing (fail or unknown). Empty iff allowed. */
  blockedBy: RuleExplanation[];
}

/**
 * Runs the authoritative engine and decides whether signing may start.
 * Allowed only if the engine allows it AND every explanation is "pass".
 */
export function gatePolicy(input: PolicyInput, opts: GateOptions = {}): GateResult {
  let result: PolicyResult | undefined;
  let explanations: RuleExplanation[];
  try {
    result = evaluatePolicy(input);
    explanations = explainPolicy(result);
  } catch (e) {
    explanations = [
      {
        rule: "evaluation",
        status: "fail",
        code: FAIL_CODES.evaluation,
        message: `Policy evaluation: Fail. The policy could not be evaluated (${
          e instanceof Error ? e.message : String(e)
        }), so signing is blocked.`,
      },
    ];
  }
  if (opts.acknowledgedDowngrade)
    explanations = explanations.map((x) =>
      x.rule === "mode_downgrade" && x.status === "unknown" && x.code === FAIL_CODES.mode_downgrade
        ? {
            ...x,
            status: "pass" as const,
            code: "OK",
            message: `${title("mode_downgrade")}: Pass. Acknowledged by the user.`,
          }
        : x,
    );
  if (opts.envelope) {
    const exp = Date.parse(opts.envelope.expiresAt);
    const now = (opts.now ?? new Date()).getTime();
    explanations.push(
      Number.isFinite(exp) && exp > now
        ? {
            rule: "envelope_expiry",
            status: "pass",
            code: "OK",
            message: `${title("envelope_expiry")}: Pass. Expires at ${opts.envelope.expiresAt}.`,
          }
        : {
            rule: "envelope_expiry",
            status: "fail",
            code: FAIL_CODES.envelope_expiry,
            message: `${title("envelope_expiry")}: Fail. The signing window ${
              Number.isFinite(exp) ? `expired at ${opts.envelope.expiresAt}` : "has no valid expiry"
            }.`,
          },
    );
  }
  const blockedBy = explanations.filter((x) => x.status !== "pass");
  const allowed = !!result && result.allowed && blockedBy.length === 0 && explanations.length > 0;
  return { allowed, result, explanations, blockedBy };
}

export class PolicyBlockedError extends Error {
  readonly gate: GateResult;
  readonly codes: string[];
  constructor(gate: GateResult) {
    const codes = gate.blockedBy.map((b) => b.code);
    super(
      `Blocked by policy before signing: ${gate.blockedBy.map((b) => b.message).join(" ") || "the engine did not allow this plan."}`,
    );
    this.name = "PolicyBlockedError";
    this.gate = gate;
    this.codes = codes.length ? codes : ["POLICY_NOT_ALLOWED"];
  }
}

/** Throws PolicyBlockedError unless every rule passes. Call this immediately before the wallet signer. */
export function assertPolicyAllows(input: PolicyInput, opts: GateOptions = {}): GateResult {
  const g = gatePolicy(input, opts);
  if (!g.allowed) throw new PolicyBlockedError(g);
  return g;
}
