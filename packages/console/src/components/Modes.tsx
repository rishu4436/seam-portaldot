import { useEffect, useRef, useState } from "react";
import { MODES, COVERAGE_LABEL, SIMULATION_LABEL, PROVENANCE_LABEL, SEAM_CODE_LABEL, type SeamCode, type SimulationBasis, TX_STATE_LABEL, SIGNING_LABEL, type Coverage, type Mode, type ModeDowngrade, type Provenance, type TxState } from "../lib/modes";
import { runLive, v3RpcUrl, type LiveOutcome } from "../lib/live";
import { finalityView } from "../lib/finality";
import { policyLimitGroups, atomicitySource, type PolicyLike, type BehaviourLike } from "../lib/limits";
import { radioNext, isEscape } from "../lib/a11y";
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
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = radioNext(e.key, i, MODES.length);
    if (n === undefined) return;
    e.preventDefault(); onChange(MODES[n].id); refs.current[n]?.focus();
  };
  return (
    <div className="modeswitch" role="radiogroup" aria-label="Console mode">
      {MODES.map((m, i) => (
        <button key={m.id} ref={(el) => { refs.current[i] = el; }} role="radio" aria-checked={mode === m.id} tabIndex={mode === m.id ? 0 : -1} onKeyDown={(e) => onKey(e, i)} className={`scenbtn src ${mode === m.id ? "on" : ""}`} onClick={() => onChange(m.id)}>
          <b>{m.label}</b><span>{m.id === "live" ? "Blocked until a V3 RPC URL is set" : m.id === "recorded" ? "Replay of real local run" : "Synthetic demo"}</span>
        </button>
      ))}
    </div>
  );
}

const TONE_WORD: Record<string, string> = { ok: "good", bad: "problem", warn: "caution", info: "info", muted: "neutral" };
// Colour is never the only signal: the text is the label, and a visually hidden tone word backs it up for screen readers.
const Tag = ({ tone, children }: { tone: string; children: React.ReactNode }) => <span className={`pill ${tone}`}><span className="sr">{TONE_WORD[tone] ?? tone}: </span>{children}</span>;
export const CoverageBadge = ({ c }: { c: Coverage }) => <Tag tone={c === "effect_proven" ? "ok" : c === "none" || c === "contract_emitted" ? "warn" : "info"}>{COVERAGE_LABEL[c]}</Tag>;
export const SimulationBadge = ({ b }: { b: SimulationBasis }) => <Tag tone={b === "signed_dry_run" ? "ok" : b === "none" ? "warn" : "info"}>{SIMULATION_LABEL[b]}</Tag>;
export const SeamCodeBadge = ({ c }: { c: SeamCode }) => <Tag tone={SEAM_CODE_LABEL[c].tone}>{SEAM_CODE_LABEL[c].text}</Tag>;
export const WeakProofBadge = ({ show }: { show: boolean }) => show ? <span className="pill warn" title="Backed by estimates or a policy exception, not a dry run of the signed transaction" aria-label="weaker proof: backed by estimates or a policy exception, not a dry run of the signed transaction">weaker proof</span> : null;
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

export function RejectionNotice({ onRetry, onDismiss }: { onRetry: () => void; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div ref={ref} tabIndex={-1} className="errbox rejected" role="alertdialog" aria-labelledby="rej-title" aria-describedby="rej-desc" onKeyDown={(e) => { if (isEscape(e.key)) onDismiss(); }}>
      <b id="rej-title">Wallet rejected the signing request</b>
      <p id="rej-desc">You rejected it in your wallet. Nothing was sent and your approval was not consumed, so you can try again. Press Escape to dismiss.</p>
      <div className="actions"><button onClick={onRetry}>Retry signing</button><button className="ghost" onClick={onDismiss}>Dismiss</button></div>
    </div>
  );
}

export function FinalityPanel({ out }: { out: LiveOutcome }) {
  const v = finalityView(out);
  if (v.key === "none") return null;
  return (
    <div className="finality" role="group" aria-label="Transaction confirmation">
      <div className="row"><b>Transaction</b><Tag tone={v.tone}>{v.label}</Tag></div>
      <p>{v.message}</p>
      <dl className="kv small">
        <dt>Tx hash</dt><dd>{v.txHash ? <code className="wrap">{v.txHash}</code> : "not known"}</dd>
        <dt>Block</dt><dd>{v.blockNumber != null ? `#${v.blockNumber}` : "not known"}{v.blockHash && <> <code className="wrap">{v.blockHash}</code></>}</dd>
      </dl>
      {v.reconcileFirst && <p className="small"><b>Do not retry yet.</b> Check the chain for this transaction first.</p>}
    </div>
  );
}

