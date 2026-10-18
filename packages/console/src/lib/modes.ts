// Console modes and the typed status unions the UI renders from.
// Names match the final SDK / policy / chain exports (receipt.ts, codes.ts, policy types, chain preflight.ts).

export type Mode = "live" | "recorded" | "offline";

export const MODES: {
  id: Mode;
  label: string;
  badge: string;
  hint: string;
  tone: "warn" | "info" | "muted";
}[] = [
  {
    id: "live",
    label: "LIVE V3",
    badge: "LIVE V3",
    hint: "Real V3 RPC and your wallet. Blocked until a V3 RPC URL is configured and a chain client is wired.",
    tone: "warn",
  },
  {
    id: "recorded",
    label: "RECORDED LOCAL EVIDENCE",
    badge: "RECORDED LOCAL EVIDENCE",
    hint: "Replay of a real run on a local Portaldot dev node, spec 1002. Not the public testnet.",
    tone: "info",
  },
  {
    id: "offline",
    label: "OFFLINE DEMO",
    badge: "OFFLINE DEMO",
    hint: "Synthetic data from a saved snapshot. Timings and hashes are simulated.",
    tone: "muted",
  },
];

/** Final SDK name (packages/sdk/src/receipt.ts VerifierCoverage): how much of a step the chain has shown, lowest to highest. */
export type Coverage =
  "none" | "call_dispatched" | "extrinsic_finalized" | "contract_emitted" | "effect_proven";
export const COVERAGE_LABEL: Record<Coverage, string> = {
  none: "Nothing shown by the chain",
  call_dispatched: "In a block, not final",
  extrinsic_finalized: "Finalized, effect not checked",
  contract_emitted: "Contract emitted an event, effect unknown (not verified)",
  effect_proven: "Effect proven",
};

/** Preflight simulation basis (packages/chain preflight.ts CoverageBasis / wholePlan). Separate from receipt coverage. */
export type SimulationBasis =
  "none" | "signed_dry_run" | "contract_dry_run" | "asset_existence_check" | "fee_estimate_only";
export const SIMULATION_LABEL: Record<SimulationBasis, string> = {
  none: "Not simulated",
  signed_dry_run: "Signed transaction dry-run",
  contract_dry_run: "Contract dry-run only",
  asset_existence_check: "Asset existence check only",
  fee_estimate_only: "Fee estimate only, not simulated",
};

export type Provenance = "integrity_checked" | "chain_verified" | "unknown" | "failed";
export const PROVENANCE_LABEL: Record<
  Provenance,
  { text: string; tone: "ok" | "warn" | "bad" | "info" }
> = {
  integrity_checked: { text: "Integrity only, not on-chain proof", tone: "info" },
  chain_verified: { text: "Chain verified", tone: "ok" },
  unknown: { text: "Unknown", tone: "warn" },
  failed: { text: "Failed", tone: "bad" },
};

/** SDK/policy StepStatus plus console-only "rejected" (wallet) and "unknown". */
export type TxState =
  | "not_run"
  | "submitted"
  | "included"
  | "finalized"
  | "failed"
  | "uncertain"
  | "rejected"
  | "unknown";
export const TX_STATE_LABEL: Record<
  TxState,
  { text: string; tone: "ok" | "warn" | "bad" | "info" | "muted" }
> = {
  not_run: { text: "Not run", tone: "muted" },
  submitted: { text: "Submitted", tone: "info" },
  included: { text: "Included, not final", tone: "info" },
  finalized: { text: "Finalized", tone: "ok" },
  failed: { text: "Failed", tone: "bad" },
  uncertain: { text: "Uncertain: may or may not have landed", tone: "warn" },
  rejected: { text: "Rejected in wallet", tone: "bad" },
  unknown: { text: "Unknown", tone: "warn" },
};

export type SigningStatus =
  | "not_started"
  | "awaiting_wallet"
  | "signed"
  | "rejected"
  | "unavailable"
  | "binding_unchecked"
  | "binding_ok"
  | "binding_mismatch";
export const SIGNING_LABEL: Record<SigningStatus, string> = {
  not_started: "Not started",
  awaiting_wallet: "Waiting for wallet",
  signed: "Signed",
  rejected: "Wallet rejected",
  unavailable: "No wallet available",
  binding_unchecked: "Signed bytes not checked against the approval",
  binding_ok: "Signed bytes match the approval",
  binding_mismatch: "Signed bytes differ from the approval",
};

/** Optional compiler field: a plan that downgraded atomic to sequential. */
export interface ModeDowngrade {
  from: "atomic";
  to: "sequential";
  requiresApproval: boolean;
  partialExecutionRisk?: string;
}

/** Policy flags that mean the send is backed by weaker proof. */
export const WEAK_PROOF_CODES = ["signed_dry_run_not_checked"] as const;
export function isWeakProof(x: { weakProof?: string[]; gatePassedCodes?: string[] }): boolean {
  return (
    (x.weakProof?.length ?? 0) > 0 ||
    (x.gatePassedCodes ?? []).some((c) => (WEAK_PROOF_CODES as readonly string[]).includes(c))
  );
}

/** Mirror of packages/sdk codes.ts SeamCode values the console can show; the console never computes its own "verified". */
export type SeamCode = "verified" | "partial" | "not_verified" | "tx_failed" | "uncertain";
export interface ReceiptLike {
  result?: "verified" | "partial" | "not_verified";
  overall?: "verified" | "partial" | "not_verified";
  steps: { status: string; code?: string }[];
}
/** Same rules as the SDK's classifyReceipt (uncertain > failed > result). Verified only if the receipt's result says so. */
export function classifyReceipt(r: ReceiptLike): SeamCode {
  if (r.steps.some((s) => s.status === "uncertain")) return "uncertain";
  if (r.steps.some((s) => s.status === "failed" || s.code === "tx_failed")) return "tx_failed";
  const res = r.result ?? r.overall;
  if (res === "verified") return "verified";
  if (res === "partial") return "partial";
  return "not_verified";
}
export const SEAM_CODE_LABEL: Record<SeamCode, { text: string; tone: "ok" | "warn" | "bad" }> = {
  verified: { text: "verified", tone: "ok" },
  partial: { text: "partial", tone: "warn" },
  not_verified: { text: "not verified", tone: "bad" },
  tx_failed: { text: "transaction failed", tone: "bad" },
  uncertain: { text: "uncertain", tone: "warn" },
};
