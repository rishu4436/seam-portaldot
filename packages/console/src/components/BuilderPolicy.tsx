// Step 6 of the Manifest Builder: the strict policy derived from the compiled plan. The user can only tighten it (lower
// caps, drop assets or recipients), export it as JSON, and hand plan + manifest + policy to the real gate path.
import { useMemo, useState } from "react";
import type { Plan, Policy } from "@seam/policy/browser";
import { derivePolicy, policyJson, tightenPolicy } from "../lib/builderpolicy";

export interface BuilderSelection {
  plan: Plan;
  manifest: unknown;
  policy: Policy;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function BuilderPolicy({
  plan,
  manifest,
  onUse,
  readPreflight,
}: {
  plan: Plan;
  manifest: unknown;
  onUse?: (sel: BuilderSelection) => void;
  /** Real read-only preflight of this plan (@seam/chain/browser preflight). Its totalFee sets the fee cap. */
  readPreflight?: () => Promise<unknown>;
}) {
  const [preflight, setPreflight] = useState<unknown>();
  const [pfMsg, setPfMsg] = useState<string>();
  const derived = useMemo(() => derivePolicy(plan, { preflight }), [plan, preflight]);
  const fetchFee = async () => {
    setPfMsg(undefined);
    try {
      if (!readPreflight) throw new Error("no preflight reader in this build");
      setPreflight(await readPreflight());
    } catch (e) {
      setPreflight(undefined);
      setPfMsg(`Preflight failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const [maxFee, setMaxFee] = useState<string>();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [removeAssets, setRemoveAssets] = useState<string[]>([]);
  const [removeRecipients, setRemoveRecipients] = useState<string[]>([]);
  if (!derived.ok)
    return (
      <div aria-label="Builder policy" role="group">
        <button onClick={fetchFee} disabled={!readPreflight}>
          Read fee from preflight
        </button>
        {pfMsg && <p className="small">{pfMsg}</p>}
        <p role="alert" className="small">
          No policy{derived.code ? ` (${derived.code})` : ""}: {derived.message}
        </p>
      </div>
    );
  const base = derived.policy;
  const t = tightenPolicy(base, { maxFee, amounts, removeAssets, removeRecipients });
  const toggle = (xs: string[], x: string) =>
    xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x];
  const assets = Array.isArray(base.allowedAssets) ? base.allowedAssets : [];
  const recipients = Array.isArray(base.allowedRecipients) ? base.allowedRecipients : [];
  return (
    <div aria-label="Builder policy" role="group">
      <p className="muted small">
        Derived only from this plan: its capabilities, assets, recipients, amounts and mode, plus a
        fee cap. You can tighten it, never loosen it. The policy engine decides at the gate.
      </p>
      <ul className="small">
        <li>
          Capabilities:{" "}
          {(Array.isArray(base.allowedCapabilities) ? base.allowedCapabilities : []).join(", ")}
        </li>
        <li>Mode: {base.allowedModes.join(", ")}</li>
        <li>Max steps: {base.maxSteps}</li>
        <li>Max native value: {base.maxNativeValue}</li>
        <li>Any other asset: 0</li>
      </ul>
      {assets.map((a) => (
        <div key={a} className="row small">
          <label>
            <input
              type="checkbox"
              aria-label={`Allow asset ${a}`}
              checked={!removeAssets.includes(a)}
              onChange={() => setRemoveAssets((x) => toggle(x, a))}
            />{" "}
            Asset {a}, max per step
          </label>
          <input
            aria-label={`Max amount ${a}`}
            value={amounts[a] ?? base.maxAmountPerAsset?.[a] ?? ""}
            onChange={(e) => setAmounts((m) => ({ ...m, [a]: e.target.value }))}
          />
        </div>
      ))}
      {recipients.map((r) => (
        <label key={r} className="small">
          <input
            type="checkbox"
            aria-label={`Allow recipient ${r}`}
            checked={!removeRecipients.includes(r)}
            onChange={() => setRemoveRecipients((x) => toggle(x, r))}
          />{" "}
          Recipient <code>{r}</code>
        </label>
      ))}
      <label className="small">
        Fee cap (base units, preflight total fee + 25%)
        <input
          aria-label="Fee cap"
          value={maxFee ?? base.maxFee ?? ""}
          onChange={(e) => setMaxFee(e.target.value)}
        />
      </label>
      {!t.ok && (
        <ul role="alert" className="small">
          {t.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <button
          className="ghost"
          disabled={!t.ok}
          onClick={() => t.ok && download("seam-builder-policy.json", policyJson(t.policy))}
        >
          Export policy
        </button>
        <button
          disabled={!t.ok || !onUse}
          onClick={() => t.ok && onUse?.({ plan, manifest, policy: t.policy })}
        >
          Send to approval and signing
        </button>
      </div>
    </div>
  );
}
