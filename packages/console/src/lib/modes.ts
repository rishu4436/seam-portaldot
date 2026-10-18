// Console modes and the typed status unions the UI renders from.
// Names for provenance / tx state may be adjusted when the SDK and policy
// owners finalize them: change the unions here and the labels below, nothing else.

export type Mode = "live" | "recorded" | "offline";

export const MODES: { id: Mode; label: string; badge: string; hint: string; tone: "warn" | "info" | "muted" }[] = [
  { id: "live", label: "LIVE V3", badge: "LIVE V3", hint: "Real V3 RPC and your wallet. Blocked until a V3 RPC URL is configured and a chain client is wired.", tone: "warn" },
  { id: "recorded", label: "RECORDED LOCAL EVIDENCE", badge: "RECORDED LOCAL EVIDENCE", hint: "Replay of a real run on a local Portaldot dev node, spec 1002. Not the public testnet.", tone: "info" },
  { id: "offline", label: "OFFLINE DEMO", badge: "OFFLINE DEMO", hint: "Synthetic data from a saved snapshot. Timings and hashes are simulated.", tone: "muted" },
];

export type Coverage = "whole_plan" | "signed_tx" | "contract_only" | "estimated_only" | "unknown";
export const COVERAGE_LABEL: Record<Coverage, string> = {
  whole_plan: "Whole plan checked",
  signed_tx: "Signed transaction dry-run",
  contract_only: "Contract call only",
  estimated_only: "Estimate only, not simulated",
  unknown: "Coverage unknown",
};

export type Provenance = "integrity_checked" | "chain_verified" | "unknown" | "failed";
export const PROVENANCE_LABEL: Record<Provenance, { text: string; tone: "ok" | "warn" | "bad" | "info" }> = {
  integrity_checked: { text: "Integrity checked (self-hash only, chain not re-read)", tone: "info" },
  chain_verified: { text: "Chain verified", tone: "ok" },
  unknown: { text: "Unknown", tone: "warn" },
  failed: { text: "Failed", tone: "bad" },
};

export type TxState = "not_run" | "submitted" | "included" | "finalized" | "failed" | "uncertain" | "rejected" | "unknown";
export const TX_STATE_LABEL: Record<TxState, { text: string; tone: "ok" | "warn" | "bad" | "info" | "muted" }> = {
  not_run: { text: "Not run", tone: "muted" },
  submitted: { text: "Submitted", tone: "info" },
  included: { text: "Included, not final", tone: "info" },
  finalized: { text: "Finalized", tone: "ok" },
  failed: { text: "Failed", tone: "bad" },
  uncertain: { text: "Uncertain: may or may not have landed", tone: "warn" },
  rejected: { text: "Rejected in wallet", tone: "bad" },
  unknown: { text: "Unknown", tone: "warn" },
};

export type SigningStatus = "not_started" | "awaiting_wallet" | "signed" | "rejected" | "unavailable" | "binding_unchecked" | "binding_ok" | "binding_mismatch";
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
export interface ModeDowngrade { from: "atomic"; to: "sequential"; requiresApproval: boolean; partialExecutionRisk?: string }
