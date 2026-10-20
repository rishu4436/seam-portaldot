// Manifest Builder: connect a wallet, pick an account and network, read live runtime facts (read-only), build a Manifest
// with one or more actions, choose atomicity, export/import JSON and compile. Supported actions come from the live facts'
// capabilities; the compiler is the only authority on arguments and encoding. Nothing here signs or submits.
import { useMemo, useState } from "react";
import {
  ACTION_KINDS,
  FORM_FIELDS,
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

const KIND_CAPABILITY: Record<BuilderKind, string> = {
  "assets.transfer": "Assets.transfer_keep_alive",
  "assets.mint": "Assets.mint",
  "nfts.mint": "Nfts.mint",
  "contracts.call": "Contracts.call",
  "revive.call": "Revive.call",
  "revive.instantiate_with_code": "Revive.instantiate_with_code",
  "revive.map_account": "Revive.map_account",
};
type Facts = Extract<V3FactsResult, { ok: true }>["facts"];
export type CompileFn = (
  manifest: DraftManifest,
  facts: Facts,
) => Promise<{ ok: true; plan: unknown } | { ok: false; message: string }>;

export interface ActionSupport {
  kind: BuilderKind;
  supported: boolean;
  reason: string;
}
/** Support per action, read from the live facts' observed capabilities. No facts means nothing is supported. */
export function actionSupport(facts?: Facts): ActionSupport[] {
  const caps = (facts as { capabilities?: Record<string, { status?: string }> } | undefined)
    ?.capabilities;
  return ACTION_KINDS.map((kind) => {
    const cap = KIND_CAPABILITY[kind];
    if (!caps) return { kind, supported: false, reason: "Read live runtime facts first." };
    const st = caps[cap]?.status;
    return st === "observed"
      ? { kind, supported: true, reason: `${cap} is in this runtime's metadata.` }
      : {
          kind,
          supported: false,
          reason: `${cap} is ${st ?? "not present"} in this runtime's metadata.`,
        };
  });
}

export function ManifestBuilder({
  getInjected,
  transportFor,
  factsStep = liveFactsStep,
  compile,
  onCompiled,
}: {
  getInjected?: Parameters<typeof listWalletAccounts>[0];
  transportFor?: (url: string) => RpcTransport;
  factsStep?: (rpc: RpcTransport) => Promise<V3FactsResult>;
  compile?: CompileFn;
  onCompiled?: (plan: unknown, manifest: DraftManifest, facts: Facts) => void;
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
    setPlan(undefined);
    if (!manifest || !live) return;
    if (!compile)
      return setCompileMsg(
        "The browser compiler is not wired in this build, so nothing was compiled.",
      );
    const r = await compile(manifest, live).catch((e: unknown) => ({
      ok: false as const,
      message: e instanceof Error ? e.message : String(e),
    }));
    if (!r.ok) return setCompileMsg(`Compile failed: ${r.message}`);
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
        const f = FORM_FIELDS[a.kind];
        return (
          <fieldset key={a.id} aria-label={`Action ${a.id}`}>
            <legend>
              {i + 1}. {a.kind} <code>{a.id}</code>
            </legend>
            {[...f.required, ...f.optional].map((k) => (
              <label key={k} className="small">
                {k}
                {f.required.includes(k) ? " *" : ""}
                <input
                  aria-label={`${a.id} ${k}`}
                  value={a.args[k] ?? ""}
                  onChange={(e) => update(i, { ...a, args: { ...a.args, [k]: e.target.value } })}
                />
              </label>
            ))}
            {!f.required.length && !f.optional.length && (
              <p className="muted small">No arguments.</p>
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
    </section>
  );
}
