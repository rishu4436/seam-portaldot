// Builder policy: a strict seam/policy/v1 policy derived ONLY from a builder-compiled plan. It allows that plan's own
// capabilities, assets, recipients, contracts, per-asset amounts (the largest single step, since amount_limit is per step),
// native value, step count and mode, plus a fee cap. There is no allow-all default: anything not in the plan is "*": "0" or
// an empty list. The user may only tighten it; tightenPolicy refuses anything looser than the derived policy.
// The fee cap is the plan's own preflight totalFee + 25%; with no known totalFee there is no policy (fail closed).
// The authoritative decision stays with Sentinel's engine (runPolicyGate / preSign); this file only builds the input.
import { parsePolicy, type Plan, type Policy } from "@seam/policy/browser";

const uint = (s: unknown): s is string => typeof s === "string" && /^\d+$/.test(s);

/**
 * Fee cap margin over the plan's own preflight totalFee: +25%, rounded up, in bigint. Fees move a little between the
 * preflight here and the re-preflight at the gate, so the cap is the measured fee plus this fixed margin; nothing else.
 */
export const FEE_CAP_MARGIN_PERCENT = 25n;

/** totalFee from the plan's own preflight + 25%, rounded up. undefined when the preflight has no known totalFee. */
export function feeCapFromPreflight(preflight: unknown): string | undefined {
  const t = (preflight as { totalFee?: { value?: unknown; unknown?: boolean } } | undefined)
    ?.totalFee;
  if (!t || t.unknown || !uint(t.value)) return undefined;
  const v = BigInt(t.value);
  return ((v * (100n + FEE_CAP_MARGIN_PERCENT) + 99n) / 100n).toString();
}

const maxOf = (a: string | undefined, b: string) =>
  a === undefined || BigInt(b) > BigInt(a) ? b : a;
const uniq = (xs: string[]) => [...new Set(xs)];

export type Derived =
  { ok: true; policy: Policy } | { ok: false; code?: "FEE_CAP_UNKNOWN"; message: string };

/** opts.preflight is the plan's own preflight (PreflightResult). Without a known totalFee there is no policy. */
export function derivePolicy(plan: Plan, opts: { preflight?: unknown } = {}): Derived {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length)
    return { ok: false, message: "No compiled plan, so no policy can be derived." };
  if (plan.mode === "unavailable")
    return { ok: false, message: "The plan is unavailable on this runtime; no policy is derived." };
  const bad = plan.steps.find((s) => s.status !== "ok");
  if (bad)
    return { ok: false, message: `Step ${bad.actionId} is unavailable; no policy is derived.` };
  const maxFee = feeCapFromPreflight(opts.preflight);
  if (maxFee === undefined)
    return {
      ok: false,
      code: "FEE_CAP_UNKNOWN",
      message:
        "The plan's preflight has no known total fee, so no fee cap can be derived. No policy, so the gate blocks and nothing will be signed.",
    };
  const assets: string[] = [];
  const recipients: string[] = [];
  const contracts: string[] = [];
  const amounts: Record<string, string> = {};
  let native = "0";
  for (const s of plan.steps) {
    const d = s.decodedArgs ?? {};
    if (d.assetId !== undefined) assets.push(d.assetId);
    if (d.recipient !== undefined) recipients.push(d.recipient);
    if (d.contract !== undefined) contracts.push(d.contract);
    if (d.amount !== undefined) {
      if (!uint(d.amount))
        return { ok: false, message: `Step ${s.actionId} has a non-integer amount "${d.amount}".` };
      const key = d.assetId ?? "*";
      if (key === "*")
        return {
          ok: false,
          message: `Step ${s.actionId} has an amount without an asset id; a builder policy can't scope it.`,
        };
      amounts[key] = maxOf(amounts[key], d.amount);
    }
    if (d.value !== undefined) {
      if (!uint(d.value))
        return { ok: false, message: `Step ${s.actionId} has a non-integer value.` };
      native = maxOf(native, d.value);
    }
  }
  return {
    ok: true,
    policy: {
      version: "seam/policy/v1",
      allowedCapabilities: uniq(plan.steps.map((s) => s.capability)),
      allowedAssets: uniq(assets),
      allowedContracts: uniq(contracts),
      allowedRecipients: uniq(recipients),
      maxAmountPerAsset: { ...amounts, "*": "0" },
      maxNativeValue: native,
      maxFee,
      maxSteps: plan.steps.length,
      allowedModes: [plan.mode],
      requireHumanApproval: true,
      maxApprovalSeconds: 300,
      requireSignedDryRun: true,
      // Same unknowns as the committed V3 demo policy: the pre-sign dry run is unknown and is enforced at submit by
      // requireSignedDryRun; storage deposit is not reported by V3 preflight. Fee and weight unknowns still block.
      allowUnknown: { storageDeposit: true, dryRun: true },
    },
  };
}

/** What a person may change. Only tightening: lower caps, fewer assets / recipients. */
export interface PolicyEdits {
  maxFee?: string;
  amounts?: Record<string, string>;
  removeAssets?: string[];
  removeRecipients?: string[];
}
export type Tightened = { ok: true; policy: Policy } | { ok: false; issues: string[] };

const list = (l: Policy["allowedAssets"]) => (Array.isArray(l) ? l : []);

export function tightenPolicy(base: Policy, e: PolicyEdits): Tightened {
  const issues: string[] = [];
  const p: Policy = structuredClone(base);
  if (e.maxFee !== undefined) {
    if (!uint(e.maxFee)) issues.push("maxFee: must be a whole number of base units.");
    else if (base.maxFee !== undefined && BigInt(e.maxFee) > BigInt(base.maxFee))
      issues.push(
        `maxFee: ${e.maxFee} is above the derived cap ${base.maxFee}; only lowering is allowed.`,
      );
    else p.maxFee = e.maxFee;
  }
  const caps = { ...(base.maxAmountPerAsset ?? {}) };
  for (const [asset, v] of Object.entries(e.amounts ?? {})) {
    const was = caps[asset];
    if (was === undefined) issues.push(`amount ${asset}: not in the plan, so it can't be added.`);
    else if (!uint(v)) issues.push(`amount ${asset}: must be a whole number of base units.`);
    else if (BigInt(v) > BigInt(was))
      issues.push(`amount ${asset}: ${v} is above the plan's ${was}; only lowering is allowed.`);
    else caps[asset] = v;
  }
  for (const a of e.removeAssets ?? []) delete caps[a];
  caps["*"] = "0";
  p.maxAmountPerAsset = caps;
  p.allowedAssets = list(base.allowedAssets).filter((a) => !(e.removeAssets ?? []).includes(a));
  p.allowedRecipients = list(base.allowedRecipients).filter(
    (r) => !(e.removeRecipients ?? []).includes(r),
  );
  return issues.length ? { ok: false, issues } : { ok: true, policy: p };
}

export const policyJson = (policy: Policy) =>
  JSON.stringify(
    { label: "SEAM builder policy (derived from the compiled plan)", policy },
    null,
    2,
  );

/** Reads an exported builder policy back with Sentinel's own parsePolicy. */
export function readPolicyJson(
  text: string,
): { ok: true; policy: Policy } | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const inner = (raw as { policy?: unknown })?.policy ?? raw;
  const r = parsePolicy(inner);
  return r.ok
    ? { ok: true, policy: r.policy }
    : { ok: false, message: r.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
}
