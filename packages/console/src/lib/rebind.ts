// Facts snapshot (Sentinel's FACTS_MISMATCH fix): the live facts read once for the builder are the plan's facts for
// compile, preflight, approval and signing. Whenever facts are re-read (before approve, before sign) Forge's
// rebindPlan (@seam/compiler/browser) decides; the console has no comparison logic of its own:
//  - same facts            -> the plan stands;
//  - only allow-listed raw metadata drift -> a recompiled plan with a NEW digest: the old approval is discarded and a
//    fresh approval is required (never carried over), nothing is signed this time;
//  - anything else         -> RUNTIME_CHANGED, blocked.
import { rebindPlan } from "@seam/compiler/browser";

export type RebindCheck =
  | { kind: "same" }
  | {
      kind: "rebound";
      plan: unknown;
      liveFacts: unknown;
      previousPlanDigest: string;
      message: string;
    }
  | { kind: "changed"; code: "RUNTIME_CHANGED"; message: string };

export function checkRebind(
  manifest: unknown,
  plan: unknown,
  planFacts: unknown,
  liveFacts: unknown,
): RebindCheck {
  try {
    const r = rebindPlan(manifest as never, plan as never, planFacts as never, liveFacts as never);
    if (!r.rebound) return { kind: "same" };
    return {
      kind: "rebound",
      plan: r.plan,
      liveFacts,
      previousPlanDigest: r.previousPlanDigest,
      message: `The runtime metadata changed (${r.reason}). The plan was recompiled: new plan digest ${r.plan.planDigest} (was ${r.previousPlanDigest}). The old approval was discarded; approve the new plan.`,
    };
  } catch (e) {
    const issues = (e as { issues?: { code?: string; message?: string }[] }).issues;
    const msg = issues?.[0]?.message ?? (e instanceof Error ? e.message : String(e));
    return {
      kind: "changed",
      code: "RUNTIME_CHANGED",
      message: `RUNTIME_CHANGED: ${msg}. Nothing will be approved or signed; compile again.`,
    };
  }
}

export type ApproveOutcome<G> =
  | { kind: "checked"; gate: G; liveFacts: unknown }
  | {
      kind: "rebound";
      plan: unknown;
      liveFacts: unknown;
      previousPlanDigest: string;
      message: string;
    }
  | { kind: "blocked"; code: string; message: string };

/**
 * Before approve: re-read facts once, rebind, and only on an unchanged plan run the engine check against that same read.
 * A rebound plan is returned WITHOUT an approval check: the caller swaps the plan in and asks for a fresh approval.
 */
export async function approveWithRebind<G>(a: {
  manifest: unknown;
  plan: unknown;
  planFacts: unknown;
  readFacts: () => Promise<unknown>;
  check: (liveFacts: unknown) => Promise<G>;
}): Promise<ApproveOutcome<G>> {
  const live = await a.readFacts().catch(() => undefined);
  if (!live)
    return {
      kind: "blocked",
      code: "FACTS_UNAVAILABLE",
      message: "Live runtime facts could not be read, so the plan can't be approved.",
    };
  const r = checkRebind(a.manifest, a.plan, a.planFacts, live);
  if (r.kind === "changed") return { kind: "blocked", code: r.code, message: r.message };
  if (r.kind === "rebound") return r;
  return { kind: "checked", gate: await a.check(live), liveFacts: live };
}
