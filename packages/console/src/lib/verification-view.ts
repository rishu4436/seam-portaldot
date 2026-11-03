export function verificationLabel(status: string | undefined, claimedResult?: unknown): string {
  if (!status) return "Stored · not checked";
  if (status === "chain_verified")
    return claimedResult === "verified"
      ? "Verified execution"
      : claimedResult === "partial"
        ? "Chain checked · partial execution"
        : "Chain checked · effects not fully verified";
  if (status === "failed") return "Verification failed";
  if (status === "unknown") return "Verification incomplete";
  if (status === "integrity_checked") return "Integrity checked · chain not checked";
  return status.replaceAll("_", " ");
}
export const verificationTone = (status?: string, claimedResult?: unknown) =>
  status === "failed"
    ? "bad"
    : status === "chain_verified" && claimedResult === "verified"
      ? "good"
      : "neutral";
