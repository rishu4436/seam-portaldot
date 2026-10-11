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

export function explainSubmitCheck(check: SubmitCheck): string {
  if (check.ok) return 'Safe to submit: the approval, runtime and signed bytes all match what was approved.';
  return ['Not submitted:', ...check.reasons.map((r) => `- ${r.message}`)].join('\n');
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
