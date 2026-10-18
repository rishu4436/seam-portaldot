import type { Receipt } from './receipt.js';

/**
 * Stable, machine-readable result codes for every stage: discover -> compile -> policy -> approval -> signing ->
 * dry run -> submit -> verify. Values are part of the public contract: add new ones, never rename or reuse.
 * There is deliberately no `success: boolean` for outcomes that can be partial or unknown: switch on the code.
 */
export enum SeamCode {
  Ok = 'ok',
  // request / input
  UsageError = 'usage_error',
  ManifestInvalid = 'manifest_invalid',
  PolicyFileInvalid = 'policy_file_invalid',
  // compile / runtime
  CompileFailed = 'compile_failed',
  PlanUnavailable = 'plan_unavailable',
  UnsupportedRuntime = 'unsupported_runtime',
  RuntimeChanged = 'runtime_changed',
  // policy / approval / gate
  PolicyBlocked = 'policy_blocked',
  ApprovalInvalid = 'approval_invalid',
  ApprovalExpired = 'approval_expired',
  ApprovalUsed = 'approval_used',
  SubmitGateBlocked = 'submit_gate_blocked',
  // transport and chain
  RpcTransport = 'rpc_transport',
  // execution outcomes
  Uncertain = 'uncertain',
  TxFailed = 'tx_failed',
  Partial = 'partial',
  NotVerified = 'not_verified',
  Verified = 'verified',
  // receipt verification
  IntegrityFailed = 'integrity_failed',
  IntegrityChecked = 'integrity_checked',
  ChainVerified = 'chain_verified',
  ChainVerifyFailed = 'chain_verify_failed',
  ChainVerifyUnknown = 'chain_verify_unknown',
  InternalError = 'internal_error',
}

/** Submit-gate block codes (the gate's own `reasons[].code`), as of the policy package's current set. */
export const GATE_CODES = [
  'message_not_allowed', 'abi_hash_missing', 'abi_hash_mismatch',
  'trusted_decoder_required', 'signed_signer_mismatch', 'signed_nonce_mismatch', 'signed_signature_invalid',
  'signed_chain_mismatch', 'signed_extrinsic_undecodable', 'signed_dry_run_not_checked',
] as const;
export type GateCode = (typeof GATE_CODES)[number];

/** Process exit codes. 0 means the command's whole job was done and (for receipts) fully verified. Anything else is not "fine". */
export const EXIT: Record<SeamCode, number> = {
  [SeamCode.Ok]: 0, [SeamCode.Verified]: 0, [SeamCode.IntegrityChecked]: 0, [SeamCode.ChainVerified]: 0,
  [SeamCode.UsageError]: 1, [SeamCode.InternalError]: 1,
  [SeamCode.ManifestInvalid]: 2, [SeamCode.PolicyFileInvalid]: 2, [SeamCode.CompileFailed]: 2,
  [SeamCode.PlanUnavailable]: 3, [SeamCode.UnsupportedRuntime]: 3,
  [SeamCode.PolicyBlocked]: 4, [SeamCode.ApprovalInvalid]: 4, [SeamCode.ApprovalExpired]: 4, [SeamCode.ApprovalUsed]: 4,
  [SeamCode.SubmitGateBlocked]: 4, [SeamCode.RuntimeChanged]: 4,
  [SeamCode.IntegrityFailed]: 5, [SeamCode.ChainVerifyFailed]: 5,
  [SeamCode.ChainVerifyUnknown]: 6, [SeamCode.Uncertain]: 6,
  [SeamCode.Partial]: 7, [SeamCode.NotVerified]: 7,
  [SeamCode.TxFailed]: 8,
  [SeamCode.RpcTransport]: 9,
};

