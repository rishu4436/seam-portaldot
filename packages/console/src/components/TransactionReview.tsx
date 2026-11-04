import type { Plan } from "@seam/policy/browser";
import type { RuntimeFacts } from "@seam/compiler/browser";
import { formatUnits } from "./AccountReadiness";

/** Readable projection of decoded compiled calls. The original plan remains the signing authority. */
export function TransactionReview({
  plan,
  facts,
  feeEstimate,
  feeCap,
}: {
  plan: Plan;
  facts?: RuntimeFacts;
  feeEstimate?: string;
  feeCap?: string;
}) {
  const native = (value?: string) =>
    value && /^\d+$/.test(value)
      ? facts?.fingerprint
        ? `${formatUnits(value, facts.fingerprint.tokenDecimals)} ${facts.fingerprint.tokenSymbol} (${value} base units)`
        : `${value} native base units`
      : "Unavailable — read preflight again";
  return (
    <section className="transaction-review" aria-label="Transaction details">
      <h3>What you are approving</h3>
      <dl>
        <div>
          <dt>From account</dt>
          <dd>
            <code>{plan.signer.value}</code>
          </dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>
            {facts?.fingerprint?.specName ?? "Unknown"} · spec{" "}
            {facts?.fingerprint?.specVersion ?? "unknown"}
          </dd>
        </div>
      </dl>
      <ol>
        {plan.steps.map((step) => {
          const args = step.decodedArgs;
          const transfer = step.kind === "assets.transfer",
            mint = step.kind === "assets.mint";
          return (
            <li key={step.actionId}>
              <b>{transfer ? "Send assets" : mint ? "Mint assets" : step.capability}</b>
              <dl>
                {args.assetId !== undefined && (
                  <div>
                    <dt>Asset ID</dt>
                    <dd>{args.assetId}</dd>
                  </div>
                )}
                {args.recipient !== undefined && (
                  <div>
                    <dt>Recipient</dt>
                    <dd>
                      <code>{args.recipient}</code>
                    </dd>
                  </div>
                )}
                {args.amount !== undefined && (
                  <div>
                    <dt>Amount</dt>
                    <dd>{formatUnits(args.amount)} asset base units</dd>
                  </div>
                )}
                {args.contract !== undefined && (
                  <div>
                    <dt>Contract</dt>
                    <dd>
                      <code>{args.contract}</code>
                    </dd>
                  </div>
                )}
                {args.value !== undefined && (
                  <div>
                    <dt>Native value</dt>
                    <dd>{native(args.value)}</dd>
                  </div>
                )}
                <div>
                  <dt>Expected result</dt>
                  <dd>
                    {transfer
                      ? "The recipient receives this exact asset amount; the sender keeps the asset account alive."
                      : mint
                        ? "The recipient receives newly minted assets, subject to issuer permissions."
                        : "The compiled call succeeds. Contract or NFT effects are checked where supported."}
                  </dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ol>
      <dl className="review-fees">
        <div>
          <dt>Estimated network fee</dt>
          <dd>{native(feeEstimate)}</dd>
        </div>
        <div>
          <dt>Maximum approved network fee</dt>
          <dd>{native(feeCap)}</dd>
        </div>
      </dl>
      <p className="muted">
        The fee estimate can change. Account checks and fees are checked again before signing;
        success requires finality and effect verification. Asset amounts are base units, with no
        assumed token decimals.
      </p>
    </section>
  );
}
