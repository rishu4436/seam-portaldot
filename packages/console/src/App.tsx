import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ManifestBuilder } from "./components/ManifestBuilder";
import type { BuilderSelection } from "./components/BuilderPolicy";
import { LivePanel, PolicyGatePanel, liveFactsStep } from "./components/Modes";
import { SeamMark, Symbol } from "./components/Brand";
import { engineApprovalCheck, loadChainFns } from "./lib/signflow";
import { approveWithRebind } from "./lib/rebind";
import { planView, reviewApproval } from "./lib/planview";
import { V3_HTTPS_RPC } from "./lib/v3facts";
import type { Approval, RuntimeFacts } from "./lib/types";
import type { GateOutcome } from "./lib/policygate";
import "./workspace.css";
import { DOCS_URL, SOURCE_URL } from "./lib/product-links";

const Lab = import.meta.env.DEV ? lazy(() => import("./LegacyApp")) : undefined;
const WorkspaceCenters = lazy(() => import("./components/WorkspaceCenters"));
type ActiveView = "compose" | "activity" | "verify" | "team" | "developers";
const viewLabels: Record<ActiveView, string> = {
  compose: "New transaction",
  activity: "Activity & recovery",
  verify: "Receipt inspector",
  team: "Team workspace",
  developers: "Developer hub",
};
const readActiveView = (): ActiveView => {
  const value = new URLSearchParams(window.location.search).get("view");
  return value && Object.hasOwn(viewLabels, value) ? (value as ActiveView) : "compose";
};
function writeView(view: ActiveView, replace = false) {
  const url = new URL(window.location.href);
  if (view === "compose") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}
type Selection = BuilderSelection & { facts: unknown; rpcUrl?: string; walletSource?: string };
const short = (s?: string) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "Not read yet");

