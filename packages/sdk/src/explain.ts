import type { Plan } from '@seam/compiler';
import type { PolicyResult, SubmitCheck } from '@seam/policy';
import type { Receipt } from './receipt.js';
import type { ManifestIssue } from './manifest.js';

/**
 * Plain-English explanations of what SEAM decided. Fixed wording, no AI and no network:
 * these only describe a result, they never change one.
 */
const MODE: Record<Plan['mode'], string> = {
  atomic_verified: 'all steps run in one transaction, and the chain has been shown to undo everything if any step fails',
  atomic_unverified: "all steps run in one transaction, but it hasn't been proven that the chain undoes everything on failure",
  sequential: 'steps run one at a time, and SEAM stops at the first one that fails',
  unavailable: 'this plan cannot run on this chain',
};

export function explainPlan(plan: Plan): string {
  const lines = [`Plan for ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}: ${MODE[plan.mode]}.`];
  for (const s of plan.steps) {
    lines.push(s.status === 'ok' ? `- ${s.actionId}: ${s.kind} is ready (${s.capability}).` : `- ${s.actionId}: can't run, because ${s.reason ?? 'its capability is missing'}.`);
  }
  if (plan.mode !== 'unavailable' && plan.modeReason) lines.push(`Why this mode: ${plan.modeReason}`);
  return lines.join('\n');
}

export function explainPolicy(result: PolicyResult): string {
  const bad = result.rules.filter((r) => r.outcome !== 'pass');
  if (!bad.length) return `Allowed: all ${result.rules.length} policy checks passed.`;
  return [`Blocked by policy (${bad.length} of ${result.rules.length} checks did not pass):`,
    ...bad.map((r) => `- ${r.actionId ? `${r.actionId}: ` : ''}${r.reason}${r.outcome === 'unknown' ? " (SEAM couldn't confirm this, and unknowns are blocked unless the policy allows them)" : ''}`)].join('\n');
}

/** Fixed wording for gate block codes that have it. Other codes keep the gate's own message. */
const BLOCK_WORDING: Record<string, string> = {
  message_not_allowed: "Blocked: this contract message isn't on the policy's allowed list for that contract, or the call has no message name to check.",
  abi_hash_missing: "Blocked: the policy pins an interface (ABI) hash for this contract, but this call doesn't carry one, so SEAM can't confirm it is the approved interface.",
  abi_hash_mismatch: "Blocked: the interface (ABI) used for this call is not the one the policy pins for this contract.",
};

/**
 * Fixed wording for the gate's submit-time pass codes. Anything else is shown verbatim, never guessed.
 * message_allowed, abi_pinned and selector_allowed are policy rules (see policyResult.rules), not gate pass codes.
 */
const PASS_WORDING: Record<string, string> = {
  step_order: 'this step is next in the approved order',
  previous_steps_ok: 'the earlier steps completed and were verified',
  approval_unused: "this step of the approval hasn't been sent before",
  approval_valid_time: "the approval hasn't expired",
  approval_intact: "the approval's contents still match its hash",
  approval_matches: 'what is about to be sent is exactly what was approved',
  runtime_unchanged: 'the chain runtime is the one the plan was prepared for',
  signed_bytes_match: 'the signed transaction bytes are exactly the approved calls',
  signed_dry_run_ok: 'a dry run of the signed transaction succeeded',
};

function explainPassed(check: SubmitCheck): string[] {
  const failed = new Set(check.reasons.map((r) => r.code));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of check.passed ?? []) {
    if (failed.has(p.code) || seen.has(p.code)) continue; // a failed check is never described as passed
    seen.add(p.code);
    const w = PASS_WORDING[p.code];
    lines.push(w ? `- ${w} (${p.code}${p.detail ? `: ${p.detail}` : ''})` : `- ${p.code}: ${p.detail}`);
  }
  return lines;
}

export function explainSubmitCheck(check: SubmitCheck): string {
  const passed = explainPassed(check);
  const tail = passed.length ? ['Checks that passed:', ...passed] : [];
  if (check.ok) return ['Safe to submit: the approval, runtime and signed bytes all match what was approved.', ...tail].join('\n');
  return ['Not submitted:', ...check.reasons.map((r) => `- ${BLOCK_WORDING[r.code] ?? r.message}`), ...tail].join('\n');
}

const STATUS: Record<string, string> = {
  finalized: 'finalized', included: 'in a block, not final yet', submitted: 'sent, waiting for a block', failed: 'failed', not_run: 'not run',
};

export function explainReceipt(r: Receipt): string {
  const head = r.result === 'verified'
    ? `Verified: all ${r.coverage.expected} steps finalized and the chain shows exactly what was planned.`
    : r.result === 'partial'
      ? `Partial: ${r.coverage.verified} of ${r.coverage.expected} steps verified, and SEAM stopped before the rest ran.`
      : `Not verified: ${r.coverage.verified} of ${r.coverage.expected} steps could be confirmed on chain.`;
  return [head, ...r.steps.map((s) => `- ${s.actionId}: ${STATUS[s.status] ?? s.status}. ${s.reason}${s.txHash ? ` Tx ${s.txHash}` : ''}`)].join('\n');
}

export function explainManifestIssues(issues: ManifestIssue[]): string {
  return ['The Manifest has problems:', ...issues.map((i) => `- ${i.path}: ${i.message}`)].join('\n');
}
