// Builds what LIVE signs from the compiled plan already in the console. Pure and fail-closed: no plan, an unavailable plan,
// a sequential plan (one signature per step is not supported here yet) or a plan for another runtime gives no request.
import type { LiveFingerprint, Res } from "./live";
import type { Plan, RuntimeFacts } from "./types";

export interface LiveCall { signer: string; callHex: string; actionIds: string[]; planDigest: string; manifestDigest: string; fingerprintDigest: string }
const no = (message: string): Res<never> => ({ ok: false, reason: "unavailable", message });

export function planCall(plan: Plan | undefined): Res<LiveCall> {
  if (!plan) return no("No compiled plan yet. Compile and approve a plan first.");
  if (plan.mode === "unavailable") return no("The plan is unavailable on this runtime, so there is nothing to sign.");
  if (!plan.signer) return no("The plan has no signer.");
  if (plan.mode === "sequential") return no("Sequential plans need one signature per step. The console LIVE flow signs a single atomic call only, so this is blocked.");
  const callHex = plan.outerCall?.encodedCall;
  if (!callHex || !/^0x[0-9a-fA-F]+$/.test(callHex)) return no("The atomic plan has no encoded outer call to sign.");
  return { ok: true, value: { signer: plan.signer, callHex, actionIds: plan.steps.map((s) => s.actionId), planDigest: plan.digest, manifestDigest: plan.manifestDigest, fingerprintDigest: plan.fingerprintDigest } };
}

/** The live chain must be the runtime the plan was compiled against. Only fields the browser can read are compared. */
export function fingerprintMatches(live: LiveFingerprint, facts: RuntimeFacts | undefined): Res<true> {
  const f = facts?.fingerprint;
  if (!f) return no("No runtime facts for the plan, so the live chain cannot be matched to it.");
  if (!live.genesisHash || live.genesisHash.toLowerCase() !== f.genesisHash.toLowerCase()) return { ok: false, reason: "failed", message: "The live chain's genesis hash differs from the one the plan was compiled for. Nothing was signed." };
  if (live.specVersion !== f.specVersion) return { ok: false, reason: "failed", message: `Live spec version ${live.specVersion ?? "?"} differs from the plan's ${f.specVersion}. Recompile first.` };
  if (live.transactionVersion !== f.transactionVersion) return { ok: false, reason: "failed", message: "Live transaction version differs from the plan's. Recompile first." };
  return { ok: true, value: true };
}
