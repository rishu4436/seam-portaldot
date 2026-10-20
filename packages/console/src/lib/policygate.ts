// The authoritative pre-sign policy gate: Sentinel's assertPolicyAllows from @seam/policy/browser, called right before
// the wallet signer. The console's own limits view and the wallet demo pre-check are display only; only this decides.
// Fail closed: no policy, a missing preflight, an unknown rule or a thrown evaluation all block.
import {
  assertPolicyAllows,
  PolicyBlockedError,
  type GateResult,
  type RuleExplanation,
} from "@seam/policy/browser";

export interface PolicyGateInput {
  policy: unknown;
  /** The compiler's plan, exactly as compiled. */
  plan: unknown;
  /** The compiler's RuntimeFacts. When left out, LivePanel uses the live facts it just read. */
  facts?: unknown;
  manifest?: unknown;
  /** The chain package's full PreflightResult. A fee estimate alone is not one; leave it out and the gate blocks. */
  preflight?: unknown;
}
export type GateOutcome =
  | { ok: true; explanations: RuleExplanation[]; result?: GateResult["result"] }
  | { ok: false; codes: string[]; explanations: RuleExplanation[]; message: string };

/** Envelope expiry only when the signing request really carries one; never invented from the approval window. */
export function envelopeOf(request: unknown): { expiresAt: string } | undefined {
  const r = request as { envelope?: { expiresAt?: unknown }; expiresAt?: unknown } | undefined;
  const e = r?.envelope?.expiresAt ?? r?.expiresAt;
  return typeof e === "string" ? { expiresAt: e } : undefined;
}

export function runPolicyGate(
  input: PolicyGateInput | undefined,
  opts: { request?: unknown; acknowledgedDowngrade?: boolean; now?: Date } = {},
): GateOutcome {
  if (!input?.policy)
    return {
      ok: false,
      codes: ["POLICY_MISSING"],
      explanations: [],
      message: "No policy was provided for this plan, so nothing will be signed.",
    };
  try {
    const envelope = envelopeOf(opts.request);
    const g: GateResult = assertPolicyAllows(input as never, {
      ...(envelope ? { envelope } : {}),
      ...(opts.acknowledgedDowngrade ? { acknowledgedDowngrade: true } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    return { ok: true, explanations: g.explanations, result: g.result };
  } catch (e) {
    if (e instanceof PolicyBlockedError)
      return { ok: false, codes: e.codes, explanations: e.gate.explanations, message: e.message };
    return {
      ok: false,
      codes: ["POLICY_EVALUATION_ERROR"],
      explanations: [],
      message: `The policy gate failed, so nothing will be signed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
