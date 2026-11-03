import type { Plan as CompiledPlan } from "@seam/policy/browser";
import type { Plan, Approval } from "./types";
/** Display projection only. The original compiled plan remains the authority for every gate. */
export function planView(p: CompiledPlan): Plan {
  return {
    manifestDigest: p.manifestDigest,
    fingerprintDigest: p.fingerprintDigest,
    signer: p.signer.value,
    mode: p.mode,
    modeReason: p.modeReason,
    digest: p.planDigest,
    steps: p.steps.map((s) => ({
      actionId: s.actionId,
      capability: s.capability,
      callIndex: [s.palletIndex!, s.callIndex!],
      encodedCall: s.encodedCall ?? undefined,
      decoded: {
        assetId: s.decodedArgs.assetId,
        amount: s.decodedArgs.amount,
        recipient: s.decodedArgs.recipient,
      },
      status: s.status,
    })),
  };
}
export function reviewApproval(p: Plan, maxSeconds: number): Approval {
  return {
    hash: p.digest,
    covers: p.steps.map((s) => s.actionId),
    expiresAt: new Date(Date.now() + maxSeconds * 1000).toISOString(),
    used: false,
  };
}
