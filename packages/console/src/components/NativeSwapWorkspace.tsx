import { useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import {
  discoverNativePools,
  quoteNativeSwap,
  readAccountReadiness,
  readNativeSwapContext,
  readNativePool,
  verifyNativeSwap,
  type NativePool,
  type NativeSwapContext,
  type NativeSwapPlan,
} from "@seam/chain/browser";
import { browserExclusive, JOURNAL_LOCK } from "@seam/defi";
import { transportFor } from "../lib/chainclient";
import { listWalletAccounts, type WalletAccount } from "../lib/manifestbuilder";
import { sameWalletAccount, walletProviderFor } from "../lib/extensionsigner";
import { browserKV } from "../lib/runstore";
import { downloadJson } from "../lib/evidence";
import { NativeSwapStore, NATIVE_SWAP_STORE, type NativeSwapRow } from "../lib/native-swap-store";
import { submitNativeSwap } from "../lib/native-swap-execution";
import { V3_HTTPS_RPC } from "../lib/v3facts";
const send = transportFor(V3_HTTPS_RPC);
const money = (value: string, decimals: number) => formatUnits(BigInt(value), decimals);
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .replace(/0x[0-9a-f]{130,}/gi, "[transaction data]")
    .slice(0, 1000);
export function nativeAmount(text: string, decimals: number) {
  if (
    !/^\d+(?:\.\d+)?$/.test(text) ||
    (text.split(".")[1]?.length ?? 0) > decimals ||
    text.length > 80
  )
    throw Error(`Enter a positive amount with at most ${decimals} decimal places.`);
  const amount = parseUnits(text, decimals);
  if (amount <= 0n || amount >= 2n ** 128n)
    throw Error("Enter a positive amount within the native asset range.");
  return amount.toString();
}
function storage() {
  const kv = browserKV();
  if (!kv) throw Error("Persistent browser storage is required before a wallet request.");
  return new NativeSwapStore(kv);
}
export default function NativeSwapWorkspace({
  onBusyChange,
}: {
  onBusyChange: (busy: boolean) => void;
}) {
  const [pools, setPools] = useState<NativePool[]>([]),
    [context, setContext] = useState<NativeSwapContext>(),
    [assetId, setAssetId] = useState(8801000);
  const [accounts, setAccounts] = useState<WalletAccount[]>([]),
    [selected, setSelected] = useState("");
  const [reverse, setReverse] = useState(false),
    [amount, setAmount] = useState("0.01"),
    [slippage, setSlippage] = useState("0.5"),
    [feeLimit, setFeeLimit] = useState("0.05");
  const [plan, setPlan] = useState<NativeSwapPlan>(),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState<string>(),
    [problem, setProblem] = useState<string>();
  const [rows, setRows] = useState<NativeSwapRow[]>([]),
    [nativeBalance, setNativeBalance] = useState<string>(),
    [assetBalance, setAssetBalance] = useState<string>(),
    [now, setNow] = useState(Date.now());
  const file = useRef<HTMLInputElement>(null),
    revision = useRef(0),
    mounted = useRef(true);
  const refreshRows = () => setRows(storage().list());
  const invalidate = () => {
    revision.current++;
    setPlan(undefined);
    setAck(false);
  };
  const edit = (fn: () => void) => {
    invalidate();
    setProblem(undefined);
    setNotice(undefined);
    fn();
  };
  const wallet = accounts.find((a) => `${a.source}:${a.address}` === selected),
    pool = pools.find((p) => p.assetId === assetId);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    setNotice(undefined);
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setProblem(message(e));
    } finally {
      if (mounted.current) {
        setBusy(false);
        try {
          refreshRows();
        } catch (e) {
          setProblem(message(e));
        }
      }
    }
  };
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    try {
      storage().abandonUnsigned();
      refreshRows();
    } catch (e) {
      setProblem(message(e));
    }
    const changed = (event: StorageEvent) => {
      if (event.key === NATIVE_SWAP_STORE) {
        invalidate();
        try {
          refreshRows();
        } catch (e) {
          setProblem(message(e));
        }
      }
    };
    window.addEventListener("storage", changed);
    let cancelled = false;
    void (async () => {
      try {
        const ctx = await readNativeSwapContext(send);
        // Start with one live pool, avoiding a full-catalog request fan-out on every page load.
        const next = await readNativePool(send, ctx, 8801000)
          .then((p) => [p])
          .catch(() => discoverNativePools(send, ctx));
        if (!cancelled) {
          setContext(ctx);
          setPools(next);
          if (!next.some((p) => p.assetId === 8801000) && next[0]) setAssetId(next[0].assetId);
          if (!next.length)
            setProblem("No usable native pools were found. Retry the live pool read.");
        }
      } catch (e) {
        if (!cancelled) setProblem(message(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      window.removeEventListener("storage", changed);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setNativeBalance(undefined);
    setAssetBalance(undefined);
    if (wallet)
      void (async () => {
        try {
          const ctx = await readNativeSwapContext(send),
            b = await readAccountReadiness(send, ctx.facts, wallet.address, [String(assetId)], {
              at: ctx.block.hash,
            });
          if (!cancelled) {
            if (b.native.known) setNativeBalance(b.native.value.free);
            if (b.assets[0]?.balance.known) setAssetBalance(b.assets[0].balance.value.balance);
          }
        } catch (e) {
          if (!cancelled) setProblem(message(e));
        }
      })();
    return () => {
      cancelled = true;
    };
  }, [selected, assetId, wallet]);
  const connect = () =>
    run(async () => {
      invalidate();
      const result = await listWalletAccounts();
      if (!result.ok) throw Error(result.message);
      setAccounts(result.value);
      setSelected(`${result.value[0]!.source}:${result.value[0]!.address}`);
      setNotice("Wallet connected. Reading balances and quotes does not request a signature.");
    });
  const refresh = () =>
    run(async () => {
      invalidate();
      const ctx = await readNativeSwapContext(send),
        next = await discoverNativePools(send, ctx);
      setContext(ctx);
      setPools(next);
      if (!next.some((p) => p.assetId === assetId) && next[0]) setAssetId(next[0].assetId);
      setLoading(false);
      setNotice(`${next.length} liquid native pools read from finalized V3 state.`);
    });
  const quote = () =>
    run(async () => {
      invalidate();
      const atRevision = revision.current;
      if (!wallet || !pool) throw Error("Connect your native wallet and select a liquid pool.");
      if (!/^\d+(?:\.\d{1,2})?$/.test(slippage))
        throw Error("Enter slippage with at most two decimal places.");
      const result = await quoteNativeSwap(send, {
        signer: wallet.address,
        assetId,
        reverse,
        amountIn: nativeAmount(amount, reverse ? pool.decimals : 14),
        slippageBps: Number(parseUnits(slippage, 2)),
        feeLimit: nativeAmount(feeLimit, 14),
      });
      if (atRevision !== revision.current)
        throw Error("The form changed while reading. Read a new quote.");
      setContext(result.ctx);
      setPlan(result.plan);
      setPools((old) => old.map((p) => (p.assetId === assetId ? result.pool : p)));
      if (result.balances.native.known) setNativeBalance(result.balances.native.value.free);
      if (result.balances.assets[0]?.balance.known)
        setAssetBalance(result.balances.assets[0].balance.value.balance);
      setNotice(
        "Quote ready. Review the exact input, minimum output and fee estimate before signing.",
      );
    });
  const recover = async (row: NativeSwapRow) => {
    if (!row.hash) throw Error("This request was not submitted. Read a new quote to start again.");
    const verification = await verifyNativeSwap(
      send,
      row.plan,
      row.hash,
      row.verification?.block?.number,
    );
    const next: NativeSwapRow = {
      ...row,
      verification,
      state: ["verified", "reverted", "expired"].includes(verification.status)
        ? (verification.status as "verified" | "reverted" | "expired")
        : verification.status === "pending"
          ? "submitted"
          : "uncertain",
    };
    storage().save(next);
    refreshRows();
    setNotice(verification.message);
    return next;
  };
  const execute = () =>
    run(async () => {
      if (!wallet || !plan || !ack) throw Error("Review and acknowledge the current quote first.");
      const approved = plan,
        who = wallet;
      setPlan(undefined);
      setAck(false);
      const provider = await walletProviderFor({ address: who.address, extension: who.source });
      if (!provider.signer?.signPayload)
        throw Error("This wallet cannot sign native transaction payloads.");
      const assertAccount = async () => {
        const current = await provider.accounts.get();
        if (!current.some((a) => sameWalletAccount(a.address, approved.signer)))
          throw Error(
            "The approved account is no longer shared by the wallet. Nothing was submitted.",
          );
      };
      const row = await submitNativeSwap({
        send,
        plan: approved,
        store: storage(),
        sign: (p) => provider.signer!.signPayload!(p),
        assertAccount,
        notify: setNotice,
      });
      refreshRows();
      for (let i = 0; i < 8 && mounted.current; i++) {
        const next = await recover(row);
        if (["verified", "reverted", "expired"].includes(next.state)) break;
        if (i < 7) await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      setAssetBalance(undefined);
      setNativeBalance(undefined);
      if (mounted.current) {
        const ctx = await readNativeSwapContext(send),
          b = await readAccountReadiness(send, ctx.facts, who.address, [String(assetId)], {
            at: ctx.block.hash,
          });
        if (b.native.known) setNativeBalance(b.native.value.free);
        if (b.assets[0]?.balance.known) setAssetBalance(b.assets[0].balance.value.balance);
      }
    });
  const pending = rows.some((r) => ["submitted", "uncertain"].includes(r.state)),
    latest = rows.find((r) => r.hash),
    verified = latest?.state === "verified",
    expired = !!plan && now >= plan.expiresAt;
  const inputDecimals = reverse ? (pool?.decimals ?? 0) : 14,
    outputDecimals = reverse ? 14 : (pool?.decimals ?? 0),
    inputSymbol = reverse ? (pool?.symbol ?? "Asset") : "tPOT",
    outputSymbol = reverse ? "tPOT" : (pool?.symbol ?? "Asset");
  return (
    <section className="defi-workspace native-swap" aria-label="Native V3 swaps">
      <header className="defi-heading">
        <div>
          <p className="eyebrow">PORTALDOT V3 · NATIVE DEX</p>
          <h1>Swap with what you have.</h1>
          <p>Your native wallet. Existing liquidity. A result you can verify.</p>
        </div>
        <div className="native-connection">
          <span className={`defi-environment ${verified ? "ready" : ""}`}>
            {verified ? "VERIFIED EXECUTION" : pending ? "RECOVERY AVAILABLE" : "V3 TESTNET"}
          </span>
          {!wallet && (
            <button className="defi-primary" disabled={busy} onClick={() => void connect()}>
              Connect Polkadot wallet
            </button>
          )}
        </div>
      </header>
      <div className="defi-network-note">
        <span aria-hidden="true">⇄</span>
        <p>
          <strong>No contract deployment required.</strong>Use the tPOT already in your native
          account. Swaps use V3’s built-in DEX. Pool assets are community-created test tokens with
          no promised value.
        </p>
      </div>
      {notice && (
        <p className="defi-notice" role="status">
          {notice}
        </p>
      )}
      {problem && (
        <p className="defi-error" role="alert">
          {problem}
        </p>
      )}
      <div className="defi-grid">
        <section className="defi-card defi-trade">
          <div className="defi-card-top">
            <h2>Swap assets</h2>
            <span className="defi-small">NATIVE ROUTE</span>
          </div>
          <label>
            Pool
            <select
              aria-label="Native pool"
              disabled={busy || loading}
              value={assetId}
              onChange={(e) => edit(() => setAssetId(Number(e.target.value)))}
            >
              {!pools.length && (
                <option value={8801000}>
                  {loading ? "Reading live liquidity…" : "No pool available"}
                </option>
              )}
              {pools.map((p) => (
                <option value={p.assetId} key={p.assetId}>
                  tPOT / {p.symbol} · asset {p.assetId}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy || loading} onClick={() => void refresh()}>
            Refresh live pools
          </button>
          {wallet && (
            <>
              <label>
                Native account
                <select
                  aria-label="Native wallet account"
                  disabled={busy}
                  value={selected}
                  onChange={(e) => edit(() => setSelected(e.target.value))}
                >
                  {accounts.map((a) => (
                    <option key={`${a.source}:${a.address}`} value={`${a.source}:${a.address}`}>
                      {a.name ?? a.source} · {short(a.address)}
                    </option>
                  ))}
                </select>
              </label>
              <code className="native-address">{wallet.address}</code>
              <button disabled={busy} onClick={() => void connect()}>
                Reconnect wallet
              </button>
            </>
          )}
          <fieldset className="defi-fields" disabled={busy || !wallet || !pool || loading}>
            <label className="defi-amount-label">
              You spend
              <div className="defi-amount">
                <input
                  aria-label="Native swap amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => edit(() => setAmount(e.target.value))}
                />
                <strong>{inputSymbol}</strong>
              </div>
            </label>
            {wallet && (
              <p className="defi-small">
                Balance:{" "}
                {(reverse ? assetBalance : nativeBalance) !== undefined
                  ? money((reverse ? assetBalance : nativeBalance)!, inputDecimals)
                  : "Reading…"}{" "}
                {inputSymbol}
                {reverse && assetBalance && (
                  <button
                    onClick={() => edit(() => setAmount(money(assetBalance, pool?.decimals ?? 0)))}
                  >
                    Use balance
                  </button>
                )}
              </p>
            )}
            <div className="defi-direction">
              <button
                aria-label="Reverse native swap direction"
                onClick={() =>
                  edit(() => {
                    setReverse(!reverse);
                    setAmount(reverse ? "0.01" : "1");
                  })
                }
              >
                ↓
              </button>
              <span>Quoted from finalized pool state</span>
            </div>
            <div className="defi-output">
              <span>You receive · estimate</span>
              <div>
                <strong>{plan ? money(plan.quotedOut, outputDecimals) : "—"}</strong>
                <b>{outputSymbol}</b>
              </div>
            </div>
            <div className="defi-limits">
              <label>
                Slippage (%)
                <input
                  aria-label="Native slippage (%)"
                  inputMode="decimal"
                  value={slippage}
                  onChange={(e) => edit(() => setSlippage(e.target.value))}
                />
              </label>
              <label>
                Fee review limit (tPOT)
                <input
                  aria-label="Native fee review limit"
                  inputMode="decimal"
                  value={feeLimit}
                  onChange={(e) => edit(() => setFeeLimit(e.target.value))}
                />
              </label>
            </div>
            <p className="defi-small">
              Fee limit is checked before submission; the runtime sets the actual network fee. Test
              input is limited to 1 tPOT of pool value and 2% of the input reserve. Output returns
              to your selected account.
            </p>
            <button className="defi-primary" disabled={pending} onClick={() => void quote()}>
              {plan ? "Refresh quote" : "Read live quote"}
            </button>
          </fieldset>
          {plan && pool && (
            <section className="native-review" aria-label="Native swap approval">
              <h3>What you are approving</h3>
              <dl>
                <dt>Signer & recipient</dt>
                <dd>
                  <code>{plan.signer}</code>
                </dd>
                <dt>Network</dt>
                <dd>Portaldot V3 testnet · native</dd>
                <dt>Spend exactly</dt>
                <dd>
                  {money(plan.amountIn, inputDecimals)} {inputSymbol}
                </dd>
                <dt>Receive at least</dt>
                <dd>
                  {money(plan.minOut, outputDecimals)} {outputSymbol}
                </dd>
                <dt>Network fee estimate</dt>
                <dd>{money(plan.estimatedFee, 14)} tPOT</dd>
                <dt>Pool trading fee</dt>
                <dd>{pool.feePpm / 10000}% · included in quote</dd>
                <dt>Quote block</dt>
                <dd>#{plan.block.number}</dd>
                <dt>Quote expires</dt>
                <dd>
                  {expired
                    ? "Expired — read a new quote"
                    : `${Math.max(0, Math.ceil((plan.expiresAt - now) / 1000))} seconds`}
                </dd>
              </dl>
              <p className="defi-small">
                Minimum output and the mortal transaction window are enforced on chain. Seam also
                checks quote expiry before broadcasting. No unlimited approval is requested.
              </p>
              <label className="native-ack">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={busy || expired}
                  onChange={(e) => setAck(e.target.checked)}
                />
                I checked the account, amount, minimum output and fee estimate.
              </label>
              <button
                className="defi-primary"
                disabled={busy || pending || !ack || expired}
                onClick={() => void execute()}
              >
                Sign & submit native swap
              </button>
            </section>
          )}
        </section>
        <aside>
          <section className="defi-card">
            <p className="eyebrow">LIVE LIQUIDITY</p>
            <h2>Already on V3.</h2>
            {pool ? (
              <dl className="native-facts">
                <dt>Native reserve</dt>
                <dd>{money(pool.nativeReserve, 14)} tPOT</dd>
                <dt>Asset reserve</dt>
                <dd>
                  {money(pool.assetReserve, pool.decimals)} {pool.symbol}
                </dd>
                <dt>Asset ID</dt>
                <dd>{pool.assetId}</dd>
                <dt>Checked at finalized block</dt>
                <dd>#{context?.block.number}</dd>
              </dl>
            ) : (
              <p>
                {loading
                  ? "Reading finalized pool reserves…"
                  : "Refresh pools to read available liquidity."}
              </p>
            )}
            <p className="defi-small">
              Token names do not imply backing or a stable price. A live quote and signed dry run
              are required for every swap.
            </p>
          </section>
          <section className="defi-card native-vault-note">
            <p className="eyebrow">VAULTS</p>
            <h2>Priced separately.</h2>
            <p>
              Native swaps do not require a vault. Contract vault setup remains under Contract
              markets & vaults, with its own funding and code checks. No vault deployment or deposit
              happens here.
            </p>
          </section>
        </aside>
      </div>
      <section className="defi-card native-journal">
        <div className="defi-card-top">
          <div>
            <p className="eyebrow">PORTABLE EVIDENCE</p>
            <h2>Native swap activity</h2>
          </div>
          <div>
            <button
              disabled={busy || !rows.length}
              onClick={() => {
                try {
                  downloadJson("seam-native-swaps.json", storage().export());
                } catch (e) {
                  setProblem(message(e));
                }
              }}
            >
              Export native archive
            </button>
            <button disabled={busy} onClick={() => file.current?.click()}>
              Restore native archive
            </button>
            <input
              ref={file}
              hidden
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                event.target.value = "";
                if (chosen)
                  void run(async () => {
                    if (chosen.size > 512000) throw Error("Native archive exceeds 500 KB.");
                    const value = JSON.parse(await chosen.text());
                    const count = await browserExclusive(JOURNAL_LOCK, async () =>
                      storage().restore(value),
                    );
                    invalidate();
                    setNotice(
                      `Native archive restored: ${count} records checked and merged. Duplicates were skipped. Imported receipts need live verification. Nothing was submitted.`,
                    );
                  });
              }}
            />
          </div>
        </div>
        {!rows.length ? (
          <p>No native swaps yet. Connecting and reading a quote do not send a transaction.</p>
        ) : (
          rows.map((row) => (
            <article className="native-receipt" key={row.plan.id}>
              <div>
                <strong>
                  {row.state === "verified"
                    ? "Verified native swap"
                    : row.state === "not_sent"
                      ? "Not sent"
                      : row.state === "signing"
                        ? "Waiting for wallet"
                        : row.state === "reverted"
                          ? "Execution failed"
                          : row.state === "expired"
                            ? "Expired · not included"
                            : row.state === "uncertain"
                              ? "Submission uncertain"
                              : "Awaiting finality"}
                </strong>
                <p>
                  Asset {row.plan.assetId} · {row.plan.reverse ? "Asset → tPOT" : "tPOT → asset"}
                </p>
                {row.hash && <code>{row.hash}</code>}
                {row.verification?.actualOut && (
                  <p>
                    Verified output: {row.verification.actualOut} base units
                    {row.verification.actualFee
                      ? ` · actual network fee ${money(row.verification.actualFee, 14)} tPOT`
                      : ""}
                  </p>
                )}
                {row.verification?.block && <p>Finalized block #{row.verification.block.number}</p>}
                {row.verification?.message && <p>{row.verification.message}</p>}
                {row.note && <p>{row.note}</p>}
              </div>
              {row.hash && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await recover(row);
                    })
                  }
                >
                  Verify / recover on V3
                </button>
              )}
            </article>
          ))
        )}
      </section>
    </section>
  );
}
