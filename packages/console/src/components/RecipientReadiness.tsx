import { useEffect, useState } from "react";
import { readRecipientReadiness, type RecipientReadiness as Result } from "@seam/chain/browser";
import type { RuntimeFacts } from "@seam/compiler/browser";
import type { RpcTransport } from "../lib/chainclient";
import { formatUnits } from "./AccountReadiness";

export function RecipientReadiness({
  recipient,
  assetId,
  amount,
  facts,
  rpcUrl,
  transportFor: suppliedTransport,
  read = readRecipientReadiness,
}: {
  recipient: string;
  assetId: string;
  amount: string;
  facts: RuntimeFacts;
  rpcUrl: string;
  transportFor?: (url: string) => RpcTransport;
  read?: typeof readRecipientReadiness;
}) {
  const [state, setState] = useState<{ key: string; result?: Result; problem?: string }>();
  const [attempt, setAttempt] = useState(0);
  const key = `${recipient}|${assetId}|${amount}|${rpcUrl}|${facts.fingerprintDigest}`;
  const valid =
    /^(0|[1-9]\d*)$/.test(assetId) && /^[1-9]\d*$/.test(amount) && recipient.length >= 40;
  useEffect(() => {
    if (!valid) return;
    let active = true;
    setState(undefined);
    const timer = setTimeout(() => {
      void (async () => {
        const transportFor =
          suppliedTransport ?? (await import("../lib/browserChain")).transportFor;
        return read(transportFor(rpcUrl), facts, recipient, assetId, amount);
      })()
        .then((result) => active && setState({ key, result }))
        .catch(
          (error: unknown) =>
            active &&
            setState({ key, problem: error instanceof Error ? error.message : String(error) }),
        );
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, facts, valid, suppliedTransport, read, attempt]);
  if (!valid)
    return (
      <p className="muted">
        Enter an asset, recipient and positive amount to check recipient readiness.
      </p>
    );
  const current = state?.key === key ? state : undefined;
  return (
    <section
      className={`recipient-readiness ${current?.result?.status ?? "unknown"}`}
      aria-label="Recipient readiness"
    >
      <b>Recipient readiness</b>
      <p role="status">
        {current?.problem
          ? `Check unavailable: ${current.problem}`
          : (current?.result?.message ?? "Checking recipient requirements…")}
      </p>
      {current?.result?.nativeShortfall && BigInt(current.result.nativeShortfall) > 0n && (
        <p>
          Native funding shortfall:{" "}
          {formatUnits(current.result.nativeShortfall, facts.fingerprint.tokenDecimals)}{" "}
          {facts.fingerprint.tokenSymbol}, to reach the runtime minimum. Allow extra for account
          changes and fees on the funding transfer.
        </p>
      )}
      {current?.result && (
        <small>
          Checked at block #{current.result.block.number.toLocaleString()}. This is an account
          check; the signed dry run still decides whether the transfer can execute.
        </small>
      )}
      {current && (
        <button
          className="ghost xs"
          onClick={() => {
            setState(undefined);
            setAttempt((a) => a + 1);
          }}
        >
          Check recipient again
        </button>
      )}
    </section>
  );
}
