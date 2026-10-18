import { useMemo, useState } from "react";
import * as api from "./lib/mock";
import * as tc from "./lib/testchain";
import type { Approval, Plan, PolicyResult, PreflightResult, Receipt, RuntimeFacts, SigningEnvelope, StepStatus } from "./lib/types";

type Source = "mainnet" | "testchain";
type MainScenario = "happy" | "nft" | "upgrade" | "fail" | "midrun";
type Scenario = MainScenario | tc.TcScn;
const SOURCES: { id: Source; label: string; hint: string }[] = [
  { id: "mainnet", label: "Portaldot mainnet snapshot", hint: "Simulated chain replies" },
  { id: "testchain", label: "Test chain, real run", hint: `substrate-contracts-node, ${tc.ENDPOINT}` },
];
// Test-chain mode only lists runs that have real evidence.
const TC_SCENARIOS: { id: tc.TcScn; label: string; hint: string }[] = [
  { id: "sequential", label: "Sequential, verified", hint: "Transfer, contract call, mint in 3 blocks" },
  { id: "atomic", label: "Atomic, verified", hint: "All 3 steps in one batch_all" },
  { id: "rollback", label: "Rollback proof", hint: "Gate blocks BalanceLow; bypass rolls back" },
];
const SCENARIOS: { id: MainScenario; label: string; hint: string }[] = [
  { id: "happy", label: "Verified run", hint: "Transfer, ink! call, receipt token" },
  { id: "nft", label: "Missing pallet", hint: "Asks for nfts.mint on a chain without Nfts" },
  { id: "upgrade", label: "Runtime changed", hint: "Runtime upgrades after approval" },
  { id: "fail", label: "Step 2 fails", hint: "Sequential run stops halfway" },
  { id: "midrun", label: "Upgrade mid-run", hint: "Runtime changes between step 1 and 2" },
];
const STEPS = ["Connect", "Manifest", "Plan", "Checks", "Approve", "Receipt"] as const;

const short = (s?: string, n = 10) => (s ? (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s) : "—");
const human: Record<string, string> = {
  observed: "Observed", not_observed: "Not observed", unknown: "Unknown",
  atomic_verified: "Atomic, verified", atomic_unverified: "Atomic, unverified", sequential: "One after another", unavailable: "Can't run",
};

