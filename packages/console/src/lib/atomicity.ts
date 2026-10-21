// Atomicity of a LIVE atomic (Utility.batch_all) run. The run is recorded as atomic_unverified unless the plan compiled
// as atomic_verified AND the policy's own rollbackProofOk (@seam/policy) accepts the runtime facts' batchAllRollbackProof
// for this chain, runtime and every step kind. A bare "verified" string, a missing or mismatched proof, or missing facts
// all stay atomic_unverified. Nothing is inferred from the run's own outcome.
import { rollbackProofOk } from "@seam/policy/browser";

export interface RunAtomicity {
  status: "atomic_verified" | "atomic_unverified";
  /** Why, in plain words: the policy's rejection reason, or the accepted basis. */
  reason: string;
  /** What decided it. */
  basis: string;
}

export function runAtomicity(plan: unknown, facts: unknown): RunAtomicity | undefined {
  const p = plan as { mode?: string; steps?: { kind?: string }[] } | undefined;
  if (!p?.mode?.startsWith("atomic")) return undefined;
  const basis = "rollbackProofOk (@seam/policy) on the runtime facts' batchAllRollbackProof";
  if (p.mode !== "atomic_verified")
    return {
      status: "atomic_unverified",
      reason: `The plan compiled as ${p.mode}: rollback on failure is not proven for this runtime.`,
      basis: "compiled plan mode",
    };
  const f = facts as { behaviour?: unknown; fingerprint?: unknown } | undefined;
  if (!f?.behaviour || !f.fingerprint)
    return {
      status: "atomic_unverified",
      reason: "No runtime facts to check the rollback proof against.",
      basis,
    };
  let r: ReturnType<typeof rollbackProofOk>;
  try {
    r = rollbackProofOk(
      f as never,
      (p.steps ?? []).map((s) => String(s.kind)),
    );
  } catch (e) {
    return {
      status: "atomic_unverified",
      reason: `The rollback proof could not be checked (${(e as Error).message}).`,
      basis,
    };
  }
  return r.ok
    ? {
        status: "atomic_verified",
        reason: "The batch_all rollback proof matches this chain, runtime and every step kind.",
        basis,
      }
    : { status: "atomic_unverified", reason: r.reason, basis };
}