export const NEXT_ACTION: Record<SeamCode, string> = {
  [SeamCode.Ok]: 'Nothing to do.',
  [SeamCode.Verified]: 'Nothing to do.',
  [SeamCode.IntegrityChecked]: 'This is integrity only. Run live verification (seam verify --endpoint) before relying on it.',
  [SeamCode.ChainVerified]: 'Nothing to do.',
  [SeamCode.UsageError]: 'Fix the command line (seam help).',
  [SeamCode.ManifestInvalid]: 'Fix the Manifest problems listed and run again.',
  [SeamCode.PolicyFileInvalid]: 'Fix the policy file problems listed and run again.',
  [SeamCode.CompileFailed]: 'Fix the Manifest to match what this runtime supports.',
  [SeamCode.PlanUnavailable]: 'This plan cannot run on this chain. Change the actions or use another runtime.',
  [SeamCode.UnsupportedRuntime]: 'SEAM has no support for this on this runtime. Do not work around it.',
  [SeamCode.RuntimeChanged]: 'The runtime changed. Discover, compile, preflight and approve again.',
  [SeamCode.PolicyBlocked]: 'Change the plan or the policy deliberately, then prepare and approve again.',
  [SeamCode.ApprovalInvalid]: 'Prepare and approve again.',
  [SeamCode.ApprovalExpired]: 'Prepare and approve again.',
  [SeamCode.ApprovalUsed]: 'Do not resend. Check the chain for the earlier transaction.',
  [SeamCode.SubmitGateBlocked]: 'Nothing was sent. Read the reasons, then prepare and approve again if appropriate.',
  [SeamCode.RpcTransport]: 'The node could not be reached. Nothing is assumed sent; check the node, then retry reads.',
  [SeamCode.Uncertain]: 'The transaction may or may not have been broadcast. Do NOT retry. Look the transaction/nonce up on the chain first.',
  [SeamCode.TxFailed]: 'The transaction failed on chain. Read the dispatch error before preparing a new run.',
  [SeamCode.Partial]: 'Some steps did not run. Review the receipt; nothing further runs automatically.',
  [SeamCode.NotVerified]: 'Steps ran but the effect was not proven. Do not treat this run as complete.',
  [SeamCode.IntegrityFailed]: 'The receipt was edited after it was written. Do not trust it.',
  [SeamCode.ChainVerifyFailed]: 'The chain contradicts the receipt. Do not trust it.',
  [SeamCode.ChainVerifyUnknown]: 'The chain could not confirm the receipt. Retry with a reachable node and the plan.',
  [SeamCode.InternalError]: 'Unexpected error; see the message.',
};

/** What a caller can switch on. */
export interface SeamOutcome { code: SeamCode; exitCode: number; nextAction: string }
export const outcome = (code: SeamCode): SeamOutcome => ({ code, exitCode: EXIT[code], nextAction: NEXT_ACTION[code] });

/**
 * The one answer for "how did this run end", from the receipt alone. A run is Verified only when every step is
 * finalized, has a tx hash and block, and is verified. An `uncertain` step wins over everything else.
 */
export function classifyReceipt(r: Receipt): SeamOutcome {
  if (r.steps.some((s) => (s.status as string) === 'uncertain')) return outcome(SeamCode.Uncertain);
  if (r.steps.some((s) => s.status === 'failed' || s.code === 'tx_failed')) return outcome(SeamCode.TxFailed);
  if (r.result === 'verified') return outcome(SeamCode.Verified);
  if (r.result === 'partial') return outcome(SeamCode.Partial);
  return outcome(SeamCode.NotVerified);
}

/** Rough sort of a thrown error, for the CLI. Anything unrecognised is internal_error, never silently success. */
export function classifyError(e: unknown): SeamCode {
  const m = (e as Error)?.message ?? '';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed? ?out|WebSocket|websocket|disconnected|not connect|1006/i.test(m)) return SeamCode.RpcTransport;
  if (/^missing |^usage:|needs --|needs the @seam\/chain/i.test(m)) return SeamCode.UsageError;
  return SeamCode.InternalError;
}
