import type { Approval, Plan } from "../lib/types";
import type { GateOutcome } from "../lib/policygate";
import { PolicyGatePanel } from "./Modes";
import { checkWalletDemoPolicy, walletDemo, WALLET_DEMO_LABEL } from "../lib/walletdemo";

/** Manifest + strict policy pre-check for the V3 wallet demo, with the human approval button. Nothing is contacted here. */
export function WalletDemoCard({
  plan,
  approval,
  onApprove,
  engine,
  checking,
}: {
  plan: Plan;
  approval?: Approval;
  /** Runs the real policy engine (live facts + real preflight, read-only) and approves only if it allows. */
  onApprove: () => void;
  /** Result of the last real engine check. */
  engine?: GateOutcome;
  checking?: boolean;
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
      <p className="muted small">
        Console pre-check, display only. Approval is decided by the policy engine below.
      </p>
      <ul className="gatelist" aria-label="Policy pre-check">
        {pol.rules.map((r, i) => (
          <li key={i} className={r.outcome === "pass" ? "pass" : "bad"}>
            {r.outcome === "pass" ? "✓" : "Blocked:"} {r.rule}: {r.reason}
          </li>
        ))}
      </ul>
      {engine && <PolicyGatePanel gate={engine} />}
      <button disabled={checking || (!!approval && !approval.used)} onClick={onApprove}>
        {checking
          ? "Checking policy…"
          : approval && !approval.used
            ? "Approved"
            : "Check policy and approve"}
      </button>
      {!pol.allowed && (
        <p className="muted small">The display pre-check disagrees; the engine still decides.</p>
      )}
    </section>
  );
}
