import { useEffect, useRef, useState } from "react";
import {
  checkAssetsTransferEffect,
  type EffectVerdict,
  type TransferExpectation,
} from "../lib/effectcheck";
import {
  MODES,
  COVERAGE_LABEL,
  SIMULATION_LABEL,
  PROVENANCE_LABEL,
  SEAM_CODE_LABEL,
  type SeamCode,
  type SimulationBasis,
  TX_STATE_LABEL,
  SIGNING_LABEL,
  type Coverage,
  type Mode,
  type ModeDowngrade,
  type Provenance,
  type TxState,
} from "../lib/modes";
import { runLive, v3RpcUrl, type LiveOutcome, type LiveDeps } from "../lib/live";
import { planCall, fingerprintMatches } from "../lib/liverequest";
import { loadLiveHost, hasChainFacts, type LiveHost } from "../lib/host";
import {
  V3_HTTPS_RPC,
  discoverV3Facts,
  discoverV3LiveFacts,
  loadFactsSnapshot,
  type FactsBuilder,
  type V3FactsResult,
} from "../lib/v3facts";
import type { RpcTransport } from "../lib/chainclient";

/** Default facts step: committed V3 snapshot + live metadata over HTTPS (read-only). */
export async function defaultV3Facts(rpc: RpcTransport): Promise<V3FactsResult> {
  const [snap, crypto] = await Promise.all([loadFactsSnapshot(), import("@polkadot/util-crypto")]);
  return discoverV3Facts(rpc, snap, (h) => crypto.blake2AsHex(h, 256));
}

/**
 * LIVE facts step: real RuntimeFacts built in the browser by @seam/chain/browser's factsFromChainInputs from this node's own
 * reads. The recorded snapshot is loaded only for comparison in the notice. A builder error fails closed (no facts, no host).
 * The snapshot-based defaultV3Facts above is kept as a labelled fallback for display/tests, not used by default.
 */
export async function liveFactsStep(rpc: RpcTransport): Promise<V3FactsResult> {
  const [snap, mod] = await Promise.all([
    loadFactsSnapshot().catch(() => undefined),
    import("@seam/chain/browser"),
  ]);
  return discoverV3LiveFacts(rpc, mod.factsFromChainInputs as unknown as FactsBuilder, {
    snapshot: snap,
  });
}
import type { Approval, Plan, RuntimeFacts } from "../lib/types";
import { finalityView } from "../lib/finality";
import {
  policyLimitGroups,
  atomicitySource,
  type PolicyLike,
  type BehaviourLike,
} from "../lib/limits";
import { radioNext, isEscape } from "../lib/a11y";
import "./modes.css";

export function ModeBadge({ mode }: { mode: Mode }) {
  const m = MODES.find((x) => x.id === mode)!;
  return (
    <div className={`modebadge ${m.tone}`} role="status" aria-live="polite">
      <b>{m.badge}</b>
      <span>{m.hint}</span>
      {mode === "recorded" && (
        <small>Local Portaldot dev node, spec 1002. Not the V3 hosted testnet, not mainnet.</small>
      )}
      {mode === "offline" && (
        <small>
          Synthetic: tx hashes, blocks and timings are simulated. Nothing here touched a chain.
        </small>
      )}
    </div>
  );
}

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = radioNext(e.key, i, MODES.length);
    if (n === undefined) return;
    e.preventDefault();
    onChange(MODES[n].id);
    refs.current[n]?.focus();
  };
  return (
    <div className="modeswitch" role="radiogroup" aria-label="Console mode">
      {MODES.map((m, i) => (
        <button
          key={m.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="radio"
          aria-checked={mode === m.id}
          tabIndex={mode === m.id ? 0 : -1}
          onKeyDown={(e) => onKey(e, i)}
          className={`scenbtn src ${mode === m.id ? "on" : ""}`}
          onClick={() => onChange(m.id)}
        >
          <b>{m.label}</b>
          <span>
            {m.id === "live"
              ? "V3 testnet over HTTPS by default"
              : m.id === "recorded"
                ? "Replay of real local run"
                : "Synthetic demo"}
          </span>
        </button>
      ))}
    </div>
  );
}

