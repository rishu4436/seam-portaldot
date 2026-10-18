import { useState } from "react";
import { MODES, COVERAGE_LABEL, SIMULATION_LABEL, PROVENANCE_LABEL, SEAM_CODE_LABEL, type SeamCode, type SimulationBasis, TX_STATE_LABEL, SIGNING_LABEL, type Coverage, type Mode, type ModeDowngrade, type Provenance, type TxState } from "../lib/modes";
import { runLive, v3RpcUrl, type LiveOutcome } from "../lib/live";
import "./modes.css";

export function ModeBadge({ mode }: { mode: Mode }) {
  const m = MODES.find((x) => x.id === mode)!;
  return (
    <div className={`modebadge ${m.tone}`} role="status" aria-live="polite">
      <b>{m.badge}</b><span>{m.hint}</span>
      {mode === "recorded" && <small>Local Portaldot dev node, spec 1002. Not the V3 hosted testnet, not mainnet.</small>}
      {mode === "offline" && <small>Synthetic: tx hashes, blocks and timings are simulated. Nothing here touched a chain.</small>}
    </div>
  );
}

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="modeswitch" role="radiogroup" aria-label="Console mode">
      {MODES.map((m) => (
        <button key={m.id} role="radio" aria-checked={mode === m.id} className={`scenbtn src ${mode === m.id ? "on" : ""}`} onClick={() => onChange(m.id)}>
          <b>{m.label}</b><span>{m.id === "live" ? "Blocked until a V3 RPC URL is set" : m.id === "recorded" ? "Replay of real local run" : "Synthetic demo"}</span>
        </button>
      ))}
    </div>
  );
}

const Tag = ({ tone, children }: { tone: string; children: React.ReactNode }) => <span className={`pill ${tone}`}>{children}</span>;
export const CoverageBadge = ({ c }: { c: Coverage }) => <Tag tone={c === "effect_proven" ? "ok" : c === "none" || c === "contract_emitted" ? "warn" : "info"}>{COVERAGE_LABEL[c]}</Tag>;
export const SimulationBadge = ({ b }: { b: SimulationBasis }) => <Tag tone={b === "signed_dry_run" ? "ok" : b === "none" ? "warn" : "info"}>{SIMULATION_LABEL[b]}</Tag>;
export const SeamCodeBadge = ({ c }: { c: SeamCode }) => <Tag tone={SEAM_CODE_LABEL[c].tone}>{SEAM_CODE_LABEL[c].text}</Tag>;
export const WeakProofBadge = ({ show }: { show: boolean }) => show ? <span className="pill warn" title="Backed by estimates or a policy exception, not a dry run of the signed transaction">weaker proof</span> : null;
export const ProvenanceBadge = ({ p }: { p: Provenance }) => <Tag tone={PROVENANCE_LABEL[p].tone}>{PROVENANCE_LABEL[p].text}</Tag>;
export const TxStateBadge = ({ s }: { s: TxState }) => <Tag tone={TX_STATE_LABEL[s].tone}>{TX_STATE_LABEL[s].text}</Tag>;

export function DowngradeWarning({ d }: { d?: ModeDowngrade }) {
  if (!d) return null;
  return (
    <div className="downgrade" role="alert">
      <b>{d.requiresApproval ? "Approval needed: " : ""}this plan was downgraded from {d.from} to {d.to}.</b>
      <p>Steps run one transaction at a time, so a later step can fail after earlier ones already landed. {d.partialExecutionRisk ?? "Partial execution is possible."}</p>
    </div>
  );
}

export function copyText(t: string) { void navigator.clipboard?.writeText(t); }
export function downloadJson(name: string, v: unknown) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(v, null, 2)], { type: "application/json" }));
  a.download = name; a.click();
}
export function JsonActions({ label, value, file }: { label: string; value: unknown; file: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="row">
      <button className="ghost xs" onClick={() => { copyText(JSON.stringify(value, null, 2)); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? "Copied" : `Copy ${label} JSON`}</button>
      <button className="ghost xs" onClick={() => downloadJson(file, value)}>Download {label} JSON</button>
    </span>
  );
}

const STATUS_TONE: Record<LiveOutcome["status"], string> = { blocked: "warn", unknown: "warn", rejected: "bad", failed: "bad", uncertain: "warn", unverified: "info", verified: "ok" };

export function LivePanel() {
  const [url, setUrl] = useState<string>(import.meta.env.VITE_V3_RPC_URL ?? "");
  const [out, setOut] = useState<LiveOutcome>();
  const [busy, setBusy] = useState(false);
  const ok = !!v3RpcUrl(url);
  // No ChainClient / WalletSigner is wired in this build, so runLive answers blocked/unknown.
  const run = async () => { setBusy(true); try { setOut(await runLive(url, {}, {})); } finally { setBusy(false); } };
  return (
    <section className="grid2">
      <div className="card">
        <h3>LIVE V3</h3>
        <p className="muted">Uses a real V3 RPC and your own wallet. No V3 endpoint is configured by default, so nothing here can succeed yet. Local spec-1002 results do not prove anything about V3 Revive.</p>
        <label htmlFor="v3url">V3 RPC URL</label>
        <div className="row"><input id="v3url" placeholder="wss://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={!!url && !ok} /><button disabled={busy} onClick={run}>{out ? "Retry" : "Check live"}</button></div>
        {!!url && !ok && <p className="muted small">Not a valid ws(s):// or http(s):// URL.</p>}
        {!url && <p className="muted small">Empty: LIVE V3 stays blocked.</p>}
      </div>
      <div className="card">
        <div className="row between"><h3>Live status</h3>{out ? <Tag tone={STATUS_TONE[out.status]}>{out.status}</Tag> : <Tag tone="warn">blocked / unknown</Tag>}</div>
        {!out ? <p className="muted">Nothing checked yet. Status is unknown, not success.</p> : (
          <>
            <p>{out.message}</p>
            <dl className="kv">
              <dt>Network</dt><dd>{out.fingerprint ? `${out.fingerprint.specName ?? "?"} spec ${out.fingerprint.specVersion ?? "?"}` : "unknown"}</dd>
              <dt>Fingerprint</dt><dd><code>{out.fingerprint?.digest ?? "unknown"}</code>{out.fingerprint?.fingerprintSchemaVersion != null && <small className="muted"> schema v{out.fingerprint.fingerprintSchemaVersion}</small>}</dd>
              <dt>Signing</dt><dd>{SIGNING_LABEL[out.signing]}</dd>
              <dt>Simulation</dt><dd><SimulationBadge b={out.simulation} /></dd>
              <dt>Coverage</dt><dd><CoverageBadge c={out.coverage} /></dd>
              <dt>Transaction</dt><dd><TxStateBadge s={out.txState} /></dd>
              <dt>Provenance</dt><dd><ProvenanceBadge p={out.provenance} /></dd>
              {out.rpcAttempts > 0 && <><dt>RPC attempts</dt><dd>{out.rpcAttempts}</dd></>}
            </dl>
          </>
        )}
      </div>
    </section>
  );
}
