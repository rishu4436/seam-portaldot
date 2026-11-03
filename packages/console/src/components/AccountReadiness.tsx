import { useEffect, useRef, useState } from "react";
import { readAccountReadiness, type AccountReadiness as Observation } from "@seam/chain/browser";
import type { RuntimeFacts } from "@seam/compiler/browser";

export function formatUnits(raw: string, decimals = 0): string {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 30)
    return raw;
  const n = BigInt(raw),
    unit = 10n ** BigInt(decimals),
    fraction = (n % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(n / unit).toLocaleString("en-US")}${decimals && fraction ? `.${fraction}` : ""}`;
}
export function AccountReadiness({
  address,
  facts,
  rpcUrl,
}: {
  address: string;
  facts?: RuntimeFacts;
  rpcUrl: string;
}) {
  const [assets, setAssets] = useState("");
  const [result, setResult] = useState<Observation>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const token = facts?.fingerprint;
  const displayNative = (raw: string) =>
    token &&
    Number.isInteger(token.tokenDecimals) &&
    token.tokenDecimals >= 0 &&
    token.tokenDecimals <= 30
      ? `${formatUnits(raw, token.tokenDecimals)} ${token.tokenSymbol}`
      : `${formatUnits(raw)} base units`;
  useEffect(() => {
    revision.current++;
    setResult(undefined);
    setProblem(undefined);
    setBusy(false);
  }, [address, facts, rpcUrl, assets]);
  const read = async () => {
    if (!facts) return;
    const version = ++revision.current;
    setBusy(true);
    setProblem(undefined);
    setResult(undefined);
    try {
      const ids = assets
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const { transportFor } = await import("../lib/browserChain");
      const observed = await readAccountReadiness(transportFor(rpcUrl), facts, address, ids);
      if (version === revision.current) setResult(observed);
    } catch (error) {
      if (version === revision.current)
        setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === revision.current) setBusy(false);
    }
  };
  return (
    <section className="account-readiness" aria-label="Account readiness">
      <div className="feature-row">
        <div>
          <b>Check your testnet funds</b>
          <p>
            Read balances before preparing a payment. Fees and permissions are checked again before
            signing.
          </p>
        </div>
        <button className="ghost" disabled={!address || !facts || busy} onClick={() => void read()}>
          {busy ? "Reading balances…" : "Read balances"}
        </button>
      </div>
      <label>
        Asset IDs to inspect <small>(optional, comma separated)</small>
        <input
          value={assets}
          placeholder="e.g. 100, 200"
          onChange={(e) => setAssets(e.target.value)}
        />
      </label>
      {!address && <p className="muted">Select a connected account to inspect its funds.</p>}
      {problem && <p role="alert">{problem}</p>}
      {result && (
        <>
          <p className="muted">Finalized block #{result.block.number.toLocaleString()}</p>
          <dl className="balance-grid">
            <div>
              <dt>Native free balance</dt>
              <dd>
                {result.native.known ? displayNative(result.native.value.free) : "Unavailable"}
              </dd>
              {result.native.known && (
                <small>{formatUnits(result.native.value.free)} base units</small>
              )}
            </div>
            <div>
              <dt>Native frozen balance</dt>
              <dd>
                {result.native.known ? displayNative(result.native.value.frozen) : "Unavailable"}
              </dd>
            </div>
            <div>
              <dt>Minimum account balance</dt>
              <dd>
                {result.native.known
                  ? displayNative(result.native.value.existentialDeposit)
                  : "Unavailable"}
              </dd>
            </div>
            {result.assets.map((item) => (
              <div key={item.assetId}>
                <dt>Asset {item.assetId} · base units</dt>
                <dd>
                  {item.balance.known
                    ? item.balance.value.exists
                      ? formatUnits(item.balance.value.balance)
                      : "Asset does not exist"
                    : "Unavailable"}
                </dd>
                {!item.balance.known && <small>{item.balance.reason}</small>}
              </div>
            ))}
          </dl>
          {!result.native.known ? (
            <p role="status">{result.native.reason}</p>
          ) : (
            BigInt(result.native.value.free) <= BigInt(result.native.value.frozen) && (
              <p className="workspace-notice">
                No unlocked native balance was observed. Add V3 testnet native tokens to cover fees
                before signing.
              </p>
            )
          )}
          <p className="muted">
            Free balance may include funds subject to locks. This read is not a fee quote or a
            guarantee the transaction can execute.
          </p>
        </>
      )}
    </section>
  );
}