const TONE_WORD: Record<string, string> = {
  ok: "good",
  bad: "problem",
  warn: "caution",
  info: "info",
  muted: "neutral",
};
// Colour is never the only signal: the text is the label, and a visually hidden tone word backs it up for screen readers.
const Tag = ({ tone, children }: { tone: string; children: React.ReactNode }) => (
  <span className={`pill ${tone}`}>
    <span className="sr">{TONE_WORD[tone] ?? tone}: </span>
    {children}
  </span>
);
export const CoverageBadge = ({ c }: { c: Coverage }) => (
  <Tag
    tone={c === "effect_proven" ? "ok" : c === "none" || c === "contract_emitted" ? "warn" : "info"}
  >
    {COVERAGE_LABEL[c]}
  </Tag>
);
export const SimulationBadge = ({ b }: { b: SimulationBasis }) => (
  <Tag tone={b === "signed_dry_run" ? "ok" : b === "none" ? "warn" : "info"}>
    {SIMULATION_LABEL[b]}
  </Tag>
);
export const SeamCodeBadge = ({ c }: { c: SeamCode }) => (
  <Tag tone={SEAM_CODE_LABEL[c].tone}>{SEAM_CODE_LABEL[c].text}</Tag>
);
export const WeakProofBadge = ({ show }: { show: boolean }) =>
  show ? (
    <span
      className="pill warn"
      title="Backed by estimates or a policy exception, not a dry run of the signed transaction"
      aria-label="weaker proof: backed by estimates or a policy exception, not a dry run of the signed transaction"
    >
      weaker proof
    </span>
  ) : null;
export const ProvenanceBadge = ({ p }: { p: Provenance }) => (
  <Tag tone={PROVENANCE_LABEL[p].tone}>{PROVENANCE_LABEL[p].text}</Tag>
);
export const TxStateBadge = ({ s }: { s: TxState }) => (
  <Tag tone={TX_STATE_LABEL[s].tone}>{TX_STATE_LABEL[s].text}</Tag>
);

export function DowngradeWarning({ d }: { d?: ModeDowngrade }) {
  if (!d) return null;
  return (
    <div className="downgrade" role="alert">
      <b>
        {d.requiresApproval ? "Approval needed: " : ""}this plan was downgraded from {d.from} to{" "}
        {d.to}.
      </b>
      <p>
        Steps run one transaction at a time, so a later step can fail after earlier ones already
        landed. {d.partialExecutionRisk ?? "Partial execution is possible."}
      </p>
    </div>
  );
}