export function LivePanel() {
  const [url, setUrl] = useState<string>(import.meta.env.VITE_V3_RPC_URL ?? "");
  const [out, setOut] = useState<LiveOutcome>();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [attempts, setAttempts] = useState(3);
  const ok = !!v3RpcUrl(url);
  // Real browser JSON-RPC client and extension signer, both created lazily on click. With no valid URL runLive blocks before any of them is used.
  // The signed-bytes verifier and extrinsic assembler are host-injected (they need @seam/chain / SCALE), so without them LIVE stays blocked before signing.
  const run = async () => {
    setBusy(true); setDismissed(false);
    try {
      const u = v3RpcUrl(url);
      // Lazy browser entry: only loaded once a valid URL is submitted.
      let deps = {};
      if (u) { const b = await import("../lib/browserChain"); deps = { chain: b.createBrowserChainClient(b.transportFor(u)), signer: b.createExtensionSigner(), maxRpcAttempts: attempts }; }
      setOut(await runLive(url, {}, deps));
    } finally { setBusy(false); }
  };
  return (
    <section className="grid2">
      <div className="card">
        <h3>LIVE V3</h3>
        <p className="muted">Uses a real V3 RPC and your own wallet. No V3 endpoint is configured by default, so nothing here can succeed yet. Local spec-1002 results do not prove anything about V3 Revive.</p>
        <label htmlFor="v3url">V3 RPC URL</label>
        <div className="row"><input id="v3url" placeholder="wss://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={!!url && !ok} aria-describedby="v3url-help" /><button disabled={busy} onClick={run}>{busy ? "Checking…" : out ? "Retry connection" : "Check live"}</button></div>
        <div className="row small" style={{ marginTop: 8 }}>
          <label htmlFor="v3attempts">RPC retry attempts</label>
          <select id="v3attempts" value={attempts} onChange={(e) => setAttempts(Number(e.target.value))}>{[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          <span className="muted">Only the read-only discovery is retried. A submit is never retried automatically.</span>
        </div>
        <p id="v3url-help" className="muted small">{!url ? "Empty: LIVE V3 stays blocked." : !ok ? "Not a valid ws(s):// or http(s):// URL." : "Valid URL. Nothing is contacted until you press the button."}</p>
        {out?.status === "rejected" && !dismissed && <RejectionNotice onRetry={run} onDismiss={() => setDismissed(true)} />}
      </div>
      <div className="card" aria-live="polite" aria-atomic="false">
        <div className="row between"><h3>Live status</h3>{out ? <Tag tone={STATUS_TONE[out.status]}>{out.status}</Tag> : <Tag tone="warn">blocked / unknown</Tag>}</div>
        {!out ? <p className="muted">Nothing checked yet. Status is unknown, not success.</p> : (
          <>
            <p>{out.message}</p>
            <FinalityPanel out={out} />
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

export function RiskLimits({ policy, behaviour }: { policy?: PolicyLike; behaviour?: BehaviourLike }) {
  const groups = policyLimitGroups(policy);
  const at = atomicitySource(behaviour);
  return (
    <section className="card limits" aria-labelledby="limits-h">
      <div className="row between"><h3 id="limits-h">Risk limits</h3><Tag tone={at.status === "atomic_verified" ? "ok" : "warn"}>{at.status === "atomic_verified" ? "atomic_verified" : "not proven"}</Tag></div>
      {!groups ? <p className="muted">The policy limits were not provided with this result, so none are shown. They are not guessed.</p> : groups.map((g) => (
        <div key={g.title}>
          <h4>{g.title}</h4>
          <dl className="kv small">{g.rows.map((r) => <><dt key={r.key + "k"}>{r.label}</dt><dd key={r.key + "v"} className={r.set ? "" : "muted"}>{r.value}</dd></>)}</dl>
        </div>
      ))}
      <h4>Atomicity proof source</h4>
      <p className="small"><b>{at.label}.</b> {at.detail}</p>
      {at.proof && <dl className="kv small">
        <dt>Genesis</dt><dd><code className="wrap">{at.proof.genesisHash ?? "missing"}</code></dd>
        <dt>Metadata hash</dt><dd><code className="wrap">{at.proof.metadataHash ?? "missing"}</code></dd>
        <dt>Spec version</dt><dd>{at.proof.specVersion ?? "missing"}</dd>
        <dt>Tx / block</dt><dd><code className="wrap">{at.proof.txHash ?? at.proof.blockHash ?? "missing"}</code></dd>
      </dl>}
    </section>
  );
}
