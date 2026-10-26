// One vocabulary for what a result is, so nothing is ever shown stronger than it is. Simulated is never called live;
// recorded is never called live; unknown stays unknown; verified needs a verifier's result, not just finality.
import type { LiveOutcome } from "./live";
import { proofSizeText, type ProofSizeField } from "./signflow";

export type EvidenceLabel =
  "simulated" | "recorded" | "live" | "finalized" | "verified" | "unknown" | "failed" | "uncertain";

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

export const EVIDENCE_LABEL: Record<EvidenceLabel, { text: string; tone: Tone; meaning: string }> =
  {
    simulated: {
      text: "Simulated",
      tone: "info",
      meaning: "Computed without the chain or from mock data. Not a live result.",
    },
    recorded: {
      text: "Recorded",
      tone: "info",
      meaning: "Replayed from a saved earlier run. Not happening now.",
    },
    live: { text: "Live", tone: "info", meaning: "Read from the real chain just now." },
    finalized: {
      text: "Finalized",
      tone: "ok",
      meaning: "In a finalized block. The effect itself is not checked by this label.",
    },
    verified: {
      text: "Verified",
      tone: "ok",
      meaning: "A verifier checked the expected effect on chain.",
    },
    unknown: { text: "Unknown", tone: "warn", meaning: "Not checked or not reported. Not a pass." },
    failed: { text: "Failed", tone: "bad", meaning: "Checked, and it did not pass." },
    uncertain: {
      text: "Uncertain",
      tone: "warn",
      meaning: "It may or may not have happened; it couldn't be confirmed either way.",
    },
  };

export type ProofRowId =
  "fee_estimate" | "unsigned_sim" | "signed_dry_run" | "dispatch_result" | "verified_effect";

export const PROOF_ROW_TITLE: Record<ProofRowId, string> = {
  fee_estimate: "Fee estimate",
  unsigned_sim: "Unsigned simulation",
  signed_dry_run: "Signed dry run",
  dispatch_result: "Dispatch result",
  verified_effect: "Verified effect",
};

export interface ProofRow {
  id: ProofRowId;
  title: string;
  label: EvidenceLabel;
  detail: string;
}

export type Source = "live" | "recorded" | "simulated";

/**
 * The five proof rows for one run. `source` caps every row: a recorded or simulated run shows "recorded"/"simulated"
 * (or unknown/failed) and never "live", "finalized" or "verified".
 */
export function proofRows(
  o: Partial<LiveOutcome> | undefined,
  source: Source,
  extra: {
    unsignedSim?: "ok" | "failed" | "unknown";
    signedDryRun?: "ok" | "failed" | "unknown";
    /** Revive steps: preflight dryRunProofSize / callInfoProofSize, each { value } or { unknown: true }. */
    proofSize?: { dryRunProofSize?: ProofSizeField; callInfoProofSize?: ProofSizeField };
  } = {},
): ProofRow[] {
  const cap = (l: EvidenceLabel): EvidenceLabel =>
    source === "live" || l === "unknown" || l === "failed" ? l : source;
  const row = (id: ProofRowId, label: EvidenceLabel, detail: string): ProofRow => ({
    id,
    title: PROOF_ROW_TITLE[id],
    label: cap(label),
    detail,
  });
  const ok3 = (
    v: "ok" | "failed" | "unknown" | undefined,
    what: string,
  ): [EvidenceLabel, string] =>
    v === "ok"
      ? ["live", `${what}: ok.`]
      : v === "failed"
        ? ["failed", `${what}: failed.`]
        : ["unknown", `${what}: not run or not reported.`];

  const fee: [EvidenceLabel, string] = o?.fee
    ? ["live", `Estimated fee ${o.fee} (base units), from payment_queryInfo.`]
    : ["unknown", "No fee estimate."];
  const unsigned = ok3(
    extra.unsignedSim ??
      (o?.simulation && o.simulation !== "none" && o.simulation !== "fee_estimate_only"
        ? "ok"
        : undefined),
    "Unsigned simulation",
  );
  const signedDry = o?.signingCode?.startsWith("signed_dry_run_") ? "failed" : extra.signedDryRun;
  const signed = ok3(signedDry, "Signed dry run");
  const tx = o?.txState;
  const dispatch: [EvidenceLabel, string] =
    tx === "finalized"
      ? ["finalized", `Finalized${o?.block ? ` in block #${o.block.number}` : ""}.`]
      : tx === "failed" || tx === "rejected"
        ? [
            "failed",
            tx === "rejected" ? "Rejected in the wallet; nothing sent." : "The transaction failed.",
          ]
        : tx === "uncertain"
          ? ["uncertain", "Sent, but inclusion couldn't be confirmed."]
          : tx === "included" || tx === "submitted"
            ? [
                "live",
                tx === "included" ? "In a block, not final yet." : "Submitted, not in a block yet.",
              ]
            : ["unknown", "Not sent."];
  const effect: [EvidenceLabel, string] =
    o?.status === "verified" && o.provenance === "chain_verified"
      ? ["verified", "The expected effect was found on chain."]
      : o?.provenance === "failed" || o?.status === "failed"
        ? ["failed", "The expected effect was not found."]
        : o?.status === "uncertain"
          ? ["uncertain", "The effect couldn't be confirmed either way."]
          : ["unknown", "The effect was not checked."];
  const ps = extra.proofSize ? proofSizeText(extra.proofSize) : undefined;
  return [
    row("fee_estimate", ...fee),
    row("unsigned_sim", unsigned[0], ps ? `${unsigned[1]} ${ps}` : unsigned[1]),
    row("signed_dry_run", ...signed),
    row("dispatch_result", ...dispatch),
    row("verified_effect", ...effect),
  ];
}
