import { useEffect, useState } from "react";
import {
  inspectEvidenceBundle,
  prepareEvidenceBundle,
  type EvidenceBundle,
} from "@seam/sdk/browser";
import { RunStore, browserKV, chainTxLookup, RUN_STORE_KEY, type RunRecord } from "../lib/runstore";
import { V3_HTTPS_RPC } from "../lib/v3facts";
import { downloadJson, verifyEvidence } from "../lib/evidence";

export type CenterView = "activity" | "verify" | "team" | "developers";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-8)}`;
function Details({ value, label = "Technical details" }: { value: unknown; label?: string }) {
  return (
    <details className="technical-details">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="center-empty">
      <span className="empty-orbit" aria-hidden="true">
        ◇
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function ActivityCenter({ active }: { active: boolean }) {
  const [runs, setRuns] = useState<RunRecord[]>([]),
    [problem, setProblem] = useState<string>(),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState("all");
  const refresh = () => {
    try {
      setRuns(
        new RunStore(browserKV()).runs().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      );
      setProblem(undefined);
    } catch (error) {
      setProblem(message(error));
    }
  };
  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("storage", handler);
    window.addEventListener("focus", handler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("focus", handler);
    };
  }, []);
  useEffect(() => {
    if (active) refresh();
  }, [active]);
  const reconcile = async (id: string) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const { transportFor } = await import("../lib/browserChain");
      await new RunStore(browserKV()).recover(chainTxLookup(transportFor(V3_HTTPS_RPC)), id);
      refresh();
    } catch (error) {
      setProblem(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="center-panel" aria-label="Activity and recovery">
      <div className="feature-row">
        <div>
          <p className="eyebrow">YOUR EXECUTION JOURNAL</p>
          <h1>Every move, accounted for.</h1>
          <p>
            Recover local runs after a refresh. Reconciliation reads the chain and never resends a
            transaction.
          </p>
        </div>
        <button className="ghost" disabled={busy} onClick={refresh}>
          Refresh history
        </button>
      </div>
      <div className="center-toolbar">
        <label>
          Show runs
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All activity</option>
            <option value="attention">Needs attention</option>
            <option value="finalized">Finalized</option>
          </select>
        </label>
        <button
          className="ghost"
          onClick={() => {
            try {
              const raw = browserKV()?.getItem(RUN_STORE_KEY);
              downloadJson("seam-local-journal.json", {
                exportedAt: new Date().toISOString(),
                journal: raw ?? null,
              });
            } catch (error) {
              setProblem(message(error));
            }
          }}
        >
          Export local journal
        </button>
      </div>
      <p className="workspace-notice">
        This browser stores non-secret execution state. Chain finality and verified effects are
        separate checks. Keep send guards intact when a run is uncertain.
      </p>
      {problem && <p role="alert">{problem}</p>}
      {!runs.length && (
        <Empty title="Your next transaction starts here">
          Your live wallet runs will appear in this browser after approval. Imported historical
          evidence belongs in Receipt inspector.
        </Empty>
      )}
      {runs
        .filter(
          (run) =>
            filter === "all" ||
            (filter === "finalized"
              ? run.phase === "finalized"
              : ["uncertain", "submitted", "submitting", "signed", "failed"].includes(run.phase)),
        )
        .map((run) => (
          <article className="record-card" key={run.approvalHash}>
            <div className="feature-row">
              <div>
                <span className={`result-badge ${run.phase === "finalized" ? "good" : "neutral"}`}>
                  {run.phase.replaceAll("_", " ")}
                </span>
                <h3>
                  {run.steps.length} action{run.steps.length === 1 ? "" : "s"} ·{" "}
                  {run.mode ?? "execution"}
                </h3>
                <p>
                  {new Date(run.updatedAt).toLocaleString()} ·{" "}
                  <code title={run.planDigest}>
                    {run.planDigest ? short(run.planDigest) : "Plan not recorded"}
                  </code>
                </p>
              </div>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => void reconcile(run.approvalHash)}
              >
                {busy ? "Reading chain…" : "Reconcile on testnet"}
              </button>
            </div>
            <ol className="activity-steps">
              {run.steps.map((step) => (
                <li key={step.index}>
                  <b>{step.actionId}</b>
                  <span className="result-badge neutral">{step.status.replaceAll("_", " ")}</span>
                  {step.txHash && <code title={step.txHash}>{short(step.txHash)}</code>}
                  {step.block && <span>Block #{step.block.number}</span>}
                  {step.note && <p>{step.note}</p>}
                </li>
              ))}
            </ol>
            <Details value={run} />
          </article>
        ))}
    </section>
  );
}

function EvidenceInspector({
  bundle,
  onBundle,
}: {
  bundle?: EvidenceBundle;
  onBundle: (value: EvidenceBundle) => void;
}) {
  const [problem, setProblem] = useState<string>(),
    [result, setResult] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  const offline = bundle ? inspectEvidenceBundle(bundle) : undefined;
  const importFile = async (file?: File) => {
    if (!file) return;
    setResult(undefined);
    setProblem(undefined);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Choose a JSON file smaller than 8 MiB.");
      const value = prepareEvidenceBundle(JSON.parse(await file.text()));
      onBundle(value);
    } catch (error) {
      setProblem(message(error));
    }
  };
  return (
    <section className="center-panel" aria-label="Receipt inspector">
      <p className="eyebrow">INDEPENDENT VERIFICATION</p>
      <h1>Don’t trust a green badge.</h1>
      <p>
        Inspect a SEAM receipt, check its integrity, then compare its calls and effects with
        finalized testnet blocks.
      </p>
      <div className="import-zone">
        <span aria-hidden="true">↥</span>
        <h3>Bring your receipt</h3>
        <p>Console receipt, SDK run recording, or portable evidence bundle · JSON up to 8 MiB</p>
        <label className="file-button">
          Choose receipt file
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(event) => {
              void importFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
        <small>Inspected locally. Sharing with your team is a separate action.</small>
      </div>
      {problem && (
        <p role="alert" className="workspace-notice">
          {problem}
        </p>
      )}
      {bundle && offline && (
        <article className="record-card">
          <div className="feature-row">
            <div>
              <span className={`result-badge ${offline.status === "failed" ? "bad" : "neutral"}`}>
                {offline.status.replaceAll("_", " ")}
              </span>
              <h2>
                {offline.summary.actions} action{offline.summary.actions === 1 ? "" : "s"} ·{" "}
                {offline.summary.mode}
              </h2>
              <p>
                Receipt claim: {offline.summary.claimedResult}. A claim becomes evidence only after
                independent checks.
              </p>
            </div>
            <button className="ghost" onClick={() => downloadJson("seam-evidence.json", bundle)}>
              Export portable bundle
            </button>
          </div>
          <p className="breakable">
            <b>Signer</b> <code>{offline.summary.signer}</code>
          </p>
          <ul className="check-list">
            {offline.checks.map((check, i) => (
              <li key={`${check.check}-${i}`}>
                <span
                  className={`result-badge ${check.status === "pass" ? "good" : check.status === "fail" ? "bad" : "neutral"}`}
                >
                  {check.status.replaceAll("_", " ")}
                </span>
                <div>
                  <b>{check.check.replaceAll("_", " ")}</b>
                  <p>{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>
          <button
            disabled={busy || offline.status === "failed"}
            onClick={() => {
              setBusy(true);
              setProblem(undefined);
              setResult(undefined);
              void verifyEvidence(bundle)
                .then(setResult)
                .catch((error: unknown) => {
                  setProblem(message(error));
                  setResult({
                    status: "unknown",
                    reason: "The independent read could not complete.",
                  });
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Reading finalized chain evidence…" : "Verify against live V3 testnet"}
          </button>
          <p className="muted">
            Read-only. No wallet connection or signature required. Missing manifests, unobservable
            state and unreachable nodes remain unverified.
          </p>
        </article>
      )}
      {result !== undefined && (
        <article className="record-card">
          <h2>Independent chain result</h2>
          <p className="result-headline">
            {typeof result === "object" && result && "status" in result
              ? String(result.status).replaceAll("_", " ")
              : "unknown"}
          </p>
          <Details value={result} label="View every chain check" />
          <button className="ghost" onClick={() => downloadJson("seam-verification.json", result)}>
            Export verification result
          </button>
        </article>
      )}
    </section>
  );
}

interface Session {
  name: string;
  workspaceId: string | null;
  scopes: string[];
  administrator: boolean;
}
interface EvidenceRow {
  id: string;
  name: string;
  created_at: string;
  verification: { status: string } | null;
}
interface MonitorRow {
  id: string;
  name: string;
  enabled: number;
  interval_seconds: number;
  next_run: number;
  latest?: { status: string; created_at: string };
}
interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  revoked_at: string | null;
}
function TeamConsole({ bundle }: { bundle?: EvidenceBundle }) {
  const [url, setUrl] = useState(""),
    [key, setKey] = useState(""),
    [session, setSession] = useState<Session>(),
    [connection, setConnection] = useState<{ url: string; key: string; workspace: string }>();
  const [problem, setProblem] = useState<string>(),
    [notice, setNotice] = useState<string>(),
    [busy, setBusy] = useState(false),
    [evidence, setEvidence] = useState<EvidenceRow[]>([]),
    [monitors, setMonitors] = useState<MonitorRow[]>([]),
    [keys, setKeys] = useState<KeyRow[]>([]);
  const [name, setName] = useState("Team evidence"),
    [share, setShare] = useState(false),
    [interval, setInterval] = useState(900),
    [keyName, setKeyName] = useState("Reviewer"),
    [keyRole, setKeyRole] = useState("reader"),
    [issued, setIssued] = useState<string>(),
    [detail, setDetail] = useState<unknown>();
  useEffect(() => {
    let active = true;
    void fetch("./control-plane.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((config: { url?: string }) => {
        if (active && config.url) setUrl(config.url);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const request = async <T,>(
    path: string,
    method = "GET",
    body?: unknown,
    auth = connection,
  ): Promise<T> => {
    if (!auth) throw new Error("Connect to your team first.");
    const endpoint = new URL(auth.url);
    if (
      endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname))
    )
      throw new Error("Use an HTTPS backend URL.");
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== "/"
    )
      throw new Error("Use the backend origin without a path or credentials.");
    const response = await fetch(new URL(path, endpoint), {
      method,
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: {
        authorization: `Bearer ${auth.key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = (await response.json()) as T & { error?: string; requestId?: string };
    if (!response.ok)
      throw new Error(
        `${value.error ?? `HTTP ${response.status}`}${value.requestId ? ` (request ${value.requestId})` : ""}`,
      );
    return value;
  };
  const refresh = async (auth = connection, permissions = session?.scopes ?? []) => {
    if (!auth) return;
    const prefix = `/v1/workspaces/${auth.workspace}`;
    const results = await Promise.allSettled([
      permissions.includes("evidence:read")
        ? request<{ evidence: EvidenceRow[] }>(`${prefix}/evidence`, "GET", undefined, auth).then(
            (v) => setEvidence(v.evidence),
          )
        : Promise.resolve(),
      permissions.includes("monitor:read")
        ? request<{ monitors: MonitorRow[] }>(`${prefix}/monitors`, "GET", undefined, auth).then(
            (v) => setMonitors(v.monitors),
          )
        : Promise.resolve(),
      permissions.includes("keys:write")
        ? request<{ keys: KeyRow[] }>(`${prefix}/keys`, "GET", undefined, auth).then((v) =>
            setKeys(v.keys),
          )
        : Promise.resolve(),
    ]);
    const failure = results.find((value) => value.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  const perform = async (task: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    setNotice(undefined);
    try {
      await task();
    } catch (error) {
      setProblem(message(error));
    } finally {
      setBusy(false);
    }
  };
  const scope = (name: string) => session?.scopes.includes(name);
  const path = (resource: string) => `/v1/workspaces/${connection!.workspace}/${resource}`;
  return (
    <section className="center-panel" aria-label="Team evidence and monitoring">
      <p className="eyebrow">ONE SHARED SOURCE OF EVIDENCE</p>
      <h1>Your team’s control room.</h1>
      <p>
        Share receipts, request independent server verification, and track runtime changes while the
        browser is closed.
      </p>
      {!session ? (
        <form
          className="record-card connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              const auth = { url: new URL(url).origin, key: key.trim(), workspace: "" };
              if (
                new URL(url).username ||
                new URL(url).password ||
                new URL(url).pathname !== "/" ||
                new URL(url).search ||
                new URL(url).hash
              )
                throw new Error("Use the backend origin only.");
              const identity = await request<Session>("/v1/session", "GET", undefined, auth);
              if (!identity.workspaceId)
                throw new Error(
                  "Use a workspace access key. Keep the operator key in your secure administrator tools.",
                );
              auth.workspace = identity.workspaceId;
              setConnection(auth);
              setSession(identity);
              setKey("");
              await refresh(auth, identity.scopes);
            });
          }}
        >
          <h2>Connect a workspace</h2>
          <label>
            Backend URL
            <input
              type="url"
              required
              value={url}
              placeholder="https://your-service.up.railway.app"
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label>
            Workspace access key
            <input
              type="password"
              autoComplete="off"
              required
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="seam_key_…"
            />
          </label>
          <button disabled={busy || !url || !key}>
            {busy ? "Connecting…" : "Connect team workspace"}
          </button>
          <p className="muted">
            Enter only your trusted backend. The access key is sent to that server and kept in
            memory for this session. Closing or refreshing the page disconnects it.
          </p>
        </form>
      ) : (
        <>
          <div className="center-toolbar">
            <div>
              <span className="result-badge good">Connected</span>
              <b>{session.name}</b>
              <small>{connection?.url}</small>
            </div>
            <button
              className="ghost"
              disabled={busy}
              onClick={() => void perform(async () => refresh())}
            >
              Refresh
            </button>
            <button
              className="ghost"
              disabled={busy}
              onClick={() => {
                setConnection(undefined);
                setSession(undefined);
                setEvidence([]);
                setMonitors([]);
                setKeys([]);
                setIssued(undefined);
                setDetail(undefined);
                setShare(false);
              }}
            >
              Disconnect
            </button>
          </div>
          <div className="feature-grid">
            <article className="record-card">
              <p className="eyebrow">EVIDENCE VAULT</p>
              <h2>Store once. Verify independently.</h2>
              {scope("evidence:write") && (
                <>
                  <label>
                    Evidence name
                    <input
                      maxLength={100}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={share}
                      onChange={(event) => setShare(event.target.checked)}
                    />
                    Share the imported receipt, wallet address, call data and chain history with
                    this team backend.
                  </label>
                  <button
                    disabled={busy || !bundle || !share || !name.trim()}
                    onClick={() =>
                      void perform(async () => {
                        await request(path("evidence"), "POST", { name, bundle });
                        await refresh();
                        setNotice("Evidence stored. Server verification is a separate step.");
                        setShare(false);
                      })
                    }
                  >
                    Upload imported evidence
                  </button>
                  <p className="muted">
                    {bundle
                      ? `${bundle.plan.steps.length} actions ready from Receipt inspector.`
                      : "Import a receipt in Receipt inspector first."}
                  </p>
                </>
              )}
              {!evidence.length && <p className="muted">No shared receipts yet.</p>}
              {evidence.map((item) => (
                <div className="compact-record" key={item.id}>
                  <b>{item.name}</b>
                  <span className="result-badge neutral">
                    {item.verification?.status.replaceAll("_", " ") ?? "Stored · unverified"}
                  </span>
                  <small>{new Date(item.created_at).toLocaleString()}</small>
                  <div className="button-row">
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          const value = await request<{ bundle: EvidenceBundle }>(
                            path(`evidence/${item.id}`),
                          );
                          downloadJson(`seam-evidence-${item.id}.json`, value.bundle);
                        })
                      }
                    >
                      Download
                    </button>
                    {scope("evidence:write") && (
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            setDetail(await request(path(`evidence/${item.id}/verify`), "POST"));
                            await refresh();
                          })
                        }
                      >
                        Verify on server
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </article>
            <article className="record-card">
              <p className="eyebrow">RUNTIME WATCH</p>
              <h2>Know when the chain changes.</h2>
              <p>
                Checks V3 genesis, runtime versions and metadata layout. Read-only checks run on the
                server; results are available here.
              </p>
              {scope("monitor:write") && (
                <>
                  <label>
                    Check interval
                    <select
                      value={interval}
                      onChange={(event) => setInterval(Number(event.target.value))}
                    >
                      <option value={300}>Every 5 minutes</option>
                      <option value={900}>Every 15 minutes</option>
                      <option value={3600}>Every hour</option>
                    </select>
                  </label>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await request(path("monitors"), "POST", {
                          name: "Portaldot V3 runtime",
                          intervalSeconds: interval,
                        });
                        await refresh();
                        setNotice("Runtime watch created with a live baseline.");
                      })
                    }
                  >
                    Create runtime watch
                  </button>
                </>
              )}
              {!monitors.length && <p className="muted">No watches configured.</p>}
              {monitors.map((monitor) => (
                <div className="compact-record" key={monitor.id}>
                  <b>{monitor.name}</b>
                  <span className="result-badge neutral">
                    {monitor.enabled
                      ? (monitor.latest?.status ?? "Awaiting first check")
                      : "Paused"}
                  </span>
                  <small>
                    {monitor.latest
                      ? `Last checked ${new Date(monitor.latest.created_at).toLocaleString()}`
                      : "No completed check yet"}{" "}
                    · {monitor.interval_seconds / 60} min interval
                  </small>
                  <div className="button-row">
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          setDetail(await request(path(`monitors/${monitor.id}`)));
                        })
                      }
                    >
                      History
                    </button>
                    {scope("monitor:write") && (
                      <>
                        <button
                          className="ghost"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              setDetail(
                                await request(path(`monitors/${monitor.id}/check`), "POST"),
                              );
                              await refresh();
                            })
                          }
                        >
                          Check now
                        </button>
                        <button
                          className="ghost"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await request(path(`monitors/${monitor.id}`), "PATCH", {
                                enabled: !monitor.enabled,
                              });
                              await refresh();
                            })
                          }
                        >
                          {monitor.enabled ? "Pause" : "Resume"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </article>
          </div>
          {scope("keys:write") && (
            <article className="record-card">
              <h2>Workspace access</h2>
              <p>
                Issue a separate key for each teammate. Reader keys can inspect evidence and
                monitors. Contributor keys can also upload, verify and manage watches.
              </p>
              <div className="center-toolbar">
                <label>
                  Key name
                  <input
                    maxLength={100}
                    value={keyName}
                    onChange={(event) => setKeyName(event.target.value)}
                  />
                </label>
                <label>
                  Role
                  <select value={keyRole} onChange={(event) => setKeyRole(event.target.value)}>
                    <option value="reader">Reader</option>
                    <option value="contributor">Contributor</option>
                  </select>
                </label>
                <button
                  disabled={busy || !keyName.trim()}
                  onClick={() =>
                    void perform(async () => {
                      const created = await request<{ accessKey: string }>(path("keys"), "POST", {
                        name: keyName,
                        scopes:
                          keyRole === "reader"
                            ? ["evidence:read", "monitor:read"]
                            : ["evidence:read", "evidence:write", "monitor:read", "monitor:write"],
                      });
                      setIssued(created.accessKey);
                      await refresh();
                    })
                  }
                >
                  Create access key
                </button>
              </div>
              {issued && (
                <div className="workspace-notice">
                  <b>New key · shown once</b>
                  <p>Save it in your password manager and share it privately.</p>
                  <input aria-label="New workspace key" type="password" readOnly value={issued} />
                  <button
                    className="ghost"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(issued)
                        .then(() => setNotice("Key copied. Store it privately."))
                        .catch(() =>
                          setProblem("Clipboard unavailable. Select and copy the key field."),
                        );
                    }}
                  >
                    Copy key
                  </button>
                  <button className="ghost" onClick={() => setIssued(undefined)}>
                    Dismiss key
                  </button>
                </div>
              )}
              {keys.map((item) => (
                <div className="compact-record" key={item.id}>
                  <b>{item.name}</b>
                  <small>
                    {item.prefix}… · {item.revoked_at ? "Revoked" : item.scopes.join(", ")}
                  </small>
                  {!item.revoked_at && (
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await request(path(`keys/${item.id}/revoke`), "POST");
                          await refresh();
                          setNotice("Key revoked.");
                        })
                      }
                    >
                      Revoke key
                    </button>
                  )}
                </div>
              ))}
              <div className="button-row">
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      setDetail(await request(path("audit")));
                    })
                  }
                >
                  View audit history
                </button>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () =>
                      downloadJson("seam-workspace-export.json", await request(path("export"))),
                    )
                  }
                >
                  Export workspace
                </button>
              </div>
            </article>
          )}
        </>
      )}
      {problem && (
        <p role="alert" className="workspace-notice">
          {problem}
        </p>
      )}
      {notice && (
        <p role="status" className="workspace-notice">
          {notice}
        </p>
      )}
      {detail !== undefined && (
        <article className="record-card">
          <Details value={detail} label="Open requested evidence or check history" />
        </article>
      )}
    </section>
  );
}

