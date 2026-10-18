// Pure view model for the LIVE transaction confirmation / finality panel. Never claims finalized or verified without evidence.
import type { LiveOutcome } from "./live";

export type FinalityKey =
  "submitted" | "included" | "finalized" | "uncertain" | "rejected" | "failed" | "none";
export interface FinalityView {
  key: FinalityKey;
  label: string;
  tone: "ok" | "warn" | "bad" | "info" | "muted";
  message: string;
  txHash?: string;
  blockNumber?: number;
  blockHash?: string;
  canRetry: boolean;
  reconcileFirst: boolean;
}
export interface FinalityEvidence {
  blockNumber?: number;
  blockHash?: string;
}

export function finalityView(
  o: Pick<LiveOutcome, "txState" | "txHash" | "provenance" | "submitted">,
  ev: FinalityEvidence = {},
): FinalityView {
  const base = { txHash: o.txHash, blockNumber: ev.blockNumber, blockHash: ev.blockHash };
  const hasTx = !!o.txHash;
  switch (o.txState) {
    case "rejected":
      return {
        ...base,
        key: "rejected",
        label: "Rejected",
        tone: "bad",
        message: "Rejected in your wallet. Nothing was sent and the approval was not consumed.",
        canRetry: true,
        reconcileFirst: false,
      };
    case "failed":
      return {
        ...base,
        key: "failed",
        label: "Failed",
        tone: "bad",
        message: hasTx ? "The transaction failed on chain." : "The submission failed.",
        canRetry: !o.submitted,
        reconcileFirst: o.submitted,
      };
    case "uncertain":
    case "unknown":
      return {
        ...base,
        key: "uncertain",
        label: "Uncertain",
        tone: "warn",
        message: "Outcome unknown, reconcile before retrying.",
        canRetry: false,
        reconcileFirst: true,
      };
    case "submitted":
      return {
        ...base,
        key: "submitted",
        label: "Submitted",
        tone: "info",
        message: hasTx
          ? "Submitted to the node. Not yet in a block that SEAM has seen."
          : "Submitted, but no transaction hash was returned.",
        canRetry: false,
        reconcileFirst: true,
      };
    case "included":
      return {
        ...base,
        key: "included",
        label: "Included, not final",
        tone: "info",
        message: "Seen in a block that is not final yet.",
        canRetry: false,
        reconcileFirst: true,
      };
    case "finalized":
      // Finalized is shown only with a tx hash; "verified" additionally needs chain provenance.
      if (!hasTx)
        return {
          ...base,
          key: "uncertain",
          label: "Uncertain",
          tone: "warn",
          message:
            "Outcome unknown, reconcile before retrying. (Finalized was reported without a transaction hash, so it is not trusted.)",
          canRetry: false,
          reconcileFirst: true,
        };
      return {
        ...base,
        key: "finalized",
        label:
          o.provenance === "chain_verified" ? "Finalized and verified" : "Finalized, not verified",
        tone: o.provenance === "chain_verified" ? "ok" : "info",
        message:
          o.provenance === "chain_verified"
            ? "Finalized and verified against the chain."
            : "Finalized, but the result was not verified against the chain.",
        canRetry: false,
        reconcileFirst: false,
      };
    default:
      return {
        ...base,
        key: "none",
        label: "Not run",
        tone: "muted",
        message: "Nothing has been submitted.",
        canRetry: false,
        reconcileFirst: false,
      };
  }
}
