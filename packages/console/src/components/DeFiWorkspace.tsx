import { useCallback, useState } from "react";
import NativeSwapWorkspace from "./NativeSwapWorkspace";
import ContractDeFiWorkspace from "./ContractDeFiWorkspace";
import "./defi.css";
export default function DeFiWorkspace({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [mode, setMode] = useState<"native" | "contracts">("native"),
    [busy, setBusy] = useState(false);
  const changed = useCallback(
    (value: boolean) => {
      setBusy(value);
      onBusyChange(value);
    },
    [onBusyChange],
  );
  return (
    <>
      <nav className="defi-route-nav" aria-label="DeFi route">
        <button aria-pressed={mode === "native"} disabled={busy} onClick={() => setMode("native")}>
          Native swaps
        </button>
        <button
          aria-pressed={mode === "contracts"}
          disabled={busy}
          onClick={() => setMode("contracts")}
        >
          Contract markets & vaults
        </button>
      </nav>
      {mode === "native" ? (
        <NativeSwapWorkspace onBusyChange={changed} />
      ) : (
        <ContractDeFiWorkspace onBusyChange={changed} />
      )}
    </>
  );
}