function Pill({ tone, children }: { tone: "ok" | "bad" | "warn" | "muted" | "info"; children: React.ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
const triTone = (s: string) => (s === "observed" || s === "confirmed" || s === "ok" || s === "pass" ? "ok" : s === "unknown" ? "warn" : "bad");

function Digest({ label, value }: { label: string; value?: string }) {
  return (
    <div className="digest">
      <span>{label}</span>
      <code title={value}>{short(value)}</code>
      {value && <button className="ghost xs" onClick={() => navigator.clipboard?.writeText(value)}>Copy</button>}
    </div>
  );
}

const KIND_CAP: Record<string, string> = { "assets.transfer": "Assets.transfer_keep_alive", "assets.mint": "Assets.mint", "contracts.call": "Contracts.call", "revive.call": "Revive.call", "nfts.mint": "Nfts.mint" };
const isEmitted = (e: string) => e.startsWith("Contracts.ContractEmitted");
const evTone = (e: string) => (isEmitted(e) ? "emit" : e.startsWith("System.ExtrinsicFailed") ? "fail" : e.startsWith("Assets.") || e.startsWith("Utility.") || e.startsWith("Contracts.") ? "key" : "");
function Events({ list }: { list: string[] }) {
  return <ul className="evlist">{list.map((e, i) => <li key={i} className={evTone(e)}><code>{e}</code>{isEmitted(e) && <Pill tone="ok">contract event</Pill>}</li>)}</ul>;
}

function GateChecks({ list }: { list: tc.GateCheck[] }) {
  if (!list.length) return null;
  return (
    <>
      <h4>Submit gate, per step</h4>
      {list.map((g) => (
        <details key={g.index} className="small" open={!g.result.ok}>
          <summary><b>{g.actionId}</b> {g.sendIndex != null && <span className="muted">(send #{g.sendIndex + 1}) </span>}<Pill tone={g.result.ok ? "ok" : "bad"}>{g.result.ok ? "all checks passed" : g.result.reasons.map((r) => r.code).join(", ")}</Pill> <span className="muted">SDK {g.sdkOutcome}{g.agreesWithSdk ? ", recomputed gate agrees" : ", GATE DISAGREES"}</span></summary>
          <p className="muted small">{g.checksPerformed.length} checks: {g.checksPerformed.join(", ")}. {g.note}</p>
          <dl className="kv small"><dt>Runtime</dt><dd>{g.inputs.runtimeUnchanged ? "unchanged since approval" : "changed"}</dd>{g.inputs.dryRunDetails?.map((d, i) => <><dt key={"k" + i}>Dry run</dt><dd key={"v" + i}>{d.outcome}: {d.detail}</dd></>)}{g.inputs.previousSteps?.length ? <><dt>Earlier steps</dt><dd>{g.inputs.previousSteps.map((p) => `${p.actionId} ${p.status}${p.block ? ` #${p.block}` : ""}`).join(", ")}</dd></> : null}</dl>
        </details>
      ))}
    </>
  );
}

function StateTable({ st, cols }: { st: tc.Rollback["state"]; cols: ("before" | "afterGate" | "after")[] }) {
  const names: Record<string, string> = { before: "Before", afterGate: "After gate", after: "After bypass" };
  const rows = Object.keys(st.before.asset);
  return (
    <table className="tbl"><thead><tr><th></th>{cols.map((c) => <th key={c}>{names[c]} (#{st[c].block})</th>)}</tr></thead><tbody>
      {rows.map((r) => <tr key={r}><td>{r}</td>{cols.map((c) => <td key={c} className={st[c].asset[r] !== st.before.asset[r] ? "bad" : ""}>{Number(st[c].asset[r]).toLocaleString()}</td>)}</tr>)}
      <tr><td>Alice nonce</td>{cols.map((c) => <td key={c}>{st[c].aliceNonce}</td>)}</tr>
    </tbody></table>
  );
}

export default function App() {
  const [source, setSource] = useState<Source>("mainnet");
  const [scenario, setScenario] = useState<Scenario>("happy");
  const [gate, setGate] = useState<tc.Rollback>();
  const [step, setStep] = useState(0);
  const [endpoint, setEndpoint] = useState("wss://mainnet.portaldot.io");
  const [facts, setFacts] = useState<RuntimeFacts>();
  const [plan, setPlan] = useState<Plan>();
  const [pre, setPre] = useState<PreflightResult>();
  const [policy, setPolicy] = useState<PolicyResult>();
  const [env, setEnv] = useState<SigningEnvelope>();
  const [approval, setApproval] = useState<Approval>();
  const [receipt, setReceipt] = useState<Receipt>();
  const [lockBlock, setLockBlock] = useState<RuntimeFacts>();
  const [progress, setProgress] = useState<StepStatus[]>([]);
  const real = source === "testchain";
  const manifest = useMemo(() => (real ? tc.demoManifest() : api.demoManifest(scenario === "nft")), [scenario, real]);

  const reset = (s: Scenario, src: Source = source) => {
    setSource(src); setScenario(s);
    if (src === "testchain") tc.setScenario(s as tc.TcScn); else api.setScenario(s as MainScenario);
    setStep(0); setFacts(undefined); setPlan(undefined); setPre(undefined); setPolicy(undefined);
    setEnv(undefined); setApproval(undefined); setReceipt(undefined); setLockBlock(undefined); setProgress([]); setGate(undefined);
  };
  const switchSource = (src: Source) => { if (src === source) return; setEndpoint(src === "testchain" ? tc.ENDPOINT : "wss://mainnet.portaldot.io"); reset(src === "testchain" ? "sequential" : "happy", src); };

  const doDiscover = () => { setFacts(real ? tc.discover(endpoint) : api.discover(endpoint)); };
  const doCompile = () => { if (facts) { setPlan(real ? tc.compile() : api.compile(manifest, facts)); setStep(2); } };
  const doChecks = () => { if (plan) { setPre(real ? tc.preflight() : api.preflight(plan)); setPolicy(real ? tc.checkPolicy() : api.checkPolicy(plan)); setStep(3); } };
  const doApprove = () => { if (plan && policy) { const e = real ? tc.envelope() : api.envelope(); setEnv(e); setApproval(real ? tc.approve() : api.approve(plan, policy, e!)); } };
  const doSubmit = () => {
    if (!plan || !policy || !approval || !facts) return;
    if (!real && api.submitBlock()) { setLockBlock(api.discover(endpoint, true)); setStep(5); return; }
    setStep(5);
    const n = plan.steps.length;
    setProgress(Array(n).fill("not_run"));
    const events = real ? tc.timeline() : api.timeline();
    if (real && tc.submitBlock()) {
      events.forEach((e, k) => setTimeout(() => setProgress((p) => p.map((v, j) => (j !== e.index ? v : e.phase === "blocked" ? "blocked" : "checking"))), 300 + k * 120));
      setTimeout(() => setGate(tc.rollback()), 400 + events.length * 120);
      return;
    }
    events.forEach((e, k) => {
      setTimeout(() => setProgress((p) => p.map((v, j) => (j !== e.index ? v : e.phase === "checking" ? "checking" : e.phase === "sending" ? "submitted" : e.phase === "blocked" ? "blocked" : ((e.detail as StepStatus) ?? "finalized")))), 400 + k * 550);
    });
    setTimeout(() => { setReceipt(real ? tc.receipt() : api.receipt(plan, policy, approval)); setApproval({ ...approval, used: true }); }, 500 + events.length * 550);
  };

  const canGo = [true, !!facts, !!plan, !!policy, !!approval, !!receipt || !!lockBlock || !!gate];
  const run = real ? tc.info() : undefined;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><div className="logo">S</div><div><b>SEAM</b><small>Execution console</small></div></div>
        <nav>
          {STEPS.map((s, i) => (
            <button key={s} className={`navstep ${i === step ? "on" : ""} ${canGo[i] ? "" : "locked"}`} disabled={!canGo[i]} onClick={() => setStep(i)}>
              <span className="num">{i + 1}</span>{s}
            </button>
          ))}
        </nav>
        <div className="scen">
          <small>Data source</small>
          {SOURCES.map((s) => (
            <button key={s.id} className={`scenbtn src ${source === s.id ? "on" : ""}`} onClick={() => switchSource(s.id)}>
              <b>{s.label}</b><span>{s.hint}</span>
            </button>
          ))}
          <small style={{ marginTop: 10 }}>{real ? "Recorded run" : "Demo scenario"}</small>
          {real ? TC_SCENARIOS.map((s) => (
            <button key={s.id} className={`scenbtn ${scenario === s.id ? "on" : ""}`} onClick={() => reset(s.id)}>
              <b>{s.label}</b><span>{s.hint}</span>
            </button>
          )) : SCENARIOS.map((s) => (
            <button key={s.id} className={`scenbtn ${scenario === s.id ? "on" : ""}`} onClick={() => reset(s.id)}>
              <b>{s.label}</b><span>{s.hint}</span>
            </button>
          ))}
        </div>
      </aside>

      <main>
        <header className="top">
          <div>
            <h1>{STEPS[step]}</h1>
            <p className="sub">One intent, every execution surface, one verified result.</p>
          </div>
          {facts && (
            <div className="fpchip" title={facts.fingerprint.digest}>
              <span className="dot" /> {facts.fingerprint.specName} spec {facts.fingerprint.specVersion} · tx v{facts.fingerprint.transactionVersion} · <code>{short(facts.fingerprint.digest, 6)}</code>
            </div>
          )}
        </header>
        {real ? (
          <div className="banner real">
            <b>Real run on a local test chain, not Portaldot.</b> Everything here was recorded from a real substrate-contracts-node v0.42.0 at <code>{tc.ENDPOINT}</code> (metadata v14, token UNIT): hashes, blocks, events, fees, dry runs and digests. The console replays that recording; it isn't connected live. Run {new Date(run!.ranAt).toLocaleString()}. Verify it in the repo: <code>evidence/README.md</code> explains the files; this run is <code>{run!.evidenceFile}</code> (others: {tc.importedFrom().files.map((f) => f.replace(/\.json$/, "")).join(", ")}).
            {run!.shimmed && <> One step was filled by hand: SEAM's compiler can't yet encode <code>Contracts.call</code> on metadata v14, so Bot 4's run script added the storage deposit limit and Weight V2 gas and recomputed the plan digest.</>}
          </div>
        ) : (
          <div className="banner">Plans, policy checks, approvals and receipts are real output from the SEAM compiler, policy engine and SDK, run against a saved snapshot of the Portaldot node. Transaction hashes, blocks and events are simulated until the testnet is live.</div>
        )}

        {step === 0 && (
          <section className="grid2">
            <div className="card">
              <h3>Node</h3>
              <label>RPC endpoint</label>
              <div className="row"><input value={endpoint} readOnly={real} onChange={(e) => setEndpoint(e.target.value)} /><button onClick={doDiscover}>{real ? "Load recorded runtime" : "Discover runtime"}</button></div>
              {real && <p className="muted small">{tc.node().binary}. Runtime snapshot read from the node at {new Date(tc.node().rpcSnapshotAt).toLocaleString()}.</p>}
              {facts && (
                <>
                  <h4>Runtime fingerprint</h4>
                  <dl className="kv">
                    <dt>Genesis</dt><dd><code>{short(facts.fingerprint.genesisHash)}</code></dd>
                    <dt>Runtime</dt><dd>{facts.fingerprint.specName} {facts.fingerprint.specVersion}, tx version {facts.fingerprint.transactionVersion}</dd>
                    <dt>Metadata</dt><dd>v{facts.fingerprint.metadataVersion} · <code>{short(facts.fingerprint.metadataHash)}</code></dd>
                    <dt>Token</dt><dd>{facts.fingerprint.tokenSymbol}, {facts.fingerprint.tokenDecimals} decimals, SS58 prefix {facts.fingerprint.ss58Prefix}</dd>
                    <dt>Block</dt><dd>#{facts.discoveredAtBlock.toLocaleString()}</dd>
                  </dl>
                  <Digest label="Fingerprint digest" value={facts.fingerprint.digest} />
                  {real && (
                    <>
                      <dl className="kv" style={{ marginTop: 10 }}><dt>Pallets</dt><dd>{tc.node().pallets.join(", ")}</dd><dt>Token source</dt><dd><small className="muted">{tc.node().declaredToken.source}</small></dd></dl>
                      <h4>Chain setup (real transactions)</h4>
                      <table className="tbl"><tbody>
                        {tc.setup().steps.map((s) => (
                          <tr key={s.txHash}><td>{s.what}</td><td><small className="muted">block #{s.block.number} · tx <code title={s.txHash}>{short(s.txHash, 6)}</code></small></td><td className="r"><Pill tone={s.success ? "ok" : "bad"}>{s.success ? "finalized" : "failed"}</Pill></td></tr>
                        ))}
                      </tbody></table>
                    </>
                  )}
                </>
              )}
            </div>
            <div className="card">
              <h3>Capabilities</h3>
              {!facts ? <p className="muted">Discover a runtime to see what this chain can actually do.</p> : (
                <>
                  <table className="tbl"><tbody>
                    {facts.capabilities.map((c) => (
                      <tr key={c.id}><td><code>{c.id}</code></td><td>{c.callIndex ? <small className="muted">[{c.callIndex.join(", ")}]</small> : null}</td><td className="r"><Pill tone={triTone(c.status)}>{human[c.status]}</Pill></td></tr>
                    ))}
                  </tbody></table>
                  <h4>Behaviour</h4>
                  <table className="tbl"><tbody>
                    {facts.behaviour.map((b) => (
                      <tr key={b.id}><td>{b.id.replace(/_/g, " ")}</td><td><small className="muted">{b.note}</small></td><td className="r"><Pill tone={triTone(b.status)}>{b.status}</Pill></td></tr>
                    ))}
                  </tbody></table>
                  <div className="actions"><button onClick={() => setStep(1)}>Next: Manifest</button></div>
                </>
              )}
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="grid2">
            <div className="card">
              <h3>Intent</h3>
              <ol className="flow">
                {manifest.actions.map((a) => {
                  const req = a.requires ?? KIND_CAP[a.kind];
                  const cap = facts?.capabilities.find((c) => c.id === req);
                  return (
                    <li key={a.id}><b>{a.kind}</b><span className="muted"> needs </span><code>{req}</code> {cap && <Pill tone={triTone(cap.status)}>{human[cap.status]}</Pill>}</li>
                  );
                })}
              </ol>
              {real ? <Digest label="Manifest digest" value={tc.manifestDigest()} /> : <Digest label="Manifest digest" value={api.manifestDigest(manifest)} />}
              <div className="actions"><button onClick={doCompile}>Compile plan</button></div>
            </div>
            <div className="card"><h3>Manifest</h3><pre className="code">{JSON.stringify(manifest, null, 2)}</pre></div>
          </section>
        )}

        {step === 2 && plan && (
          <section className="card">
            <div className="row between"><h3>Compiled plan</h3><Pill tone={plan.mode === "unavailable" ? "bad" : "info"}>{human[plan.mode]}</Pill></div>
            <table className="tbl big">
              <thead><tr><th>Step</th><th>Call</th><th>Key arguments</th><th>Encoded</th><th className="r">Status</th></tr></thead>
              <tbody>
                {plan.steps.map((s) => (
                  <tr key={s.actionId}>
                    <td><b>{s.actionId}</b></td>
                    <td><code>{s.capability}</code>{s.callIndex && <small className="muted"> [{s.callIndex.join(", ")}]</small>}</td>
                    <td><small>{s.decoded.message ? <><b>{s.decoded.message}({s.decoded.args ?? ""})</b> · selector <code>{s.decoded.selector}</code> · interface <code title={s.decoded.abiHash}>{short(s.decoded.abiHash, 6)}</code> · {Object.entries(s.decoded).filter(([k, v]) => v && !["message", "selector", "abiHash", "args", "data"].includes(k)).map(([k, v]) => `${k}: ${short(v as string, 6)}`).join(" · ")}</> : Object.entries(s.decoded).filter(([, v]) => v).map(([k, v]) => `${k}: ${short(v as string, 6)}`).join(" · ")}</small></td>
                    <td><code>{short(s.encodedCall, 6)}</code></td>
                    <td className="r">{s.shim && <><Pill tone="warn">Filled by run script</Pill> </>}{s.status === "ok" ? <Pill tone="ok">Ready</Pill> : <Pill tone="bad">Unavailable</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {plan.steps.filter((s) => s.reason).map((s) => <div key={s.actionId} className="note bad"><b>{s.actionId}:</b> {s.reason}</div>)}
            {plan.modeReason && <div className="note"><b>Why this mode:</b> {plan.modeReason}</div>}
            {real && run?.shimmed && <div className="note"><b>Honest note:</b> on its own the compiler returned <code>{run.compiledMode}</code>: "{run.compiledModeReason}". The <code>call</code> step was filled by <code>shimContractsCall</code> in Bot 4's run script ({plan.steps.find((s) => s.shim)?.shim}). Every other step is the compiler's own output, and the plan digest was recomputed with the compiler's own function.</div>}
            {real && tc.outerCall() && <div className="note"><b>Sent as one transaction:</b> <code>{tc.outerCall()!.capability}</code> <code title={tc.outerCall()!.encodedCall}>{short(tc.outerCall()!.encodedCall, 10)}</code></div>}
            <div className="digests">{plan.digest !== "0x" && <Digest label="Plan digest" value={plan.digest} />}<Digest label="Manifest" value={plan.manifestDigest} /><Digest label="Fingerprint" value={plan.fingerprintDigest} /></div>
            <div className="actions">{plan.mode === "unavailable" ? <div className="note bad">SEAM won't send this plan for preflight or signing, because a step can't run on this runtime. Remove the step or connect to a runtime that has it.</div> : <button onClick={doChecks}>Run preflight and policy</button>}</div>
          </section>
        )}

        {step === 3 && policy && (
          <section className="grid2">
            {!pre ? null : <div className="card">
              <h3>Preflight</h3>{real && tc.preflightAt() && <p className="muted small">Read from the node at block #{tc.preflightAt()!.number} <code>{short(tc.preflightAt()!.hash, 6)}</code>. Weight is ref_time.</p>}
              <table className="tbl"><thead><tr><th>Step</th><th>Weight</th><th>Proof size</th><th>Fee</th><th>Storage</th><th className="r">Dry run</th></tr></thead><tbody>
                {pre.steps.map((s) => (
                  <tr key={s.actionId}><td><b>{s.actionId}</b></td><td>{s.weight.value ?? "unknown"}</td><td>{s.proofSize?.value ? <>{s.proofSize.value}{real && tc.usedProofSize(s.actionId) && <small className="muted"><br />used {tc.usedProofSize(s.actionId)!.value}{tc.usedProofSize(s.actionId)!.shared ? " (whole batch)" : ""}</small>}</> : <Pill tone="warn">Unknown</Pill>}</td><td>{s.fee.value ?? "unknown"}</td><td>{s.storageDeposit.unknown ? <Pill tone="warn">Unknown</Pill> : s.storageDeposit.value}</td><td className="r"><Pill tone={triTone(s.dryRun)}>{s.dryRun}</Pill></td></tr>
                ))}
              </tbody></table>
              <p className="muted">Estimated total fee: <b>{pre.totalFee.value}</b></p>
              {real && pre.steps.filter((s) => s.note).map((s) => <div key={s.actionId} className="note small"><b>{s.actionId}:</b> {s.note}</div>)}
            </div>}
            <div className="card">
              <div className="row between"><h3>Policy</h3>{policy.allowed ? <Pill tone="ok">Allowed</Pill> : <Pill tone="bad">Blocked</Pill>}</div>
              {real && policy.explain && <p className="muted">{policy.explain}</p>}
              <ul className="rules">
                {policy.rules.map((r, i) => (
                  <li key={i} className={r.outcome}><Pill tone={triTone(r.outcome)}>{r.outcome}</Pill><div><code>{r.rule}</code>{r.actionId && <small className="muted"> · {r.actionId}</small>}<p>{r.reason}</p></div></li>
                ))}
              </ul>
              {policy.policyDigest !== "0x" && <Digest label="Policy digest" value={policy.policyDigest} />}
              {real && tc.policyFile() && <details className="small"><summary className="muted">Policy file used</summary><pre className="code">{JSON.stringify(tc.policyFile(), null, 2)}</pre></details>}
              <div className="actions">
                {policy.allowed ? <button onClick={() => setStep(4)}>Next: Approve</button> : <div className="note bad">SEAM blocked this plan. Change the Manifest or connect to a runtime that has the missing capability.</div>}
              </div>
            </div>
          </section>
        )}

        {step === 4 && plan && policy && (
          <section className="grid2">
            <div className="card">
              <h3>What you're approving</h3>
              <ul className="checks">{(approval?.covers?.length ? approval.covers : real && approval ? ["Not recorded in this test's evidence: only the approval hash was saved."] : approval?.covers ?? ["Manifest digest", "Plan digest", "Runtime fingerprint", "Policy digest and result", "Preflight result", "Signer, nonce, mortality and expiry"]).map((c) => <li key={c}>{c}</li>)}</ul>
              <p className="muted">If any of these change after you approve, the approval stops working and SEAM asks you to approve again.</p>
              {!approval ? <div className="actions"><button onClick={doApprove}>Approve this plan</button></div> : (
                <>
                  <Digest label="Approval hash" value={approval.hash} />
                  {env && <dl className="kv"><dt>Signer</dt><dd><code>{short(env?.signer, 8)}</code></dd><dt>Nonce</dt><dd>{env?.nonce}</dd><dt>Valid for</dt><dd>{env?.mortalityBlocks} blocks, until {new Date(approval.expiresAt).toLocaleTimeString()}</dd>
                    {real && tc.checkpoint() && <><dt>Checkpoint</dt><dd>block #{tc.checkpoint()!.number} <code>{short(tc.checkpoint()!.hash, 6)}</code></dd></>}
                    {real && tc.signing() && <><dt>Signed</dt><dd>{tc.signing()!.count} signing request{tc.signing()!.count > 1 ? "s" : ""} · spec {parseInt(tc.signing()!.specVersion, 16)} · era <code>{tc.signing()!.era}</code></dd><dt>Extensions</dt><dd><small className="muted">{tc.signing()!.signedExtensions.join(", ")}</small></dd></>}
                  </dl>}
                </>
              )}
            </div>
            <div className="card">
              <h3>Sign with your wallet</h3>
              <p className="muted">SEAM never holds your keys. Your wallet signs the exact bytes from the approved plan, and SEAM checks the runtime again right before it submits.</p>
              {real && <p className="muted small">On this test chain the "wallet" was the public dev account //Alice. Replaying shows what happened next; nothing is sent from the console.</p>}
              <button disabled={!approval} onClick={doSubmit}>Sign and submit</button>
            </div>
          </section>
        )}

        {step === 5 && lockBlock && facts && (
          <section className="card blocked">
            <div className="row between"><h3>SEAM blocked this submission</h3><Pill tone="bad">Runtime changed</Pill></div>
            <p>{api.submitBlock()} Nothing was sent.</p>
            <table className="tbl"><thead><tr><th></th><th>When approved</th><th>Right now</th></tr></thead><tbody>
              <tr><td>Spec version</td><td>{facts.fingerprint.specVersion}</td><td className="bad">{lockBlock.fingerprint.specVersion}</td></tr>
              <tr><td>Metadata hash</td><td><code>{short(facts.fingerprint.metadataHash, 6)}</code></td><td className="bad"><code>{short(lockBlock.fingerprint.metadataHash, 6)}</code></td></tr>
              <tr><td>Fingerprint</td><td><code>{short(facts.fingerprint.digest, 6)}</code></td><td className="bad"><code>{short(lockBlock.fingerprint.digest, 6)}</code></td></tr>
            </tbody></table>
            <div className="actions"><button onClick={() => reset("happy")}>Rediscover, recompile and approve again</button></div>
          </section>
        )}

        {step === 5 && real && gate && (
          <section className="grid2">
            <div className="card blocked">
              <div className="row between"><h3>SEAM blocked this submission</h3><Pill tone="bad">{gate.gate.reasons[0]?.code.replace(/_/g, " ")}</Pill></div>
              <p>{gate.gate.reasons.map((r) => r.message).join(" ")} {gate.gate.nothingSent && <b>Nothing was sent.</b>}</p>
              {gate.gate.dryRun.map((d) => <dl key={d.txHash} className="kv"><dt>Signed dry run</dt><dd><Pill tone="bad">{d.outcome}</Pill> {d.detail}</dd><dt>Tx</dt><dd><code className="wrap">{d.txHash}</code></dd><dt>Raw result</dt><dd><code>{d.raw}</code></dd></dl>)}
              <h4>Balances after the gate (asset 1)</h4>
              <StateTable st={gate.state} cols={["before", "afterGate"]} />
              <GateChecks list={tc.gateChecks()} />
            </div>
            <div className="card">
              <div className="row between"><h3>Rollback proof</h3><Pill tone={gate.verdict === "verified" ? "ok" : "warn"}>rollback {gate.verdict}</Pill></div>
              <div className="note"><b>Test-only bypass:</b> {gate.bypass.note}. To prove what the gate prevented, the same signed batch_all was sent straight to the node, outside SEAM.</div>
              <dl className="kv" style={{ marginTop: 10 }}>
                <dt>Tx</dt><dd><code className="wrap">{gate.bypass.txHash}</code></dd>
                <dt>Block</dt><dd>#{gate.bypass.block.number} <code className="wrap">{gate.bypass.block.hash}</code></dd>
                <dt>Status</dt><dd>{gate.bypass.history.join(" → ")} · <Pill tone="bad">ExtrinsicFailed</Pill></dd>
                <dt>Error</dt><dd>{gate.bypass.dispatchError}</dd>
              </dl>
              <h4>Events in that block</h4>
              <Events list={gate.bypass.events} />
              <p className="muted small">No Assets.Transferred or Assets.Issued: step 1's transfer and step 3's mint left nothing behind. Inner effects found: {gate.innerEffects.length}.</p>
              <h4>Balances and supply</h4>
              <StateTable st={gate.state} cols={["before", "afterGate", "after"]} />
              <div className="note">{gate.conclusion}</div>
              <p className="muted small">Evidence: <code>{gate.evidenceFile}</code>. This proof is why the atomic run may use <code>atomic_verified</code> on this runtime.</p>
            </div>
          </section>
        )}

        {step === 5 && !lockBlock && !gate && plan && (
          <section className="grid2">
            <div className="card">
              <h3>Live tracking</h3>
              <ol className="track">
                {plan.steps.map((s, i) => {
                  const st = progress[i] ?? "not_run";
                  return (
                    <li key={s.actionId} className={st}>
                      <b>{s.actionId}</b> <code>{s.capability}</code>
                      <div className="stages">{(["checking", "submitted", "finalized"] as const).map((x, k) => {
                        const order: Record<string, number> = { not_run: -1, checking: 0, blocked: 0, submitted: 1, included: 1, failed: 2, finalized: 2 };
                        const bad = (st === "blocked" && k === 0) || (st === "failed" && k === 2);
                        const label = bad ? (st === "blocked" ? "blocked" : "failed") : x === "checking" ? (k <= order[st] ? "checked" : "check") : x === "submitted" ? "sent" : "finalized";
                        return <span key={x} className={k <= order[st] ? (bad ? "bad" : "on") : ""}>{st === "checking" && k === 0 ? `checking step ${i + 1}…` : label}</span>;
                      })}</div>
                      {real && st !== "not_run" && st !== "checking" && tc.dryRunFor(i) && <small className="muted">signed dry run: {tc.dryRunFor(i)!.outcome} ({tc.dryRunFor(i)!.detail})</small>}
                    </li>
                  );
                })}
              </ol>
            </div>
            <div className="card">
              <div className="row between"><h3>Execution receipt</h3>{receipt && <Pill tone={receipt.overall === "verified" ? "ok" : receipt.overall === "partial" ? "warn" : "bad"}>{receipt.overall.replace("_", " ")}</Pill>}</div>
              {!receipt ? <p className="muted">Waiting for finalization…</p> : (
                <>
                  <p className="big">{receipt.checks.confirmed} of {receipt.checks.expected} steps verified</p>
                  {receipt.steps.map((s) => (
                    <div key={s.actionId} className="rstep">
                      <div className="row between"><b>{s.actionId}</b><Pill tone={triTone(s.verification === "verified" ? "ok" : s.verification === "unknown" ? "unknown" : "bad")}>{s.verification.replace("_", " ")}</Pill></div>
                      <p>{s.reason}</p>
                      {s.txHash && !real && <small className="muted">tx <code>{short(s.txHash, 8)}</code> · block #{s.block?.number.toLocaleString()} · {s.events.join(", ")}</small>}
                      {s.txHash && real && (
                        <>
                          <dl className="kv small"><dt>Tx</dt><dd><code className="wrap">{s.txHash}</code></dd><dt>Block</dt><dd>#{s.block?.number} <code className="wrap">{s.block?.hash}</code></dd>
                            <dt>Status</dt><dd>{tc.history(s.txHash).filter((h, k, a) => a.findIndex((x) => x.status === h.status) === k).map((h) => h.status).join(" → ")}</dd></dl>
                          <Events list={s.events} />
                        </>
                      )}
                    </div>
                  ))}
                  {real && <GateChecks list={tc.gateChecks()} />}
                  <div className="digests"><Digest label="Receipt" value={receipt.digest} /><Digest label="Approval" value={receipt.approvalHash} /><Digest label="Plan" value={receipt.planDigest} /><Digest label="Policy" value={receipt.policyDigest} /></div>
                  <button className="ghost" onClick={() => { const b = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "seam-receipt.json"; a.click(); }}>Download receipt JSON</button>
                </>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
