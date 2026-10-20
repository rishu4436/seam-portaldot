import type { Approval, Plan } from "../lib/types";
import { checkWalletDemoPolicy, walletDemo, WALLET_DEMO_LABEL } from "../lib/walletdemo";

/** Manifest + strict policy pre-check for the V3 wallet demo, with the human approval button. Nothing is contacted here. */
export function WalletDemoCard({
  plan,
  approval,
  onApprove,
}: {
  plan: Plan;
  approval?: Approval;
  onApprove: () => void;
}) {
  const pol = checkWalletDemoPolicy(plan);
  const p = walletDemo.policy;
  return (
    <section className="card" aria-labelledby="wd-h">
      <h3 id="wd-h">{WALLET_DEMO_LABEL}</h3>
      <p className="muted small">{walletDemo.note}</p>
      <dl className="kv small">
        <dt>Mode</dt>
        <dd>
          {plan.mode}
          {plan.modeReason ? ` (${plan.modeReason})` : ""}
        </dd>
        <dt>Policy</dt>
        <dd>
          only {p.allowedCapabilities.join(", ")}; asset {p.allowedAssets.join(", ")}; max{" "}
          {p.maxAmountPerAsset[p.allowedAssets[0]]} base units; {p.maxSteps} step; approval valid{" "}
          {p.maxApprovalSeconds}s; signed dry run required at the gate
        </dd>
      </dl>
      <ul className="gatelist" aria-label="Policy pre-check">
        {pol.rules.map((r, i) => (
          <li key={i} className={r.outcome === "pass" ? "pass" : "bad"}>
            {r.outcome === "pass" ? "✓" : "Blocked:"} {r.rule}: {r.reason}
          </li>
        ))}
      </ul>
      <button disabled={!pol.allowed || (!!approval && !approval.used)} onClick={onApprove}>
        {approval && !approval.used ? "Approved" : "Approve this plan"}
      </button>
    </section>
  );
}
