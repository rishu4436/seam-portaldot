// Manifest Builder: connect a wallet, pick an account and network, read live runtime facts (read-only), build a Manifest
// with one or more actions, choose atomicity, export/import JSON and compile. Supported actions come from the live facts'
// capabilities; the compiler is the only authority on arguments and encoding. Nothing here signs or submits.
import { useMemo, useState } from "react";
import {
  argFields,
  checkManifest,
  supportedKinds,
  type Manifest,
  type RuntimeFacts,
} from "@seam/compiler/browser";
import {
  ACTION_KINDS,
  buildManifest,
  emptyAction,
  listWalletAccounts,
  parseManifestJson,
  type Atomicity,
  type BuilderKind,
  type DraftAction,
  type DraftManifest,
  type WalletAccount,
} from "../lib/manifestbuilder";
import { V3_HTTPS_RPC, type V3FactsResult } from "../lib/v3facts";
import type { RpcTransport } from "../lib/chainclient";
import { liveFactsStep, downloadJson } from "./Modes";
import { BuilderPolicy, type BuilderSelection } from "./BuilderPolicy";
import type { Plan as PolicyPlan } from "@seam/policy/browser";

type Facts = Extract<V3FactsResult, { ok: true }>["facts"];
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
        };
  });
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
}: {
  getInjected?: Parameters<typeof listWalletAccounts>[0];
  transportFor?: (url: string) => RpcTransport;
  factsStep?: (rpc: RpcTransport) => Promise<V3FactsResult>;
  compile?: CompileFn;
  onCompiled?: (plan: unknown, manifest: DraftManifest, facts: Facts) => void;
  /** Builder plan + compiler manifest + the tightened derived policy, for the real gate, approval and signing. */
  onUsePolicy?: (sel: BuilderSelection & { facts: Facts }) => void;
}) {
  const [accounts, setAccounts] = useState<WalletAccount[]>();
  const [walletMsg, setWalletMsg] = useState<string>();
  const [signer, setSigner] = useState("");
  const [url, setUrl] = useState(V3_HTTPS_RPC);
  const [facts, setFacts] = useState<V3FactsResult>();
  const [busy, setBusy] = useState(false);
  const [actions, setActions] = useState<DraftAction[]>([]);
  const [atomicity, setAtomicity] = useState<Atomicity>("preferred");
  const [importMsg, setImportMsg] = useState<string>();
  const [compileMsg, setCompileMsg] = useState<string>();
  const [plan, setPlan] = useState<unknown>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const live = facts?.ok ? facts.facts : undefined;
  const support = useMemo(() => actionSupport(live), [live]);
  const fp = (
    live as
      { fingerprint?: { genesisHash: string; specVersion: number; specName?: string } } | undefined
  )?.fingerprint;
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
    setWalletMsg(undefined);
    const r = await listWalletAccounts(getInjected);
    if (!r.ok) {
      setAccounts(undefined);
      setSigner("");
      return setWalletMsg(r.message);
    }
    setAccounts(r.value);
    if (!r.value.some((a) => a.address === signer)) setSigner(r.value[0].address);
  };
  const readFacts = async () => {
    setBusy(true);
    setPlan(undefined);
    try {
      const t = transportFor ?? (await import("../lib/browserChain")).transportFor;
      setFacts(
        await factsStep(t(url)).catch((e: unknown): V3FactsResult => ({
          ok: false,
          reason: "rpc_error",
          message: e instanceof Error ? e.message : String(e),
        })),
      );
    } finally {
      setBusy(false);
    }
  };
  const update = (i: number, a: DraftAction) => {
    setPlan(undefined);
    setActions((xs) => xs.map((x, j) => (j === i ? a : x)));
  };
  const doImport = async (f?: File) => {
    if (!f) return;
    const r = parseManifestJson(await f.text());
    if (!r.ok) return setImportMsg(`Import refused: ${r.message}`);
    setActions(r.value.actions);
    setAtomicity(r.value.atomicity);
    setPlan(undefined);
    setImportMsg(
      r.value.signer && r.value.signer !== signer
        ? "Imported. The file's signer was replaced by your connected account."
        : "Imported.",
    );
  };
  const doCompile = async () => {
    setCompileMsg(undefined);
    setFieldErrors({});
    setPlan(undefined);
    if (!manifest || !live) return;
    const r = await compile(manifest, live).catch((e: unknown) => ({
      ok: false as const,
      message: e instanceof Error ? e.message : String(e),
    }));
    if (!r.ok) {
      setFieldErrors(("fieldErrors" in r && r.fieldErrors) || {});
      return setCompileMsg(`Compile failed: ${r.message}`);
    }
    setPlan(r.plan);
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
    <section className="card" aria-label="Manifest builder">
      <h3>Manifest builder</h3>
      <p className="muted small">
        Build a plan for your own account. Reading facts is read-only; nothing is signed here.
      </p>

      <h4>1. Wallet</h4>
      <div className="row">
        <button onClick={connect}>{accounts ? "Refresh accounts" : "Connect wallet"}</button>
        {accounts && (
          <select
            aria-label="Account"
            value={signer}
            onChange={(e) => {
              setSigner(e.target.value);
              setPlan(undefined);
            }}
          >
            {accounts.map((a) => (
              <option key={`${a.source}:${a.address}`} value={a.address}>
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

      <h4>2. Network</h4>
      <div className="row">
        <select
          aria-label="Network"
          value={url === V3_HTTPS_RPC ? "v3" : "custom"}
          onChange={(e) => setUrl(e.target.value === "v3" ? V3_HTTPS_RPC : "")}
        >
          <option value="v3">Portaldot V3 testnet (HTTPS)</option>
          <option value="custom">Custom RPC URL</option>
        </select>
        <input
          aria-label="RPC URL"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setFacts(undefined);
          }}
        />
        <button disabled={busy || !url} onClick={readFacts}>
          {busy ? "Reading…" : "Read live facts"}
        </button>
      </div>
      {facts && !facts.ok && (
        <p role="alert" className="small">
          Live facts failed ({facts.reason}): {facts.message}
        </p>
      )}
      {fp && (
        <p className="small">
          Live runtime: {fp.specName ?? "?"} spec {fp.specVersion}, genesis{" "}
          <code>{fp.genesisHash.slice(0, 10)}…</code>
        </p>
      )}

      <h4>3. Actions</h4>
      <ul className="small" aria-label="Supported actions">
        {support.map((s) => (
          <li key={s.kind}>
            <button
              className="ghost xs"
              disabled={!s.supported}
              title={s.reason}
              onClick={() => {
                setPlan(undefined);
                setActions((xs) => [...xs, emptyAction(s.kind, xs)]);
              }}
            >
              + {s.kind}
            </button>{" "}
            <span className="muted">{s.supported ? "supported" : `unsupported: ${s.reason}`}</span>
          </li>
        ))}
      </ul>
      {actions.map((a, i) => {
        const f = argFields(a.kind);
        return (
          <fieldset key={a.id} aria-label={`Action ${a.id}`}>
            <legend>
              {i + 1}. {a.kind} <code>{a.id}</code>
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

      <h4>4. Atomicity</h4>
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

      <h4>5. Compile and export</h4>
      <div className="row">
        <button disabled={!!blocked} onClick={doCompile}>
          Compile against live runtime
        </button>
        <button
          className="ghost"
          disabled={!manifest}
          onClick={() => manifest && downloadJson("seam-manifest.json", manifest)}
        >
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
      {compileMsg && (
        <p className="small" role="alert">
          {compileMsg}
        </p>
      )}
      {plan != null && (
        <details open>
          <summary>Compiled plan</summary>
          <pre className="small">{JSON.stringify(plan, null, 2)}</pre>
        </details>
      )}
      {plan != null && manifest && live && (
        <>
          <h4>6. Policy</h4>
          <BuilderPolicy
            plan={plan as PolicyPlan}
            manifest={toCompilerManifest(manifest)}
            onUse={onUsePolicy && ((sel) => onUsePolicy({ ...sel, facts: live }))}
          />
        </>
      )}
    </section>
  );
}
