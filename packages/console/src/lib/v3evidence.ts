// Pure helpers for the V3 evidence view. Data is src/demo/v3-evidence.json, built by scripts/import-v3-evidence.mjs from
// evidence/testnet-v3. The wording never goes beyond what the recorded receipts say.
import data from "../demo/v3-evidence.json";

export interface V3Step {
  actionId: string;
  status: string;
  verification: string;
  coverage: string;
  code: string | null;
  withNftsVerdict: { verification: string; coverage: string } | null;
}
export interface V3Row {
  id: string;
  step: string;
  txHash: string | null;
  block: number | null;
  finalized: boolean;
  chainOutcome: string;
  explorer: string | null;
  record: string | null;
  receipt:
    | { kind: "receipt"; shown: string; result: string; fingerprintDigest: string; steps: V3Step[] }
    | { kind: "none" | "not_sent" | "gate_blocked"; label: string };
}
export const V3_EVIDENCE = data as unknown as { rows: V3Row[]; chain: string; specVersion: number };

export type Tone = "ok" | "warn" | "bad" | "muted";
export interface StepView {
  actionId: string;
  tone: Tone;
  text: string;
  note?: string;
}

/** One line per receipt step. "verified" only when the receipt itself (or the recorded nfts verdict receipt) says so. */
export function stepView(s: V3Step): StepView {
  const base = `${s.status} / ${s.verification}`;
  if (s.verification === "verified")
    return { actionId: s.actionId, tone: "ok", text: `${base} (${s.coverage})` };
  if (s.withNftsVerdict?.verification === "verified")
    return {
      actionId: s.actionId,
      tone: "warn",
      text: `${base}${s.code ? ` (${s.code})` : ""}`,
      note: `With the recorded nfts verdict receipt: ${s.withNftsVerdict.verification} (${s.withNftsVerdict.coverage}).`,
    };
  if (s.verification === "unknown")
    return {
      actionId: s.actionId,
      tone: "warn",
      text: `${base}${s.code ? ` (${s.code})` : ""}`,
      note:
        s.actionId === "call" || s.actionId === "terminate"
          ? "revive.call: no expected event was given, so the effect is unknown, not proven."
          : undefined,
    };
  return { actionId: s.actionId, tone: "bad", text: base };
}

export function rowViews(r: V3Row): StepView[] {
  if (r.receipt.kind === "receipt") return r.receipt.steps.map(stepView);
  const tone: Tone = r.receipt.kind === "gate_blocked" ? "bad" : "muted";
  return [{ actionId: "-", tone, text: r.receipt.label }];
}

export const shortHash = (h: string | null) =>
  h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "not sent";