export function copyText(t: string) {
  void navigator.clipboard?.writeText(t);
}
export function downloadJson(name: string, v: unknown) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(v, null, 2)], { type: "application/json" }),
  );
  a.download = name;
  a.click();
}
export function JsonActions({
  label,
  value,
  file,
}: {
  label: string;
  value: unknown;
  file: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <span className="row">
      <button
        className="ghost xs"
        onClick={() => {
          copyText(JSON.stringify(value, null, 2));
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? "Copied" : `Copy ${label} JSON`}
      </button>
      <button className="ghost xs" onClick={() => downloadJson(file, value)}>
        Download {label} JSON
      </button>
    </span>
  );
}

const STATUS_TONE: Record<LiveOutcome["status"], string> = {
  blocked: "warn",
  unknown: "warn",
  rejected: "bad",
  failed: "bad",
  uncertain: "warn",
  unverified: "info",
  verified: "ok",
};

export function RejectionNotice({
  onRetry,
  onDismiss,
}: {
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="errbox rejected"
      role="alertdialog"
      aria-labelledby="rej-title"
      aria-describedby="rej-desc"
      onKeyDown={(e) => {
        if (isEscape(e.key)) onDismiss();
      }}
    >
      <b id="rej-title">Wallet rejected the signing request</b>
      <p id="rej-desc">
        You rejected it in your wallet. Nothing was sent and your approval was not consumed, so you
        can try again. Press Escape to dismiss.
      </p>
      <div className="actions">
        <button onClick={onRetry}>Retry signing</button>
        <button className="ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function FinalityPanel({ out }: { out: LiveOutcome }) {
  const v = finalityView(
    out,
    out.block ? { blockNumber: out.block.number, blockHash: out.block.hash } : {},
  );
  if (v.key === "none") return null;
  return (
    <div className="finality" role="group" aria-label="Transaction confirmation">
      <div className="row">
        <b>Transaction</b>
        <Tag tone={v.tone}>{v.label}</Tag>
      </div>
      <p>{v.message}</p>
      <dl className="kv small">
        <dt>Tx hash</dt>
        <dd>{v.txHash ? <code className="wrap">{v.txHash}</code> : "not known"}</dd>
        <dt>Block</dt>
        <dd>
          {v.blockNumber != null ? `#${v.blockNumber}` : "not known"}
          {v.blockHash && (
            <>
              {" "}
              <code className="wrap">{v.blockHash}</code>
            </>
          )}
        </dd>
      </dl>
      {v.reconcileFirst && (
        <p className="small">
          <b>Do not retry yet.</b> Check the chain for this transaction first.
        </p>
      )}
    </div>
  );
}

export function V3FactsNotice({ r }: { r: V3FactsResult }) {
  if (!r.ok)
    return (
      <div className="v3facts small" role="status">
        <Tag tone="bad">V3 facts: blocked</Tag> <span>{r.message}</span>
      </div>
    );
  const p = r.report;
  if (p.provenance === "live_chain_inputs")
    return (
      <div className="v3facts small" role="status">
        <Tag tone="ok">V3 facts: built live from this node</Tag>
        <dl className="kv small">
          <dt>Node</dt>
          <dd>
            {p.specName} spec {p.specVersion}, tx v{p.transactionVersion}, finalized #
            {p.finalizedBlock ?? "?"}
          </dd>
          <dt>Metadata (live)</dt>
          <dd>
            {p.metadataBytes} bytes, <code className="wrap">{p.liveMetadataHash}</code>
          </dd>
          <dt>Fingerprint (live)</dt>
          <dd>
            <code className="wrap">{p.liveFingerprintDigest}</code>
          </dd>
          <dt>Recorded snapshot</dt>
          <dd>
            {p.snapshotFrom === "none"
              ? "not loaded (comparison only)"
              : p.digestMatchesSnapshot
                ? `matches ${p.snapshotFrom}`
                : `differs from ${p.snapshotFrom} (comparison only; expected when V3 metadata drifts)`}
          </dd>
        </dl>
      </div>
    );
  return (
    <div className="v3facts small" role="status">
      <Tag tone="warn">V3 facts: snapshot + live metadata (fallback)</Tag>
      <dl className="kv small">
        <dt>Node</dt>
        <dd>
          {p.specName} spec {p.specVersion}, tx v{p.transactionVersion}, finalized #
          {p.finalizedBlock ?? "?"}
        </dd>
        <dt>Metadata (live)</dt>
        <dd>
          {p.metadataBytes} bytes, <code className="wrap">{p.liveMetadataHash}</code>
        </dd>
        <dt>Fingerprint</dt>
        <dd>
          Recorded snapshot from <code className="wrap">{p.snapshotFrom}</code>, not a live
          discovery.{" "}
          {p.metadataHashMatchesSnapshot
            ? "Live metadata hash matches it."
            : "Live metadata hash differs from it. On V3 only the metadata hash drifts (one storage default changes between blocks); genesis, spec and tx version match, and recorded receipts keep their own recorded fingerprint."}
        </dd>
      </dl>
    </div>
  );
}

/** What the wallet will be asked to sign, and the approval bound to it. Shown before anything is contacted. */
export function ApprovalSummary({ plan, approval }: { plan?: Plan; approval?: Approval }) {
  const call = planCall(plan);
  return (
    <div className="approval small" role="group" aria-label="Approval request">
      <div className="row between">
        <b>Approval request</b>
        <Tag tone={!approval ? "warn" : approval.used ? "bad" : "ok"}>
          {!approval ? "not approved" : approval.used ? "approval used" : "approved"}
        </Tag>
      </div>
      {!call.ok ? (
        <p className="muted">{call.message}</p>
      ) : (
        <dl className="kv small">
          <dt>Signer</dt>
          <dd>
            <code className="wrap">{call.value.signer}</code>
          </dd>
          <dt>Actions</dt>
          <dd>
            {plan!.steps
              .map(
                (s) =>
                  `${s.actionId}: ${s.capability}${s.decoded.amount ? ` ${s.decoded.amount}` : ""}${s.decoded.assetId ? ` of asset ${s.decoded.assetId}` : ""}${s.decoded.recipient ? ` to ${s.decoded.recipient}` : ""}`,
              )
              .join("; ")}
          </dd>
          <dt>Call</dt>
          <dd>
            <code className="wrap">{call.value.callHex}</code>
          </dd>
          <dt>Plan digest</dt>
          <dd>
            <code className="wrap">{call.value.planDigest}</code>
          </dd>
          {approval && (
            <>
              <dt>Approval</dt>
              <dd>
                <code className="wrap">{approval.hash}</code> until {approval.expiresAt}
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

/** Receipt of a LIVE run: only what was observed. Coverage stays at what the chain re-read showed. */
/** What the receipt can check on chain: a single assets.transfer step. Anything else has no effect check here. */
export function transferExpectation(plan?: Plan): TransferExpectation | undefined {
  const st = plan?.steps.length === 1 ? plan.steps[0] : undefined;
  const d = st?.decoded;
  if (
    !plan?.signer ||
    !st ||
    !/^Assets\.transfer/.test(st.capability) ||
    !d?.assetId ||
    !d.recipient ||
    !d.amount
  )
    return undefined;
  return { assetId: d.assetId, from: plan.signer, to: d.recipient, amount: d.amount };
}

export function LiveReceipt({
  out,
  plan,
  approval,
  rpc,
  effectCheck = checkAssetsTransferEffect,
}: {
  out: LiveOutcome;
  plan?: Plan;
  approval?: Approval;
  rpc?: RpcTransport;
  effectCheck?: typeof checkAssetsTransferEffect;
}) {
  const [effect, setEffect] = useState<EffectVerdict>();
  const want = transferExpectation(plan);
  const blockHash = out.block?.hash;
  useEffect(() => {
    setEffect(undefined);
    if (!rpc || !want || !out.txHash || !blockHash || out.txState !== "finalized") return;
    let live = true;
    effectCheck(rpc, out.txHash, blockHash, want).then((v) => live && setEffect(v));
    return () => {
      live = false;
    };
  }, [rpc, out.txHash, blockHash, out.txState, plan?.digest]);
  if (!out.submitted || !out.txHash) return null;
  const effectLabel = !want
    ? "not checked (no effect check for this plan)"
    : !effect
      ? out.txState === "finalized"
        ? "checking…"
        : "not checked (not finalized)"
      : effect.verdict === "effect_proven"
        ? `effect proven: Assets.Transferred asset ${effect.event.assetId}, amount ${effect.event.amount}, to the planned recipient (extrinsic #${effect.extrinsicIndex})`
        : `not verified: ${effect.reason}`;
  const receipt = {
    receiptKind: "seam/console-live-receipt/v1",
    result: out.status,
    txHash: out.txHash,
    block: out.block ?? null,
    planDigest: plan?.digest ?? null,
    manifestDigest: plan?.manifestDigest ?? null,
    fingerprintDigest: plan?.fingerprintDigest ?? null,
    approvalHash: approval?.hash ?? null,
    signer: plan?.signer ?? null,
    fee: out.fee ?? null,
    coverage: out.coverage,
    effect: effect ?? {
      verdict: "not_verified",
      reason: want ? "not checked yet" : "no effect check for this plan",
    },
    verification: effect?.verdict === "effect_proven" ? "effect_proven" : "unverified",
  };
  return (
    <div className="receipt small" role="group" aria-label="Receipt">
      <div className="row between">
        <b>Receipt</b>
        <button
          className="ghost xs"
          onClick={() => downloadJson(`seam-receipt-${out.txHash!.slice(0, 10)}.json`, receipt)}
        >
          Download receipt
        </button>
      </div>
      <dl className="kv small">
        <dt>Result</dt>
        <dd>{out.status}</dd>
        <dt>Tx hash</dt>
        <dd>
          <code className="wrap">{out.txHash}</code>
        </dd>
        <dt>Finalized block</dt>
        <dd>{out.block ? `#${out.block.number}` : "not observed"}</dd>
        <dt>Plan digest</dt>
        <dd>
          <code className="wrap">{plan?.digest ?? "unknown"}</code>
        </dd>
        <dt>Approval</dt>
        <dd>
          <code className="wrap">{approval?.hash ?? "unknown"}</code>
        </dd>
        <dt>Coverage</dt>
        <dd>{COVERAGE_LABEL[out.coverage]}</dd>
        <dt>Effect</dt>
        <dd data-testid="receipt-effect">
          <Tag tone={effect?.verdict === "effect_proven" ? "ok" : "warn"}>
            {effect?.verdict === "effect_proven" ? "effect proven" : "effect unverified"}
          </Tag>{" "}
          {effectLabel}
        </dd>
      </dl>
    </div>
  );
}

export function LivePanel({
  plan,
  facts,
  approval,
  hostLoader = loadLiveHost,
  factsStep = liveFactsStep,
  now = () => Date.now(),
}: {
  plan?: Plan;
  facts?: RuntimeFacts;
  approval?: Approval;
  hostLoader?: (facts?: unknown) => Promise<LiveHost | undefined>;
  factsStep?: (rpc: RpcTransport) => Promise<V3FactsResult>;
  now?: () => number;
} = {}) {
  const [url, setUrl] = useState<string>(import.meta.env.VITE_V3_RPC_URL ?? V3_HTTPS_RPC);
  const [v3, setV3] = useState<V3FactsResult>();
  const [out, setOut] = useState<LiveOutcome>();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [attempts, setAttempts] = useState(3);
  // Approval hashes already sent with. An approval is single use, so a second send with it is blocked here too.
  const [spent, setSpent] = useState<string[]>([]);
  const ok = !!v3RpcUrl(url);
  const [receiptRpc, setReceiptRpc] = useState<RpcTransport>();
  // A result belongs to the plan and approval it ran with; switching plan (e.g. turning on the wallet demo) or re-approving clears it.
  const planKey = `${plan?.digest ?? ""}|${approval?.hash ?? ""}`;
  useEffect(() => {
    setOut(undefined);
    setV3(undefined);
    setDismissed(false);
  }, [planKey]);
  const ready = !!plan && !!approval && !approval.used;
  // The request comes from the compiled plan already in the console. Signature checks and extrinsic assembly come from the
  // injected LiveHost (planned: @seam/chain/browser); the console has no local copy, so without a host LIVE blocks before signing.
  const run = async () => {
    setBusy(true);
    setDismissed(false);
    try {
      const u = v3RpcUrl(url);
      let deps: LiveDeps = {};
      if (u) {
        const b = await import("../lib/browserChain");
        const rpc = b.transportFor(u);
        setReceiptRpc(() => rpc);
        // The host needs chain-shaped RuntimeFacts. If the plan's facts are not that shape, run the read-only V3 facts step.
        let hostFacts: unknown = facts;
        if (!hasChainFacts(facts)) {
          const r = await factsStep(rpc).catch((e: unknown): V3FactsResult => ({
            ok: false,
            reason: "rpc_error",
            message: e instanceof Error ? e.message : String(e),
          }));
          setV3(r);
          hostFacts = r.ok ? r.facts : undefined;
        }
        const host = await hostLoader(hostFacts);
        const call = planCall(plan);
        const gateMsg = !call.ok
          ? call.message
          : !approval
            ? "The plan is not approved yet."
            : approval.used || spent.includes(approval.hash)
              ? "This approval was already used."
              : Date.parse(approval.expiresAt) <= now()
                ? "This approval has expired. Approve the plan again."
                : undefined;
        deps = {
          chain: b.createBrowserChainClient(rpc, {
            extrinsicHash: host?.extrinsicHash,
            feeExtrinsic: host?.feeEstimateExtrinsic,
          }),
          maxRpcAttempts: attempts,
          // With a host, a fee estimate is required before the wallet is asked (fail closed).
          requireFeeEstimate: !!host,
        };
        if (host) {
          deps.verifyBinding = host.verifyBinding;
          deps.signer = b.createExtensionSigner({
            assemble: (sig, _p, req) => host.assemble(sig, req),
          });
        }
        deps.prepare = async (fp) => {
          if (!call.ok || gateMsg)
            return { ok: false, reason: "unavailable", message: gateMsg ?? "No request." };
          if (!host)
            return {
              ok: false,
              reason: "unavailable",
              message:
                "The signature verifier and extrinsic assembler are not installed in this build, so nothing can be signed.",
            };
          const m = fingerprintMatches(fp, facts);
          if (!m.ok) return m;
          const ctx = await b.readSigningContext(rpc, call.value.signer);
          if (!ctx.ok) return ctx;
          return host.buildRequest({
            signer: call.value.signer,
            callHex: call.value.callHex,
            actionIds: call.value.actionIds,
            context: ctx.value,
          });
        };
      }
      const res = await runLive(url, undefined, deps);
      if (res.submitted && approval) setSpent((x) => [...x, approval.hash]);
      setOut(res);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid2">
      <div className="card">
        <h3>LIVE V3</h3>
        <p className="muted">
          Uses the real V3 testnet over HTTPS (read-only until you approve and sign with your own
          wallet). Nothing is contacted until you press the button. Local spec-1002 results do not
          prove anything about V3 Revive.
        </p>
        <label htmlFor="v3url">V3 RPC URL</label>
        <div className="row">
          <input
            id="v3url"
            placeholder={V3_HTTPS_RPC}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={!!url && !ok}
            aria-describedby="v3url-help"
          />
          <button disabled={busy} onClick={run}>
            {busy
              ? "Checking…"
              : ready
                ? "Check live and sign with wallet"
                : out
                  ? "Retry connection"
                  : "Check live"}
          </button>
        </div>
        <div className="row small" style={{ marginTop: 8 }}>
          <label htmlFor="v3attempts">RPC retry attempts</label>
          <select
            id="v3attempts"
            value={attempts}
            onChange={(e) => setAttempts(Number(e.target.value))}
          >
            {[1, 2, 3, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="muted">
            Only the read-only discovery is retried. A submit is never retried automatically.
          </span>
        </div>
        <p id="v3url-help" className="muted small">
          {!url
            ? "Empty: LIVE V3 stays blocked."
            : !ok
              ? "Not a valid ws(s):// or http(s):// URL."
              : `Valid URL. Nothing is contacted until you press the button.${url === V3_HTTPS_RPC ? " This is the default V3 testnet endpoint (HTTPS)." : ""}`}
        </p>
        {ready && (
          <p className="muted small">
            One button runs the whole flow: live facts, fee estimate and preflight, then your wallet
            extension asks you to sign. Nothing is signed if any step fails.
          </p>
        )}
        <ApprovalSummary plan={plan} approval={approval} />
        {v3 && <V3FactsNotice r={v3} />}
        {out?.status === "rejected" && !dismissed && (
          <RejectionNotice onRetry={run} onDismiss={() => setDismissed(true)} />
        )}
      </div>
      <div className="card" aria-live="polite" aria-atomic="false">
        <div className="row between">
          <h3>Live status</h3>
          {out ? (
            <Tag tone={STATUS_TONE[out.status]}>{out.status}</Tag>
          ) : (
            <Tag tone="warn">blocked / unknown</Tag>
          )}
        </div>
        {!out ? (
          <p className="muted">Nothing checked yet. Status is unknown, not success.</p>
        ) : (
          <>
            <p>{out.message}</p>
            <FinalityPanel out={out} />
            <LiveReceipt out={out} plan={plan} approval={approval} rpc={receiptRpc} />
            <dl className="kv">
              <dt>Network</dt>
              <dd>
                {out.fingerprint
                  ? `${out.fingerprint.specName ?? "?"} spec ${out.fingerprint.specVersion ?? "?"}`
                  : "unknown"}
              </dd>
              <dt>Fingerprint</dt>
              <dd>
                <code>{out.fingerprint?.digest ?? "unknown"}</code>
                {out.fingerprint?.fingerprintSchemaVersion != null && (
                  <small className="muted">
                    {" "}
                    schema v{out.fingerprint.fingerprintSchemaVersion}
                  </small>
                )}
              </dd>
              <dt>Signing</dt>
              <dd>{SIGNING_LABEL[out.signing]}</dd>
              <dt>Fee estimate</dt>
              <dd>{out.fee ? `${out.fee} base units (payment_queryInfo)` : "not estimated"}</dd>
              <dt>Simulation</dt>
              <dd>
                <SimulationBadge b={out.simulation} />
              </dd>
              <dt>Coverage</dt>
              <dd>
                <CoverageBadge c={out.coverage} />
              </dd>
              <dt>Transaction</dt>
              <dd>
                <TxStateBadge s={out.txState} />
              </dd>
              <dt>Provenance</dt>
              <dd>
                <ProvenanceBadge p={out.provenance} />
              </dd>
              {out.rpcAttempts > 0 && (
                <>
                  <dt>RPC attempts</dt>
                  <dd>{out.rpcAttempts}</dd>
                </>
              )}
            </dl>
          </>
        )}
      </div>
    </section>
  );
}

export function RiskLimits({
  policy,
  behaviour,
}: {
  policy?: PolicyLike;
  behaviour?: BehaviourLike;
}) {
  const groups = policyLimitGroups(policy);
  const at = atomicitySource(behaviour);
  return (
    <section className="card limits" aria-labelledby="limits-h">
      <div className="row between">
        <h3 id="limits-h">Risk limits</h3>
        <Tag tone={at.status === "atomic_verified" ? "ok" : "warn"}>
          {at.status === "atomic_verified" ? "atomic_verified" : "not proven"}
        </Tag>
      </div>
      {!groups ? (
        <p className="muted">
          The policy limits were not provided with this result, so none are shown. They are not
          guessed.
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.title}>
            <h4>{g.title}</h4>
            <dl className="kv small">
              {g.rows.map((r) => (
                <>
                  <dt key={r.key + "k"}>{r.label}</dt>
                  <dd key={r.key + "v"} className={r.set ? "" : "muted"}>
                    {r.value}
                  </dd>
                </>
              ))}
            </dl>
          </div>
        ))
      )}
      <h4>Atomicity proof source</h4>
      <p className="small">
        <b>{at.label}.</b> {at.detail}
      </p>
      {at.proof && (
        <dl className="kv small">
          <dt>Genesis</dt>
          <dd>
            <code className="wrap">{at.proof.genesisHash ?? "missing"}</code>
          </dd>
          <dt>Metadata hash</dt>
          <dd>
            <code className="wrap">{at.proof.metadataHash ?? "missing"}</code>
          </dd>
          <dt>Spec version</dt>
          <dd>{at.proof.specVersion ?? "missing"}</dd>
          <dt>Tx / block</dt>
          <dd>
            <code className="wrap">{at.proof.txHash ?? at.proof.blockHash ?? "missing"}</code>
          </dd>
        </dl>
      )}
    </section>
  );
}
