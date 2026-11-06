import { useEffect, useRef, useState } from "react";
import { readAccountReadiness, type AccountReadiness as Observation } from "@seam/chain/browser";
import type { RuntimeFacts } from "@seam/compiler/browser";
import type { RpcTransport } from "../lib/chainclient";
import { ReadProgress } from "./ReadProgress";

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
  transportFor: suppliedTransport,
  onChooseAsset,
  read: readBalances = readAccountReadiness,
}: {
  address: string;
  facts?: RuntimeFacts;
  rpcUrl: string;
  transportFor?: (url: string) => RpcTransport;
  onChooseAsset?: (assetId: string) => void;
  read?: typeof readAccountReadiness;
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
    if (address && facts) void read();
    return () => {
      revision.current++;
    };
  }, [address, facts, rpcUrl, suppliedTransport, readBalances]);
  const read = async (more = false) => {
    if (!facts || !address) return;
    const version = ++revision.current;
    setBusy(true);
    setProblem(undefined);
    if (!more) setResult(undefined);
    try {
      const ids = assets
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const transportFor = suppliedTransport ?? (await import("../lib/browserChain")).transportFor;
      const send = transportFor(rpcUrl);
      let accumulated = more ? result : undefined;
      // Automatically scan up to 128 registered assets per read; larger networks can continue explicitly.
      for (let page = 0; page < 4; page++) {
        const observed = await readBalances(send, facts, address, page === 0 ? ids : [], {
          discover: true,
          ...(accumulated
            ? { after: accumulated.discovery?.nextCursor, at: accumulated.block.hash }
            : {}),
        });
        if (version !== revision.current) return;
        const merged = new Map(accumulated?.assets.map((item) => [item.assetId, item]));
        for (const item of observed.assets) merged.set(item.assetId, item);
        accumulated = {
          ...observed,
          assets: [...merged.values()],
          discovery: observed.discovery && {
            ...observed.discovery,
            scanned: (accumulated?.discovery?.scanned ?? 0) + observed.discovery.scanned,
          },
        };
        setResult(accumulated);
        if (!observed.discovery?.nextCursor || observed.discovery.reason) break;
      }
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
          <b>Your testnet assets</b>
          <p>
            Balances load automatically after your wallet and live network are connected. Choose an
            asset to start a transfer.
          </p>
        </div>
        <button className="ghost" disabled={!address || !facts || busy} onClick={() => void read()}>
          {busy ? "Reading balances…" : "Read balances"}
        </button>
      </div>
      <ReadProgress active={busy} label="Reading native balances and discovering your assets…" />
      <details>
        <summary>Look up an asset manually</summary>
        <label>
          Asset IDs to inspect <small>(optional, comma separated)</small>
          <input
            value={assets}
            placeholder="e.g. 100, 200"
            onChange={(e) => {
              revision.current++;
              setBusy(false);
              setResult(undefined);
              setAssets(e.target.value);
            }}
          />
        </label>
        <p className="muted">
          Use Read balances after entering IDs. A transfer requires an asset balance; minting
          requires issuer rights.
        </p>
      </details>
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
                {item.balance.known && item.balance.value.isSufficient === false && (
                  <small>
                    This asset requires recipients to have native tPOT before they can hold it.
                    Sender tPOT pays the transaction fee separately.
                  </small>
                )}
                {onChooseAsset && item.balance.known && BigInt(item.balance.value.balance) > 0n && (
                  <button className="ghost xs" onClick={() => onChooseAsset(item.assetId)}>
                    Send asset {item.assetId}
                  </button>
                )}
              </div>
            ))}
          </dl>
          {result.discovery && (
            <p role="status" className="muted">
              {result.discovery.reason
                ? `Discovery incomplete: ${result.discovery.reason} You can retry or look up an asset manually.`
                : `${result.discovery.scanned} assets checked at this block. ${result.discovery.complete ? "Discovery complete." : "More assets remain to be checked."}`}
            </p>
          )}
          {result.assets.some((item) => !item.balance.known) && (
            <p role="status">
              Some asset balances could not be read. Retry before assuming the account has no
              assets.
            </p>
          )}
          {result.discovery?.complete &&
            result.assets.every((item) => item.balance.known) &&
            !result.assets.some(
              (item) => item.balance.known && BigInt(item.balance.value.balance) > 0n,
            ) && (
              <p>
                No asset balances found for this account. Receive an asset from a holder to make a
                transfer.
              </p>
            )}
          {result.discovery?.nextCursor && (
            <button className="ghost" disabled={busy} onClick={() => void read(true)}>
              Find more assets
            </button>
          )}
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
