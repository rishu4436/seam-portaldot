// Manifest Builder: connect a wallet, pick an account and network, read live runtime facts (read-only), build a Manifest
// with one or more actions, choose atomicity, export/import JSON and compile. Supported actions come from the live facts'
// capabilities; the compiler is the only authority on arguments and encoding. Nothing here signs or submits.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  argFields,
  checkManifest,
  supportedKinds,
  serializeManifest,
  type Manifest,
  type RuntimeFacts,
} from "@seam/compiler/browser";
import {
  ACTION_KINDS,
  buildManifest,
  emptyAction,
  listWalletAccounts,
  importManifest,
  type ManifestIssue,
  type Atomicity,
  type BuilderKind,
  type DraftAction,
  type DraftManifest,
  type WalletAccount,
} from "../lib/manifestbuilder";
import { V3_HTTPS_RPC, type V3FactsResult } from "../lib/v3facts";
import type { RpcTransport } from "../lib/chainclient";
import { liveFactsStep } from "./Modes";
import { loadChainFns } from "../lib/signflow";
import { BuilderPolicy, type BuilderSelection } from "./BuilderPolicy";
import type { Plan as PolicyPlan } from "@seam/policy/browser";
import { AccountReadiness } from "./AccountReadiness";
import { RecipientReadiness } from "./RecipientReadiness";
import { WalletInstallHelp } from "./WalletInstallHelp";
import { ReadProgress } from "./ReadProgress";

type Facts = Extract<V3FactsResult, { ok: true }>["facts"];
const ACTION_LABELS: Record<BuilderKind, string> = {
  "assets.transfer": "Send assets",
  "assets.mint": "Mint assets",
  "nfts.mint": "Mint an NFT",
  "contracts.call": "Call a Wasm contract",
  "revive.call": "Call a Revive contract",
  "revive.instantiate_with_code": "Deploy a Revive contract",
  "revive.map_account": "Map your account",
};
export type CompileFn = (
  manifest: DraftManifest,
  facts: Facts,
) => Promise<
  { ok: true; plan: unknown } | { ok: false; message: string; fieldErrors?: Record<string, string> }
>;

export interface ActionSupport {
  kind: BuilderKind;
  supported: boolean;
  reason: string;
  reasonCode?: string;
  /** The compiler's stable cause code for an unsupported kind (supportedKinds().cause). */
  cause?: string;
}
/** Support per action from the compiler's own supportedKinds(facts). No facts, or facts it rejects, means nothing is supported. */
export function actionSupport(facts?: Facts): ActionSupport[] {
  if (!facts)
    return ACTION_KINDS.map((kind) => ({
      kind,
      supported: false,
      reason: "Read live runtime facts first.",
    }));
  let ks: ReturnType<typeof supportedKinds>;
  try {
    ks = supportedKinds(facts as unknown as RuntimeFacts);
  } catch (e) {
    const reason = `The compiler rejected these runtime facts: ${e instanceof Error ? e.message : String(e)}`;
    return ACTION_KINDS.map((kind) => ({ kind, supported: false, reason }));
  }
  return ACTION_KINDS.map((kind) => {
    const k = ks.find((x) => x.kind === kind);
    if (!k) return { kind, supported: false, reason: "The compiler does not know this kind." };
    return k.supported
      ? {
          kind,
          supported: true,
          reason: `${k.capability} is call ${k.palletIndex}/${k.callIndex} in this runtime's metadata.`,
        }
      : {
          kind,
          supported: false,
          reason: k.reason,
          ...("reasonCode" in k && k.reasonCode ? { reasonCode: k.reasonCode } : {}),
          ...("cause" in k && k.cause ? { cause: k.cause } : {}),
        };
  });
}