export default function App() {
  const revision = useRef(0);
  const [runtime, setRuntime] = useState<unknown>();
  const [selection, setSelection] = useState<Selection>();
  const [approval, setApproval] = useState<Approval>();
  const [gate, setGate] = useState<GateOutcome>();
  const [acknowledgedDowngrade, setAcknowledgedDowngrade] = useState(false);
  const [busy, setBusy] = useState(false);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>(readActiveView);
  const [centersOpened, setCentersOpened] = useState(() => readActiveView() !== "compose");
  const [notice, setNotice] = useState<string>();
  const navigate = (next: ActiveView) => {
    if (busy || executionBusy || next === activeView) return;
    writeView(next);
    setActiveView(next);
    if (next !== "compose") setCentersOpened(true);
    window.scrollTo(0, 0);
    document.getElementById("main")?.focus();
  };
  useEffect(() => {
    document.title = `${viewLabels[activeView]} · SEAM`;
  }, [activeView]);
  useEffect(() => {
    const pop = () => {
      if (busy || executionBusy) {
        writeView(activeView, true);
        return;
      }
      const next = readActiveView();
      setActiveView(next);
      if (next !== "compose") setCentersOpened(true);
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [activeView, busy, executionBusy]);
  const invalidate = useCallback(() => {
    revision.current++;
    setAcknowledgedDowngrade(false);
    setSelection(undefined);
    setApproval(undefined);
    setGate(undefined);
    setNotice(undefined);
  }, []);
  const view = useMemo(() => (selection ? planView(selection.plan) : undefined), [selection]);
  const input = selection
    ? { policy: selection.policy, plan: selection.plan, manifest: selection.manifest }
    : undefined;
  const fingerprint = (
    (selection?.facts ?? runtime) as {
      fingerprint?: { specVersion: number; genesisHash: string; specName: string };
    }
  )?.fingerprint;
  const stage = approval ? 3 : selection ? 2 : 1;
  const approve = async () => {
    if (!selection || !input || !view) return;
    const version = revision.current;
    setBusy(true);
    setApproval(undefined);
    setNotice(undefined);
    try {
      const { transportFor } = await import("./lib/browserChain");
      const rpc = transportFor(selection.rpcUrl ?? V3_HTTPS_RPC);
      const chain = await loadChainFns();
      const result = await approveWithRebind({
        manifest: selection.manifest,
        plan: selection.plan,
        planFacts: selection.facts,
        readFacts: async () => {
          const result = await liveFactsStep(rpc);
          return result.ok ? result.facts : undefined;
        },
        check: (facts) =>
          engineApprovalCheck({
            chain,
            send: rpc,
            readFacts: async () => facts,
            input,
            now: new Date(),
            acknowledgedDowngrade,
          }),
      });
      if (revision.current !== version) return;
      if (result.kind === "rebound") {
        setSelection({
          ...selection,
          plan: result.plan as Selection["plan"],
          facts: result.liveFacts,
        });
        setGate(undefined);
        setNotice(result.message);
        return;
      }
      if (result.kind === "blocked") {
        setNotice(result.message);
        return;
      }
      setGate(result.gate);
      if (result.gate.ok) setApproval(reviewApproval(view, selection.policy.maxApprovalSeconds));
    } catch (error) {
      setNotice(
        `The check could not complete: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
    }
  };
  if (Lab && new URLSearchParams(window.location.search).get("view") === "lab")
    return (
      <Suspense fallback={<p className="loading-view">Loading recorded workspace…</p>}>
        <Lab />
      </Suspense>
    );
  return (
    <div className="workspace">
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <aside className="workspace-rail">
        <a className="workspace-brand" href="./">
          <span className="brand-mark">
            <SeamMark />
          </span>
          seam<span className="brand-period">.</span>
        </a>
        <p className="rail-label">EXECUTION WORKSPACE</p>
        <nav aria-label="Workspace">
          {(Object.entries(viewLabels) as [ActiveView, string][]).map(([id, label]) => (
            <button
              key={id}
              className={`rail-link ${activeView === id ? "active" : ""}`}
              aria-current={activeView === id ? "page" : undefined}
              disabled={busy || executionBusy}
              onClick={() => {
                navigate(id);
              }}
            >
              <Symbol
                kind={
                  id === "compose"
                    ? "layers"
                    : id === "verify"
                      ? "shield"
                      : id === "developers"
                        ? "external"
                        : "activity"
                }
              />
              {label}
            </button>
          ))}
          <a className="rail-link" href={DOCS_URL} target="_blank" rel="noreferrer">
            <Symbol kind="external" />
            Documentation
          </a>
        </nav>
        <label className="mobile-workspace-nav">
          <span>Workspace</span>
          <select
            aria-label="Workspace view"
            value={activeView}
            disabled={busy || executionBusy}
            onChange={(event) => {
              const next = event.target.value as ActiveView;
              navigate(next);
            }}
          >
            {(Object.entries(viewLabels) as [ActiveView, string][]).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="rail-bottom">
          <div className="network-pill">
            <span className="status-dot" />
            Portaldot V3 <span>TESTNET</span>
          </div>
          <p>
            Your wallet holds the keys.
            <br />
            You stay in control.
          </p>
          {import.meta.env.DEV && (
            <a href="./console.html?view=lab">
              Recorded tools <span>↗</span>
            </a>
          )}
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-topbar">
          <span>
            Workspace <span className="breadcrumb-slash">/</span> <b>{viewLabels[activeView]}</b>
          </span>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            Open source <Symbol kind="external" />
          </a>
        </header>
        <main id="main" className="workspace-main" tabIndex={-1}>
          <div hidden={activeView !== "compose"}>
            <header className="workspace-heading">
              <div>
                <p className="eyebrow">ONE INTENT. VERIFIED EXECUTION.</p>
                <h1>Make your next move.</h1>
                <p>Build a transaction, review the checks, then sign with your wallet.</p>
              </div>
              <span className="environment-tag">
                <span className="status-dot" />
                Testnet workspace
              </span>
            </header>
            <ol className="journey" aria-label="Transaction progress">
              {["Build your transaction", "Review & approve", "Sign & verify"].map((label, i) => (
                <li
                  key={label}
                  className={stage === i + 1 ? "current" : stage > i + 1 ? "complete" : ""}
                  aria-current={stage === i + 1 ? "step" : undefined}
                >
                  <span>{stage > i + 1 ? "✓" : `0${i + 1}`}</span>
                  <div>
                    <b>{label}</b>
                    <small>
                      {
                        [
                          "Your account, destination and action",
                          "Live runtime and policy checks",
                          "External wallet, finalized receipt",
                        ][i]
                      }
                    </small>
                  </div>
                </li>
              ))}
            </ol>
            <div className="workspace-columns">
              <div className="transaction-column" id="compose">
                <div inert={executionBusy}>
                  <ManifestBuilder
                    onRuntime={setRuntime}
                    onInvalidate={invalidate}
                    onUsePolicy={(sel) => {
                      invalidate();
                      setSelection(sel);
                      setApproval(undefined);
                      setGate(undefined);
                      setNotice(undefined);
                    }}
                  />
                  <section className="card review-card" id="review">
                    <div className="section-title">
                      <span className="section-number">02</span>
                      <div>
                        <h2>Review & approve</h2>
                        <p>Check the exact plan against your rules and the current chain.</p>
                      </div>
                      <Symbol kind="shield" />
                    </div>
                    {selection ? (
                      <>
                        <dl className="review-summary">
                          <div>
                            <dt>Actions</dt>
                            <dd>{selection.plan.steps.length}</dd>
                          </div>
                          <div>
                            <dt>Execution</dt>
                            <dd>
                              {selection.plan.mode === "sequential" ? "Sequential" : "Atomic batch"}
                            </dd>
                          </div>
                          <div>
                            <dt>Runtime</dt>
                            <dd>spec {fingerprint?.specVersion ?? "unknown"}</dd>
                          </div>
                        </dl>
                        {selection.plan.modeDowngrade && (
                          <label className="downgrade-review">
                            <input
                              type="checkbox"
                              checked={acknowledgedDowngrade}
                              onChange={(event) => {
                                setAcknowledgedDowngrade(event.target.checked);
                                setApproval(undefined);
                                setGate(undefined);
                              }}
                            />
                            <span>
                              I understand these actions will run one at a time. Earlier actions can
                              remain completed if a later action fails.
                            </span>
                          </label>
                        )}
                        <button
                          onClick={approve}
                          disabled={
                            busy || (!!selection.plan.modeDowngrade && !acknowledgedDowngrade)
                          }
                          className="review-button"
                        >
                          {busy
                            ? "Checking live policy…"
                            : approval
                              ? "Check and approve again"
                              : "Check policy and approve"}
                          <Symbol kind="arrow" />
                        </button>
                        {gate && <PolicyGatePanel gate={gate} />}
                      </>
                    ) : (
                      <div className="empty-review">
                        <Symbol kind="shield" />
                        <p>Your review will appear here.</p>
                        <span>Compile a transaction and select its policy to continue.</span>
                      </div>
                    )}
                    {notice && (
                      <p role="alert" className="workspace-notice">
                        {notice}
                      </p>
                    )}
                  </section>
                </div>
                <section id="execute" className="execution-section">
                  <div className="section-title">
                    <span className="section-number">03</span>
                    <div>
                      <h2>Sign & verify</h2>
                      <p>Your wallet signs. SEAM checks the submitted result.</p>
                    </div>
                    <Symbol kind="wallet" />
                  </div>
                  <LivePanel
                    walletSource={selection?.walletSource}
                    onBusyChange={setExecutionBusy}
                    plan={view}
                    facts={selection?.facts as RuntimeFacts | undefined}
                    approval={approval}
                    acknowledgedDowngrade={acknowledgedDowngrade}
                    policyInput={input}
                    rpcUrl={selection?.rpcUrl}
                    rebind={
                      selection
                        ? {
                            planFacts: selection.facts,
                            onRebound: (plan, facts, message) => {
                              setSelection({
                                ...selection,
                                plan: plan as Selection["plan"],
                                facts,
                              });
                              setApproval(undefined);
                              setGate(undefined);
                              setNotice(message);
                            },
                          }
                        : undefined
                    }
                  />
                </section>
              </div>
              <aside className="context-column" aria-label="Execution guide">
                <div className="context-card">
                  <span className="context-icon">
                    <Symbol kind="shield" />
                  </span>
                  <p className="eyebrow">BUILT FOR CERTAINTY</p>
                  <h2>
                    Know what
                    <br />
                    you're signing.
                  </h2>
                  <p>
                    Every transaction follows the same path. Each check has to pass before anything
                    is sent.
                  </p>
                  <ol className="trust-path">
                    <li>
                      <span>01</span>
                      <div>
                        <b>Read the live runtime</b>
                        <p>Calls come from the chain's metadata.</p>
                      </div>
                    </li>
                    <li>
                      <span>02</span>
                      <div>
                        <b>Enforce your limits</b>
                        <p>Review recipients, amounts and fees.</p>
                      </div>
                    </li>
                    <li>
                      <span>03</span>
                      <div>
                        <b>Verify the result</b>
                        <p>Unknown effects stay unverified.</p>
                      </div>
                    </li>
                  </ol>
                  <div className="context-foot">
                    <Symbol kind="wallet" />
                    External wallet. No keys stored.
                  </div>
                </div>
                <div className="runtime-card">
                  <div className="runtime-card-heading">
                    <span className="status-dot" />
                    <b>Runtime context</b>
                  </div>
                  <dl>
                    <dt>Network</dt>
                    <dd>Portaldot V3 testnet</dd>
                    <dt>Runtime</dt>
                    <dd>
                      {fingerprint
                        ? `${fingerprint.specName} · ${fingerprint.specVersion}`
                        : "Awaiting live read"}
                    </dd>
                    <dt>Genesis</dt>
                    <dd>
                      <code title={fingerprint?.genesisHash}>
                        {short(fingerprint?.genesisHash)}
                      </code>
                    </dd>
                    <dt>Plan</dt>
                    <dd>
                      <code title={selection?.plan.planDigest}>
                        {selection ? short(selection.plan.planDigest) : "Not compiled yet"}
                      </code>
                    </dd>
                  </dl>
                  <p>Testnet funds only. Mainnet submission is blocked.</p>
                </div>
              </aside>
            </div>
            <footer className="workspace-footer">
              <span>SEAM / Execution infrastructure</span>
              <span>Portaldot V3 · Your intent, your signature.</span>
            </footer>
          </div>
          {centersOpened && (
            <div hidden={activeView === "compose"}>
              <Suspense fallback={<p className="loading-view">Loading workspace tools…</p>}>
                <WorkspaceCenters view={activeView === "compose" ? "activity" : activeView} />
              </Suspense>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
