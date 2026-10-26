// Receipt integrity for console receipts: policyDigest, evidenceCoverage and integrityHash. Secret-free by construction:
// signed bytes and raw metadata are never in a receipt, and any such key is dropped before hashing (a guard, not a
// normal path). integrityHash covers every other field of the receipt.
import { digest, policyDigest as enginePolicyDigest } from "@seam/policy/browser";

export const INTEGRITY_DOMAIN = "seam/console-receipt-integrity/v1";
export const INTEGRITY_ALGO =
  "blake2b-256(utf8('seam/console-receipt-integrity/v1') || 0x00 || canonicalJson(receipt without integrityHash and integrityAlgo)) via @seam/policy digest()";

/** Keys that would carry secret or bulky bytes; never kept in a receipt. */
export const SECRET_KEYS = [
  "signedTx",
  "signedExtrinsic",
  "signedExtrinsics",
  "signedBytes",
  "signature",
  "metadataHex",
  "preparedMetadataHex",
  "currentMetadataHex",
] as const;

export type CoverageLevel = "proven" | "reported" | "unknown" | "failed";
/** What each proof row of the run rests on. Unknown stays unknown. */
export interface EvidenceCoverage {
  feeEstimate: CoverageLevel;
  signedDryRun: CoverageLevel;
  dispatchResult: CoverageLevel;
  verifiedEffect: CoverageLevel;
  /** Plain basis for the levels above. */
  basis: string;
}

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      if (!(SECRET_KEYS as readonly string[]).includes(k) && x !== undefined) o[k] = strip(x);
    return o;
  }
  return v;
}

export function receiptPolicyDigest(approvalInputs: unknown): string | null {
  const p = (approvalInputs as { policy?: unknown } | null | undefined)?.policy;
  if (!p) return null;
  try {
    return enginePolicyDigest(p as never);
  } catch {
    return null;
  }
}

export function integrityHashOf(receipt: Record<string, unknown>): string {
  const { integrityHash: _h, integrityAlgo: _a, ...rest } = receipt;
  return digest(INTEGRITY_DOMAIN, strip(rest));
}

/** Adds policyDigest, evidenceCoverage, integrityAlgo and integrityHash (last). Secret keys are dropped first. */
export function sealReceipt<T extends Record<string, unknown>>(
  r: T,
  coverage: EvidenceCoverage,
): T & {
  policyDigest: string | null;
  evidenceCoverage: EvidenceCoverage;
  integrityAlgo: string;
  integrityHash: string;
} {
  const clean = strip(r) as T;
  const body = {
    ...clean,
    policyDigest: receiptPolicyDigest(clean.approvalInputs),
    evidenceCoverage: coverage,
    integrityAlgo: INTEGRITY_ALGO,
  };
  return { ...body, integrityHash: integrityHashOf(body) };
}

/** Recompute and compare (what a verifier does). */
export function checkIntegrity(r: Record<string, unknown>): boolean {
  return typeof r.integrityHash === "string" && integrityHashOf(r) === r.integrityHash;
}