/** Canonical Manifest JSON via the compiler's serializeManifest; a manifest it rejects is not exported. */
export function exportManifestText(
  m: DraftManifest,
): { ok: true; text: string } | { ok: false; issues: ManifestIssue[] } {
  try {
    return { ok: true, text: serializeManifest(toCompilerManifest(m)) };
  } catch (e) {
    const issues = (e as { issues?: ManifestIssue[] }).issues;
    return {
      ok: false,
      issues: issues?.length
        ? issues.map((i) => ({
            code: i.code,
            message: i.message,
            ...(i.path ? { path: i.path } : {}),
          }))
        : [{ code: "EXPORT_FAILED", message: e instanceof Error ? e.message : String(e) }],
    };
  }
}

function downloadText(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/** Turns form strings into the values the compiler expects: json fields are parsed, everything else stays a string. */
export function toCompilerManifest(m: DraftManifest): Manifest {
  return {
    ...m,
    actions: m.actions.map((a) => {
      const types = Object.fromEntries(argFields(a.kind).map((f) => [f.name, f.type]));
      return {
        ...a,
        args: Object.fromEntries(
          Object.entries(a.args).map(([k, v]) => {
            if (types[k] !== "json") return [k, v];
            try {
              return [k, JSON.parse(v)];
            } catch {
              return [k, v];
            }
          }),
        ),
      };
    }),
  } as unknown as Manifest;
}

/** Default compile: Forge's checkManifest. Never throws; field issues come back keyed by "actionId field". */
export const browserCompile: CompileFn = async (manifest, facts) => {
  const r = checkManifest(toCompilerManifest(manifest), facts as unknown as RuntimeFacts);
  if (r.ok && r.plan && !r.unavailable.length) return { ok: true, plan: r.plan };
  const fieldErrors: Record<string, string> = {};
  const lines: string[] = [];
  for (const i of r.issues) {
    const path = (i as { path?: string }).path ?? "";
    const msg = (i as { message?: string }).message ?? String((i as { code?: string }).code);
    const mm = /^actions\[(\d+)\]\.args\.(\w+)/.exec(path);
    const act = mm && manifest.actions[Number(mm[1])];
    if (act && mm) fieldErrors[`${act.id} ${mm[2]}`] = msg;
    lines.push(path ? `${path}: ${msg}` : msg);
  }
  for (const u of r.unavailable)
    lines.push(
      `step ${u.actionId} cannot run${u.reasonCode ? ` (${u.reasonCode})` : ""}: ${u.reason}`,
    );
  return { ok: false, message: lines.join("; ") || "The compiler returned no plan.", fieldErrors };
};

export function ManifestBuilder({
  getInjected,
  transportFor,
  factsStep = liveFactsStep,
  compile = browserCompile,
  onCompiled,
  onUsePolicy,
  onInvalidate,
  onPolicyEdit,
  onRuntime,
}: {
  onInvalidate?: (reason?: string) => void;
  onPolicyEdit?: () => void;
  onRuntime?: (facts: unknown) => void;
  getInjected?: Parameters<typeof listWalletAccounts>[0];
  transportFor?: (url: string) => RpcTransport;
  factsStep?: (rpc: RpcTransport) => Promise<V3FactsResult>;
  compile?: CompileFn;
  onCompiled?: (plan: unknown, manifest: DraftManifest, facts: Facts) => void;
  /** Builder plan + compiler manifest + the tightened derived policy, for the real gate, approval and signing. */
  onUsePolicy?: (
    sel: BuilderSelection & { facts: Facts; rpcUrl?: string; walletSource?: string },
  ) => void;
}) {
  const [accounts, setAccounts] = useState<WalletAccount[]>();
  const [walletMsg, setWalletMsg] = useState<string>();
  const [signer, setSigner] = useState("");
  const [walletSource, setWalletSource] = useState("");
  const factsRequest = useRef(0),
    compileRequest = useRef(0),
    importRequest = useRef(0),
    connectRequest = useRef(0);
  const [connecting, setConnecting] = useState(false);
  const [url, setUrl] = useState(V3_HTTPS_RPC);
  const [facts, setFacts] = useState<V3FactsResult>();
  const [busy, setBusy] = useState(false);
  const [factsAttempt, setFactsAttempt] = useState(1);
  const [actions, setActions] = useState<DraftAction[]>([]);
  const [atomicity, setAtomicity] = useState<Atomicity>("sequential");
  const [importMsg, setImportMsg] = useState<string>();
  const [issues, setIssues] = useState<ManifestIssue[]>([]);
  const [compileMsg, setCompileMsg] = useState<string>();
  const [plan, setPlan] = useState<unknown>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const compiledDraft = useRef(false);
  const [draftNotice, setDraftNotice] = useState<string>();

  const live = facts?.ok ? facts.facts : undefined;
  useEffect(() => {
    onRuntime?.(live);
  }, [live, onRuntime]);
  useEffect(() => {
    factsRequest.current++;
    setFacts(undefined);
    setBusy(false);
  }, [url]);
  const support = useMemo(() => actionSupport(live), [live]);
  const fp = (
    live as
      { fingerprint?: { genesisHash: string; specVersion: number; specName?: string } } | undefined
  )?.fingerprint;
  useEffect(() => {
    compileRequest.current++;
    importRequest.current++;
    setPlan(undefined);
    setCompileMsg(undefined);
    setFieldErrors({});
    const reason = compiledDraft.current
      ? "Transaction details changed. The previous plan and approval were cleared. Compile again and review the updated transaction."
      : undefined;
    compiledDraft.current = false;
    if (reason) setDraftNotice(reason);
    onInvalidate?.(reason);
  }, [signer, walletSource, url, live, actions, atomicity, onInvalidate]);
  const manifest =
    signer && actions.length
      ? buildManifest(
          signer,
          actions,
          atomicity,
          fp && { genesisHash: fp.genesisHash, specVersion: fp.specVersion },
        )
      : undefined;

  const connect = async () => {
    const version = ++connectRequest.current;
    setConnecting(true);
    setWalletMsg(undefined);
    const r = await listWalletAccounts(getInjected).catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }));
    if (version !== connectRequest.current) return;
    setConnecting(false);
    if (!r.ok) {
      setAccounts(undefined);
      setSigner("");
      setWalletSource("");
      return setWalletMsg(r.message);
    }
    setAccounts(r.value);
    if (!r.value.some((a) => a.address === signer && a.source === walletSource)) {
      setSigner(r.value[0].address);
      setWalletSource(r.value[0].source);
    }
  };
  const readFacts = async () => {
    const version = ++factsRequest.current;
    setBusy(true);
    setFactsAttempt(1);
    setPlan(undefined);
    setFacts(undefined);
    try {
      const t =
        transportFor ??
        ((endpoint: string) =>
          import("../lib/browserChain").then((module) =>
            module.transportFor(endpoint, { readDeadline: Date.now() + 25000, readRounds: 1 }),
          ));
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (version !== factsRequest.current) return;
        setFactsAttempt(attempt);
        const result = await factsStep(await t(url)).catch((e: unknown): V3FactsResult => ({
          ok: false,
          reason: "rpc_error",
          message: e instanceof Error ? e.message : String(e),
        }));
        if (version !== factsRequest.current) return;
        if (result.ok || result.reason !== "rpc_error" || attempt === 2) {
          setFacts(result);
          break;
        }
      }
    } catch (error) {
      if (version === factsRequest.current)
        setFacts({
          ok: false,
          reason: "rpc_error",
          message: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (version === factsRequest.current) setBusy(false);
    }
  };
  const update = (i: number, a: DraftAction) => {
    setPlan(undefined);
    setActions((xs) => xs.map((x, j) => (j === i ? a : x)));
  };
  const doImport = async (f?: File) => {
    if (!f) return;
    const version = ++importRequest.current;
    setIssues([]);
    let text: string;
    try {
      if (f.size > 8 * 1024 * 1024) throw new Error("Choose a manifest smaller than 8 MiB.");
      text = await f.text();
    } catch (error) {
      if (version !== importRequest.current) return;
      setImportMsg(`Import refused: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (version !== importRequest.current) return;
    const r = importManifest(text, live);
    if (!r.ok) {
      setIssues(r.issues);
      return setImportMsg(`Import refused: ${r.issues.length} issue(s).`);
    }
    setActions(r.value.actions);
    setAtomicity(r.value.atomicity);
    setPlan(undefined);
    setImportMsg(
      r.value.signer && r.value.signer !== signer
        ? signer
          ? "Imported. The file's signer was replaced by your connected account."
          : "Imported. Connect a wallet and select the account to use."
        : "Imported.",
    );
  };
  const doExport = () => {
    if (!manifest) return;
    setIssues([]);
    const r = exportManifestText(manifest);
    if (!r.ok) {
      setIssues(r.issues);
      return setImportMsg(`Export refused: ${r.issues.length} issue(s).`);
    }
    downloadText("seam-manifest.json", r.text);
  };
  const doCompile = async () => {
    const version = ++compileRequest.current;
    setCompileMsg(undefined);
    setFieldErrors({});
    setPlan(undefined);
    setDraftNotice(undefined);
    if (!manifest || !live) return;
    const r = await compile(manifest, live).catch((e: unknown) => ({
      ok: false as const,
      message: e instanceof Error ? e.message : String(e),
    }));
    if (version !== compileRequest.current) return;
    if (!r.ok) {
      setFieldErrors(("fieldErrors" in r && r.fieldErrors) || {});
      return setCompileMsg(`Compile failed: ${r.message}`);
    }
    setPlan(r.plan);
    compiledDraft.current = true;
    onCompiled?.(r.plan, manifest, live);
  };
  const blocked = !signer
    ? "Connect a wallet and pick an account."
    : !live
      ? "Read live runtime facts first."
      : !actions.length
        ? "Add at least one action."
        : actions.some((a) => !support.find((s) => s.kind === a.kind)?.supported)
          ? "Remove actions this runtime does not support."
          : undefined;

  return (
    <section className="card manifest-card" aria-label="Manifest builder">
      <div className="section-title">
        <span className="section-number">01</span>
        <div>
          <h2>Build your transaction</h2>
          <p>Connect your wallet and choose what happens on chain.</p>
        </div>
      </div>

      <h4>
        <span>1</span> Connect your wallet
      </h4>
      <div className="row">
        <button disabled={connecting} onClick={connect}>
          {connecting ? "Connecting…" : accounts ? "Refresh accounts" : "Connect wallet"}
        </button>
        {accounts && (
          <button
            className="ghost"
            onClick={() => {
              connectRequest.current++;
              setAccounts(undefined);
              setSigner("");
              setWalletSource("");
              setConnecting(false);
              setWalletMsg("Wallet disconnected from this workspace.");
            }}
          >
            Disconnect wallet
          </button>
        )}
        {accounts && (
          <select
            aria-label="Account"
            value={`${walletSource}:${signer}`}
            onChange={(e) => {
              const account = accounts.find(
                (item) => `${item.source}:${item.address}` === e.target.value,
              );
              setSigner(account?.address ?? "");
              setWalletSource(account?.source ?? "");
              setPlan(undefined);
            }}
          >
            {accounts.map((a) => (
              <option key={`${a.source}:${a.address}`} value={`${a.source}:${a.address}`}>
                {a.name ? `${a.name} ` : ""}
                {a.address} ({a.source})
              </option>
            ))}
          </select>
        )}
      </div>
      {walletMsg && (
        <p role="alert" className="muted small">
          {walletMsg}
        </p>
      )}
      {!accounts?.length && <WalletInstallHelp />}

      <h4>
        <span>2</span> Read the network
      </h4>
      <div className="row">
        <select
          disabled={busy}
          aria-label="Network"
          value={url === V3_HTTPS_RPC ? "v3" : "custom"}
          onChange={(e) => setUrl(e.target.value === "v3" ? V3_HTTPS_RPC : "")}
        >
          <option value="v3">Portaldot V3 testnet (HTTPS)</option>
          <option value="custom">Custom RPC URL</option>
        </select>
        <input
          disabled={busy}
          aria-label="RPC URL"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setFacts(undefined);
          }}
        />
        <button disabled={busy || !url} onClick={readFacts}>
          {busy ? (factsAttempt === 2 ? "Retrying network read…" : "Reading…") : "Read live facts"}
        </button>
      </div>
      {facts && !facts.ok && (
        <p role="alert" className="small">
          Live facts failed ({facts.reason}): {facts.message}
        </p>
      )}
      <ReadProgress
        active={busy}
        label={
          factsAttempt === 2
            ? "Retrying the live runtime read…"
            : "Reading finalized network facts…"
        }
      />
      {fp && (
        <p className="small">
          Live runtime: {fp.specName ?? "?"} spec {fp.specVersion}, genesis{" "}
          <code>{fp.genesisHash.slice(0, 10)}…</code>
        </p>
      )}

      <AccountReadiness
        address={signer}
        facts={live as unknown as RuntimeFacts | undefined}
        rpcUrl={url}
        transportFor={transportFor}
        onChooseAsset={(assetId) => {
          setPlan(undefined);
          setActions((xs) => {
            const action = emptyAction("assets.transfer", xs);
            return [...xs, { ...action, args: { ...action.args, assetId } }];
          });
        }}
      />
      <h4>
        <span>3</span> Choose your actions
      </h4>
      <ul className="small" aria-label="Supported actions">
        {support
          .filter((s) => s.supported)
          .map((s) => (
            <li key={s.kind}>
              <button
                className="ghost xs"
                aria-label={`Add ${ACTION_LABELS[s.kind]}`}
                title={s.reason}
                onClick={() => {
                  setPlan(undefined);
                  setActions((xs) => [...xs, emptyAction(s.kind, xs)]);
                }}
              >
                + {ACTION_LABELS[s.kind]}
              </button>{" "}
              <span className="muted">supported</span>
            </li>
          ))}
      </ul>
      {live && support.some((s) => !s.supported) && (
        <details className="small">
          <summary>
            Not available on this runtime ({support.filter((s) => !s.supported).length})
          </summary>
          <ul aria-label="Unavailable actions">
            {support
              .filter((s) => !s.supported)
              .map((s) => (
                <li key={s.kind} data-kind={s.kind}>
                  <code>{s.kind}</code>
                  {s.cause ? (
                    <>
                      {" "}
                      <code>{s.cause}</code>
                    </>
                  ) : null}
                  : {s.reason}
                </li>
              ))}
          </ul>
        </details>
      )}
      {!live && (
        <div className="builder-empty">
          <span>+</span>
          <b>Start with a live network read</b>
          <p>Available actions will appear here once the runtime has been checked.</p>
        </div>
      )}
      {live && !actions.length && (
        <p className="builder-action-hint">Choose an action above to add it to your transaction.</p>
      )}
      {actions.map((a, i) => {
        const f = argFields(a.kind);
        return (
          <fieldset key={a.id} aria-label={`Action ${a.id}`}>
            <legend>
              {i + 1}. {ACTION_LABELS[a.kind]} <code>{a.kind}</code>
            </legend>
            {f.map((fld) => {
              const err = fieldErrors[`${a.id} ${fld.name}`];
              return (
                <label key={fld.name} className="small" title={fld.description}>
                  {fld.name}
                  {fld.required ? " *" : ""} <span className="muted">({fld.type})</span>
                  <input
                    aria-label={`${a.id} ${fld.name}`}
                    aria-invalid={err ? true : undefined}
                    value={a.args[fld.name] ?? ""}
                    onChange={(e) =>
                      update(i, { ...a, args: { ...a.args, [fld.name]: e.target.value } })
                    }
                  />
                  <span className="field-hint">{fld.description}</span>
                  {err && (
                    <span role="alert" className="small">
                      {" "}
                      {err}
                    </span>
                  )}
                </label>
              );
            })}
            {!f.length && <p className="muted small">No arguments.</p>}
            {(a.kind === "assets.transfer" || a.kind === "assets.mint") && live && (
              <RecipientReadiness
                recipient={a.args.recipient ?? ""}
                assetId={a.args.assetId ?? ""}
                amount={a.args.amount ?? ""}
                facts={live as unknown as RuntimeFacts}
                rpcUrl={url}
                transportFor={transportFor}
              />
            )}
            <div className="row">
              <button
                className="ghost xs"
                disabled={i === 0}
                onClick={() =>
                  setActions((xs) => {
                    const y = [...xs];
                    [y[i - 1], y[i]] = [y[i], y[i - 1]];
                    return y;
                  })
                }
              >
                Up
              </button>
              <button
                className="ghost xs"
                onClick={() => {
                  setPlan(undefined);
                  setActions((xs) => xs.filter((_, j) => j !== i));
                }}
              >
                Remove
              </button>
            </div>
          </fieldset>
        );
      })}

      <h4>
        <span>4</span> Choose execution mode
      </h4>
      <select
        aria-label="Atomicity"
        value={atomicity}
        onChange={(e) => {
          setAtomicity(e.target.value as Atomicity);
          setPlan(undefined);
        }}
      >
        <option value="preferred">Prefer atomic (may fall back to sequential)</option>
        <option value="required">Require atomic (unavailable if not proven)</option>
        <option value="sequential">Sequential</option>
      </select>
      <p className="small mode-explanation">
        {atomicity === "sequential"
          ? "Actions run one at a time. Earlier actions can remain completed if a later action fails."
          : "An atomic batch needs rollback proof from this runtime. Any fallback to separate transactions needs your approval."}
      </p>

      <h4>
        <span>5</span> Compile your transaction
      </h4>
      {draftNotice && (
        <p role="status" className="workspace-notice">
          {draftNotice}
        </p>
      )}
      <div className="row">
        <button disabled={!!blocked} onClick={doCompile}>
          Compile against live runtime
        </button>
        <button className="ghost" disabled={!manifest} onClick={doExport}>
          Export Manifest
        </button>
        <label className="ghost small">
          Import Manifest
          <input
            aria-label="Import Manifest"
            type="file"
            accept="application/json"
            onChange={(e) => doImport(e.target.files?.[0])}
          />
        </label>
      </div>
      {blocked && <p className="muted small">{blocked}</p>}
      {importMsg && (
        <p className="small" role="status">
          {importMsg}
        </p>
      )}
      {issues.length > 0 && (
        <ul className="small" aria-label="Manifest issues">
          {issues.map((i, k) => (
            <li key={k}>
              <code>{i.code}</code>
              {i.path ? (
                <>
                  {" "}
                  at <code>{i.path}</code>
                </>
              ) : null}
              : {i.message}
            </li>
          ))}
        </ul>
      )}
      {compileMsg && (
        <p className="small" role="alert">
          {compileMsg}
        </p>
      )}
      {plan != null && (
        <details>
          <summary>Technical details · compiled plan</summary>
          <pre className="small">{JSON.stringify(plan, null, 2)}</pre>
        </details>
      )}
      {plan != null && manifest && live && (
        <>
          <h4>6. Policy</h4>
          <BuilderPolicy
            onInvalidate={onPolicyEdit ?? onInvalidate}
            plan={plan as PolicyPlan}
            manifest={toCompilerManifest(manifest)}
            readPreflight={async () => {
              const t = transportFor ?? (await import("../lib/browserChain")).transportFor;
              const chain = await loadChainFns();
              return chain.preflight(
                t(url, { readDeadline: Date.now() + 55000, readRounds: 1 }),
                plan,
                live,
              );
            }}
            onUse={
              onUsePolicy &&
              ((sel) => onUsePolicy({ ...sel, facts: live, rpcUrl: url, walletSource }))
            }
          />
        </>
      )}
    </section>
  );
}