function DeveloperHub() {
  return (
    <section className="center-panel" aria-label="Developer hub">
      <p className="eyebrow">BUILT TO FIT YOUR PRODUCT</p>
      <h1>One intent. Your application.</h1>
      <p>
        Use SEAM’s compiler, policy engine and receipt verifier without depending on this console.
      </p>
      <div className="feature-grid">
        <article className="record-card">
          <h2>Verify in the browser</h2>
          <p>
            Start with portable public evidence. Integrity checking needs no wallet and no network
            connection.
          </p>
          <pre>{`import { prepareEvidenceBundle, inspectEvidenceBundle,\n  verifyReceiptLive } from '@seam/sdk/browser';\nimport { createReceiptReader } from '@seam/chain/browser';\n\nconst bundle = prepareEvidenceBundle(recording);\nconst integrity = inspectEvidenceBundle(bundle);\n// Recompile the manifest against historical facts,\n// then verify through a read-only receipt reader.`}</pre>
          <a
            href="https://github.com/rishu4436/seam-portaldot/blob/main/docs/sdk.md"
            target="_blank"
            rel="noreferrer"
          >
            Browse the SDK API ↗
          </a>
        </article>
        <article className="record-card">
          <h2>Integrate protected payments</h2>
          <ol className="trust-path">
            <li>
              <span>01</span>
              <div>
                <b>Compile intent</b>
                <p>Discover calls from live runtime metadata.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <b>Enforce policy</b>
                <p>Bind recipient, amount, fees and signing window to approval.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <b>Verify execution</b>
                <p>Compare finalized extrinsics and observed effects with the exact plan.</p>
              </div>
            </li>
          </ol>
          <a
            href="https://github.com/rishu4436/seam-portaldot/tree/main/examples"
            target="_blank"
            rel="noreferrer"
          >
            Explore integration examples ↗
          </a>
        </article>
      </div>
    </section>
  );
}
export default function WorkspaceCenters({ view }: { view: CenterView }) {
  const [bundle, setBundle] = useState<EvidenceBundle>();
  return (
    <div className="workspace-centers">
      <div hidden={view !== "activity"}>
        <ActivityCenter active={view === "activity"} />
      </div>
      <div hidden={view !== "verify"}>
        <EvidenceInspector bundle={bundle} onBundle={setBundle} />
      </div>
      <div hidden={view !== "team"}>
        <TeamConsole bundle={bundle} />
      </div>
      <div hidden={view !== "developers"}>
        <DeveloperHub />
      </div>
    </div>
  );
}
