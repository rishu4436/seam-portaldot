export interface GateItem {
  code: string;
  detail?: string;
}
export interface GateResult {
  ok: boolean;
  reasons: { code: string; message?: string }[];
  passed?: GateItem[];
}

/** Plain wording for submit-gate block codes added with allowedMessages / pinnedAbiHashes. */
export const BLOCK_WORDING: Record<string, string> = {
  message_not_allowed: "This contract function isn't on the allowed list",
  abi_hash_missing: "No pinned interface hash for this contract",
  abi_hash_mismatch: "Contract interface doesn't match the pinned hash",
};
export const PASS_WORDING: Record<string, string> = {
  message_allowed: "Contract function is on the allowed list",
  abi_pinned: "Contract interface matches the pinned hash",
  selector_allowed: "Contract call selector is on the allowed list",
  step_order: "This step is next in order",
  previous_steps_ok: "Earlier steps completed and were verified",
  approval_unused: "The approval hasn't been used for this step yet",
  approval_valid_time: "The approval hasn't expired",
  approval_intact: "The approval hasn't been altered",
  approval_matches: "What is being sent is exactly what was approved",
  runtime_unchanged: "The chain runtime hasn't changed since the plan was made",
  signed_bytes_match: "The signed transactions are byte-for-byte the approved calls",
  signed_dry_run_ok: "The dry run of the signed transaction succeeded",
};

/** Passed checks to show: a code that is also in reasons is never listed as passed; duplicates dropped. */
export function passedItems(g?: GateResult): { code: string; text: string; detail?: string }[] {
  if (!g?.passed?.length) return [];
  const failed = new Set(g.reasons.map((r) => r.code));
  const seen = new Set<string>();
  const out: { code: string; text: string; detail?: string }[] = [];
  for (const p of g.passed) {
    if (failed.has(p.code) || seen.has(p.code)) continue;
    seen.add(p.code);
    const w = PASS_WORDING[p.code];
    out.push(
      w
        ? { code: p.code, text: w, detail: p.detail }
        : { code: p.code, text: `${p.code}: ${p.detail ?? ""}` },
    ); // unknown codes verbatim
  }
  return out;
}
export function blockText(r: { code: string; message?: string }): string {
  return BLOCK_WORDING[r.code] ?? (r.message ?? r.code).replace(/^Blocked:\s*/, "");
}
