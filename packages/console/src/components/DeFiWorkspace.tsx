import { useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import {
  DeFiClient,
  DeFiStore,
  Executor,
  JOURNAL_LOCK,
  STORE_KEY,
  browserExclusive,
  address,
  parseRegistry,
  verifyRecord,
  pilotMetrics,
  hasReviewedProgram,
  MarketWalletOperations,
  type Action,
  type Plan,
  type RecordEntry,
  type Registry,
  type Verification,
  type Wallet,
} from "@seam/defi";
import { downloadJson } from "../lib/evidence";
import "./defi.css";
import { browserKV } from "../lib/runstore";
import V3MarketSetup from "./V3MarketSetup";
const MARKET_KEY = "seam.defi.market-profile.v1";
function localStore() {
  const kv = browserKV();
  if (!kv)
    throw new Error("Persistent browser storage is unavailable. Wallet submission is blocked.");
  return new DeFiStore(kv);
}
type Connected = { account: Address; wallet: Wallet; local: boolean };
type Positions = Awaited<ReturnType<DeFiClient["positions"]>>;
const errorText = (e: unknown) => {
  const message =
    e && typeof e === "object" && "shortMessage" in e && typeof e.shortMessage === "string"
      ? e.shortMessage
      : e instanceof Error
        ? e.message
        : String(e);
  return message.replace(/0x[0-9a-f]{130,}/gi, "[transaction data]").slice(0, 1000);
};
const short = (v: string) => `${v.slice(0, 8)}…${v.slice(-6)}`;
const money = (value: string, decimals: number) => formatUnits(BigInt(value), decimals);
const statusLabel = (v?: Verification) =>
  !v
    ? "Not checked"
    : v.status === "local-confirmed"
      ? "Effect confirmed locally"
      : v.status === "verified"
        ? "Verified on testnet"
        : v.status === "pending"
          ? "Verification pending"
          : v.status === "reverted"
            ? "Execution reverted · fees paid"
            : "Verification failed";
export default function DeFiWorkspace({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [registry, setRegistry] = useState<Registry>(),
    [connection, setConnection] = useState<Connected>();
  const [setupOpen, setSetupOpen] = useState(() =>
    new URLSearchParams(location.search).has("marketTx"),
  );
  const [positions, setPositions] = useState<Positions>(),
    [action, setAction] = useState<Action>("swap"),
    [reverse, setReverse] = useState(false);
  const [amount, setAmount] = useState("100"),
    [recipient, setRecipient] = useState(""),
    [slippage, setSlippage] = useState("0.5"),
    [ttl, setTtl] = useState("300"),
    [feeCap, setFeeCap] = useState("0.01");
  const [plan, setPlan] = useState<Plan>(),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string>(),
    [problem, setProblem] = useState<string>();
  const [cost, setCost] = useState<Awaited<ReturnType<DeFiClient["previewCost"]>>>();
  const [claimCost, setClaimCost] =
    useState<Awaited<ReturnType<MarketWalletOperations["estimateClaim"]>>>();
  const [rows, setRows] = useState<RecordEntry[]>([]),
    [checks, setChecks] = useState<Record<string, Verification>>({}),
    [allowance, setAllowance] = useState<string>();
  const revision = useRef(0),
    file = useRef<HTMLInputElement>(null),
    profileFile = useRef<HTMLInputElement>(null);
  const client = registry ? new DeFiClient(registry) : undefined;
  const invalidate = () => {
    revision.current++;
    setPlan(undefined);
    setAck(false);
    setAllowance(undefined);
    setCost(undefined);
    setClaimCost(undefined);
  };
  const refreshJournal = () => setRows(localStore().list());
  useEffect(() => {
    try {
      refreshJournal();
      const saved = browserKV()?.getItem(MARKET_KEY);
      if (saved) setRegistry(parseRegistry(JSON.parse(saved)));
    } catch (e) {
      setProblem(errorText(e));
    }
    if (import.meta.env.DEV)
      void fetch("/__seam_defi/registry")
        .then(async (response) => {
          if (response.ok) setRegistry(parseRegistry(await response.json()));
        })
        .catch(() => {});
    const changed = (event: StorageEvent) => {
      if (event.key === STORE_KEY) {
        try {
          refreshJournal();
        } catch (e) {
          setProblem(errorText(e));
        }
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    const provider = (
      window as Window & {
        ethereum?: {
          on?: (event: string, fn: () => void) => void;
          removeListener?: (event: string, fn: () => void) => void;
        };
      }
    ).ethereum;
    const changed = () => {
      revision.current++;
      setPlan(undefined);
      setAck(false);
      setConnection(undefined);
      setPositions(undefined);
      setCost(undefined);
      setClaimCost(undefined);
      setNotice("Wallet account or network changed. Reconnect and read a new quote.");
    };
    provider?.on?.("accountsChanged", changed);
    provider?.on?.("chainChanged", changed);
    return () => {
      provider?.removeListener?.("accountsChanged", changed);
      provider?.removeListener?.("chainChanged", changed);
    };
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    setNotice(undefined);
    try {
      await fn();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
      try {
        refreshJournal();
      } catch (e) {
        setProblem(errorText(e));
      }
    }
  };
  const connect = async (local = false) =>
    run(async () => {
      if (!client) throw new Error("Load a market profile first");
      await client.audit();
      let connected: Connected;
      if (local && import.meta.env.DEV) {
        const { localWallet } = await import("../lib/defi-local-wallet");
        const result = await localWallet(client.registry.rpcUrl);
        connected = { account: address(result.account), wallet: result.wallet, local: true };
      } else {
        const wallet = (window as Window & { ethereum?: Wallet }).ethereum;
        if (!wallet)
          throw new Error(
            "Install an EVM wallet to use this market. The native Substrate wallet remains in New transaction.",
          );
        const accounts = await wallet.request({ method: "eth_requestAccounts" });
        if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
          throw new Error("No EVM account selected");
        connected = { wallet, account: address(accounts[0]), local: false };
        await client.walletIdentity(wallet, connected.account);
      }
      invalidate();
      const version = revision.current;
      const balances = await client.positions(connected.account);
      await client.walletIdentity(connected.wallet, connected.account);
      if (version !== revision.current) return;
      setConnection(connected);
      setRecipient(connected.account);
      setPositions(balances);
      setNotice("Network and contract identities checked. Balances read without a signature.");
    });
  const read = async () =>
    run(async () => {
      if (!client || !connection) return;
      const version = revision.current;
      const balances = await client.positions(connection.account);
      if (version !== revision.current) return;
      setPositions(balances);
      setNotice("Balances and the vault exit limit refreshed from one block.");
    });
  const quote = async () =>
    run(async () => {
      if (!client || !connection) return;
      invalidate();
      const version = revision.current;
      if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(slippage))
        throw new Error("Slippage needs at most two decimal places");
      if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(feeCap))
        throw new Error("Enter an exact positive native fee budget");
      const result = await client.quote({
        action,
        account: connection.account,
        recipient,
        amount,
        reverse,
        slippageBps: Math.round(Number(slippage) * 100),
        ttlSeconds: Number(ttl),
        maxTotalFee: parseUnits(feeCap, 18).toString(),
      });
      const approved = await client.allowance(result);
      const preview = await client.previewCost(result);
      if (version !== revision.current) return;
      setPlan(result);
      setAllowance(approved.toString());
      setCost(preview);
      setNotice(
        "Quote bound to your account, recipient, limits and this deployment. Review before continuing.",
      );
    });
  const execute = async () =>
    run(async () => {
      if (!client || !connection || !plan || !ack) return;
      const version = revision.current;
      const row = await new Executor(client, connection.wallet, localStore()).execute(
        plan,
        setNotice,
      );
      const result = await verifyRecord(row);
      setChecks((old) => ({ ...old, [row.plan.id]: result }));
      if (version !== revision.current) {
        setNotice(
          `Receipt saved for the original account ${plan.account}. Reconnect to refresh balances.`,
        );
        return;
      }
      invalidate();
      const refreshVersion = revision.current;
      setNotice(
        `${statusLabel(result)}. Receipt saved. ${result.status === "local-confirmed" ? "Local inclusion does not establish V3 testnet finality." : ""}`,
      );
      const balances = await client.positions(connection.account);
      if (refreshVersion === revision.current) setPositions(balances);
    });
  const verify = async (row: RecordEntry) =>
    run(async () => {
      const result = await verifyRecord(row);
      setChecks((old) => ({ ...old, [row.plan.id]: result }));
      setNotice(`${statusLabel(result)}. Nothing was submitted.`);
    });
  const recover = async (row: RecordEntry) =>
    run(async () => {
      const store = localStore(),
        recoveryClient = new DeFiClient(row.registry);
      const recovered = await new Executor(
        recoveryClient,
        connection?.wallet ?? {
          request: async () => {
            throw new Error("Recovery never requests a signature");
          },
        },
        store,
      ).recover(row);
      const result = await verifyRecord(recovered);
      setChecks((old) => ({ ...old, [row.plan.id]: result }));
      setNotice(`Recovery checked. ${statusLabel(result)}. Nothing was resent.`);
    });
  const revoke = async (row: RecordEntry) =>
    run(async () => {
      if (!connection) throw new Error("Connect the account that granted this approval");
      await new Executor(new DeFiClient(row.registry), connection.wallet, localStore()).revoke(
        row.plan,
        setNotice,
      );
      setNotice("Unused token allowance revoked. No economic action was sent.");
    });
  const remove = async (row: RecordEntry) =>
    run(async () => {
      await browserExclusive(JOURNAL_LOCK, async () => localStore().remove(row.plan.id));
      setChecks((old) => {
        const next = { ...old };
        delete next[row.plan.id];
        return next;
      });
      setNotice(
        "Saved plan removed from this device. An exported archive can restore it. No on-chain state or allowance was changed.",
      );
    });
  const tokenIn = registry
    ? action === "swap"
      ? registry.tokens[reverse ? 1 : 0]
      : action === "deposit"
        ? registry.tokens[0]
        : registry.vault
    : undefined;
  const tokenOut = registry
    ? action === "swap"
      ? registry.tokens[reverse ? 0 : 1]
      : action === "deposit"
        ? registry.vault
        : registry.tokens[0]
    : undefined;
  const native = registry?.mode === "local" ? "local ETH" : "tPOT";
  const edit = (fn: () => void) => {
    invalidate();
    fn();
  };
  const readyMarket = (next: Registry) => {
    const kv = browserKV();
    if (!kv) throw new Error("Persistent browser storage is unavailable");
    kv.setItem(MARKET_KEY, JSON.stringify(next));
    invalidate();
    setConnection(undefined);
    setPositions(undefined);
    setRegistry(next);
    setSetupOpen(false);
  };
  const claimTestAssets = (send: boolean) =>
    run(async () => {
      if (!connection || !registry?.review) return;
      const kv = browserKV();
      if (!kv) throw new Error("Persistent browser storage is required");
      const operations = new MarketWalletOperations(kv);
      if (!send) {
        setClaimCost(await operations.estimateClaim(connection.account, registry));
        return;
      }
      if (!claimCost || claimCost.fundingShortfall !== "0") return;
      const version = revision.current;
      try {
        await operations.claim(
          connection.wallet,
          connection.account,
          registry,
          claimCost.maximumCost,
          setNotice,
          claimCost.gasPrice,
        );
        setNotice("Test assets claimed. Nothing with monetary value was minted.");
        const balances = await client!.positions(connection.account);
        if (version === revision.current) setPositions(balances);
      } finally {
        setClaimCost(undefined);
      }
    });
  return (
    <div className="defi-workspace">
      <div className="defi-heading">
        <div>
          <p className="eyebrow">PROTECTED DEFI ON PORTALDOT V3</p>
          <h1>Swap. Deposit. Withdraw.</h1>
          <p>Choose an action, review your limits and verify the result.</p>
        </div>
        <span className={`defi-environment ${registry ? "ready" : ""}`}>
          {registry?.mode === "local"
            ? "LOCAL DEVELOPMENT"
            : registry
              ? hasReviewedProgram(registry)
                ? "V3 TESTNET · SEAM TEST MARKET"
                : "V3 TESTNET · READ ONLY"
              : "V3 TESTNET · SETUP REQUIRED"}
        </span>
      </div>
      <div className="defi-tabs defi-action-nav" role="group" aria-label="DeFi action">
        {(["swap", "deposit", "redeem"] as Action[]).map((id) => (
          <button
            key={id}
            disabled={busy}
            aria-pressed={action === id}
            onClick={() =>
              edit(() => {
                setAction(id);
                setAmount(id === "redeem" ? "1" : "100");
              })
            }
          >
            {id === "redeem" ? "Withdraw" : id[0].toUpperCase() + id.slice(1)}
          </button>
        ))}
      </div>
      <div className="defi-network-note">
        <span aria-hidden="true">◈</span>
        <p>
          {registry?.mode === "local" ? (
            "An executable local market, with development funds. The reference pool and vault are experimental; the vault holds assets and has no yield strategy."
          ) : registry && hasReviewedProgram(registry) ? (
            "A test market with minted sUSD and sETH. Native tPOT pays network costs. The vault has no yield strategy. Engineering reviewed; no independent security audit. Native asset IDs are not ERC-20 addresses."
          ) : (
            <>
              <strong>Market setup required.</strong> Swap, Deposit and Withdraw unlock after you
              create or open a verified test market. Connect a test wallet in setup and review its
              funding requirement.
            </>
          )}
        </p>
        {!registry && (
          <button className="defi-setup-cta" disabled={busy} onClick={() => setSetupOpen(true)}>
            Set up or open market
          </button>
        )}
        <button disabled={busy} onClick={() => profileFile.current?.click()}>
          Load market profile
        </button>
        <input
          hidden
          type="file"
          accept="application/json,.json"
          ref={profileFile}
          onChange={(event) => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (selected)
              void run(async () => {
                if (selected.size > 20000) throw new Error("Market profile exceeds 20 KB");
                const next = parseRegistry(JSON.parse(await selected.text()));
                await new DeFiClient(next).audit();
                readyMarket(next);
                setNotice(
                  "Profile identities checked. Matching code hashes are not a security audit.",
                );
              });
          }}
        />
      </div>
      {registry?.mode !== "local" && (
        <details
          className="defi-market-details"
          open={setupOpen}
          onToggle={(event) => setSetupOpen(event.currentTarget.open)}
        >
          <summary>Market setup & recovery</summary>
          <V3MarketSetup busy={busy} run={run} onReady={readyMarket} onNotice={setNotice} />
        </details>
      )}
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
            <h2>
              {action === "swap"
                ? "Swap assets"
                : action === "deposit"
                  ? "Deposit into the vault"
                  : "Withdraw your assets"}
            </h2>
            <span className="defi-small">01 / Intent</span>
          </div>
          <fieldset disabled={busy || !registry || !connection} className="defi-fields">
            <label className="defi-amount-label">
              {action === "redeem" ? "Shares to redeem" : "You spend"}
              <div className="defi-amount">
                <input
                  aria-label="Amount to spend"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => edit(() => setAmount(e.target.value))}
                />
                <strong>{tokenIn?.symbol ?? "—"}</strong>
              </div>
            </label>
            <div className="defi-direction">
              {action === "swap" ? (
                <button
                  aria-label="Reverse swap direction"
                  onClick={() => edit(() => setReverse(!reverse))}
                >
                  ↓
                </button>
              ) : (
                <span>↓</span>
              )}
              <span>
                {action === "swap"
                  ? "Quoted from the pool"
                  : action === "deposit"
                    ? "Receive vault shares"
                    : "Receive underlying assets"}
              </span>
            </div>
            <div className="defi-output">
              <span>You receive{plan ? " · estimate" : ""}</span>
              <div>
                <strong>{plan && tokenOut ? money(plan.quotedOut, tokenOut.decimals) : "—"}</strong>
                <b>{tokenOut?.symbol ?? "—"}</b>
              </div>
            </div>
            <label>
              Recipient
              <input
                aria-label="DeFi recipient"
                spellCheck={false}
                value={recipient}
                onChange={(e) => edit(() => setRecipient(e.target.value))}
              />
            </label>
            <div className="defi-limits">
              <label>
                Slippage (%)
                <input
                  inputMode="decimal"
                  value={slippage}
                  onChange={(e) => edit(() => setSlippage(e.target.value))}
                />
              </label>
              <label>
                Quote life (seconds)
                <input
                  inputMode="numeric"
                  value={ttl}
                  onChange={(e) => edit(() => setTtl(e.target.value))}
                />
              </label>
              <label>
                Maximum wallet cost ({native})
                <input
                  inputMode="decimal"
                  value={feeCap}
                  onChange={(e) => edit(() => setFeeCap(e.target.value))}
                />
              </label>
            </div>
          </fieldset>
          {!connection ? (
            <div className="defi-connect">
              <button
                className="defi-primary"
                disabled={busy || !registry}
                onClick={() => void connect()}
              >
                Connect EVM wallet
              </button>
              {import.meta.env.DEV && registry?.mode === "local" && (
                <button disabled={busy} onClick={() => void connect(true)}>
                  Use funded local account
                </button>
              )}
            </div>
          ) : (
            <>
              <p className="defi-account">
                {connection.local ? "Local unlocked development account" : "Connected EVM account"}
                <code title={connection.account}>{connection.account}</code>
              </p>
              <button className="defi-primary" disabled={busy} onClick={() => void quote()}>
                {busy ? "Checking…" : "Read protected quote"}
              </button>
            </>
          )}
          {plan && (
            <div className="defi-review">
              <div className="defi-card-top">
                <h2>What you are approving</h2>
                <span>02 / Review</span>
              </div>
              <dl>
                <dt>Action / network</dt>
                <dd>
                  {plan.action} · {registry?.chainId}
                </dd>
                <dt>Signer</dt>
                <dd>
                  <code>{plan.account}</code>
                </dd>
                <dt>Recipient</dt>
                <dd>
                  <code>{plan.recipient}</code>
                </dd>
                <dt>Maximum spend</dt>
                <dd>
                  {money(plan.amountIn, tokenIn!.decimals)} {tokenIn!.symbol}
                </dd>
                <dt>Minimum received</dt>
                <dd>
                  {money(plan.minAmountOut, tokenOut!.decimals)} {tokenOut!.symbol}
                </dd>
                <dt>Expires</dt>
                <dd>{new Date(plan.deadline * 1000).toLocaleTimeString()}</dd>
                <dt>Total wallet cost budget</dt>
                <dd>
                  {money(plan.maxTotalFee, 18)} {native}
                </dd>
                <dt>Maximum gas price</dt>
                <dd>{money(plan.maxGasPrice, 9)} Gwei</dd>
                <dt>Approval</dt>
                <dd>
                  Exact input amount to <code>{short(registry!.guard.address)}</code>
                  {allowance && BigInt(allowance) > 0n && allowance !== plan.amountIn
                    ? " · old allowance reset first"
                    : ""}
                </dd>
              </dl>
              {cost && (
                <div className="defi-cost">
                  <strong>
                    Simulated maximum wallet cost: {money(cost.maximumCost, 18)} {native}
                  </strong>
                  <p>
                    Includes buffered gas for {cost.steps.map((row) => row.phase).join(" + ")} at
                    the approved gas price ceiling. V3 estimates can include storage reservation.
                    This is an upfront limit, not the final fee.
                  </p>
                  {BigInt(cost.maximumCost) > BigInt(plan.maxTotalFee) && (
                    <>
                      <p>
                        The current budget is too low. Updating it clears this review; read a new
                        quote afterward.
                      </p>
                      <button
                        disabled={busy}
                        onClick={() =>
                          edit(() =>
                            setFeeCap(
                              money(
                                ((BigInt(cost.maximumCost) * 110n + 99n) / 100n).toString(),
                                18,
                              ),
                            ),
                          )
                        }
                      >
                        Use estimate + 10% budget & clear review
                      </button>
                    </>
                  )}
                  {BigInt(cost.fundingShortfall) > 0n && (
                    <p>
                      Fund the EVM account with at least {money(cost.fundingShortfall, 18)} more{" "}
                      {native} before continuing.
                    </p>
                  )}
                </div>
              )}
              <p>
                Slippage limits movement after this quote; they do not prove a fair price. This
                adapter has no independent price oracle.
              </p>
              <p>
                Token approval and the action are separate transactions. Each is simulated and
                checked against the remaining fee budget before its wallet request. The action
                simulation follows approval. A failed action can leave an allowance; revoke it
                below. Wallet fee overrides can exceed a reviewed budget and will fail receipt
                verification.
              </p>
              <label className="defi-ack">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={busy}
                  onChange={(e) => setAck(e.target.checked)}
                />
                I reviewed the recipient, minimum output, allowance and fee budget.
              </label>
              <button
                className="defi-primary"
                disabled={
                  busy ||
                  !ack ||
                  !registry ||
                  (registry.mode !== "local" && !hasReviewedProgram(registry)) ||
                  !cost ||
                  BigInt(cost.maximumCost) > BigInt(plan.maxTotalFee) ||
                  cost.fundingShortfall !== "0"
                }
                onClick={() => void execute()}
              >
                {busy
                  ? "Execution in progress…"
                  : connection?.local
                    ? "Execute on local chain"
                    : "Approve exact amount & execute"}
              </button>
              <small>Changing any field clears this review. No unlimited token approvals.</small>
            </div>
          )}
        </section>
        <aside className="defi-side">
          <section className="defi-card">
            <div className="defi-card-top">
              <span className="eyebrow">YOUR POSITIONS</span>
              <button disabled={busy || !connection} onClick={() => void read()}>
                Refresh
              </button>
            </div>
            <h2>Capital you control.</h2>
            {registry?.review && connection && (
              <div className="defi-faucet">
                <p>
                  Need test assets? Each address can claim 10,000 sUSD and 10 sETH once. Market
                  creators receive them automatically.
                </p>
                <button disabled={busy} onClick={() => void claimTestAssets(false)}>
                  Estimate test asset claim
                </button>
                {claimCost && (
                  <>
                    <p>
                      Maximum upfront cost: {money(claimCost.maximumCost, 18)} {native}. EVM
                      shortfall: {money(claimCost.fundingShortfall, 18)} {native}. Review this
                      network cost before signing.
                    </p>
                    <button
                      disabled={busy || claimCost.fundingShortfall !== "0"}
                      onClick={() => void claimTestAssets(true)}
                    >
                      Approve test asset claim in wallet
                    </button>
                  </>
                )}
              </div>
            )}
            {registry?.review && (
              <p className="defi-market-link">
                <a href={`?view=defi&marketTx=${registry.review.deploymentTransaction}`}>
                  Open or share this market
                </a>{" "}
                ·{" "}
                <button
                  disabled={busy}
                  onClick={() => downloadJson("seam-v3-market.json", registry)}
                >
                  Export profile
                </button>
              </p>
            )}
            {positions ? (
              <>
                <div className="defi-balances">
                  {positions.balances.map((row) => (
                    <div key={row.token.address}>
                      <span>
                        {row.token.symbol}
                        <small>
                          {row.token.address === registry?.vault.address
                            ? "Vault shares"
                            : "Wallet balance"}
                        </small>
                      </span>
                      <strong>{money(row.balance, row.token.decimals)}</strong>
                    </div>
                  ))}
                </div>
                <div className="defi-position">
                  <span>Vault exit estimate</span>
                  <strong>
                    {money(positions.redeemable, registry!.tokens[0].decimals)}{" "}
                    {registry!.tokens[0].symbol}
                  </strong>
                  <p>
                    Redeemable now: {money(positions.maxRedeem, registry!.vault.decimals)} shares.
                    Preview can change before execution.
                  </p>
                  <button
                    disabled={busy || BigInt(positions.maxRedeem) === 0n}
                    onClick={() =>
                      edit(() => {
                        setAction("redeem");
                        setAmount(money(positions.maxRedeem, registry!.vault.decimals));
                        setRecipient(connection!.account);
                      })
                    }
                  >
                    Withdraw available shares ↗
                  </button>
                </div>
                <p className="defi-small">
                  Native fee balance: {money(positions.native, 18)} {native}
                  <br />
                  Read at block #{positions.block}
                </p>
              </>
            ) : (
              <div className="defi-empty">
                <span>◎</span>
                <p>Connect an account to read token balances and available vault exits.</p>
              </div>
            )}
          </section>
          <section className="defi-card defi-assurance">
            <span className="eyebrow">LIMITS THAT TRAVEL WITH THE CALL</span>
            <h2>A result you can inspect.</h2>
            <ol>
              <li>
                <b>Bind the intent</b>
                <p>Network, signer, deployment, tokens and limits form one plan.</p>
              </li>
              <li>
                <b>Enforce on chain</b>
                <p>Minimum output, deadline, gas price and one execution per plan.</p>
              </li>
              <li>
                <b>Verify independently</b>
                <p>Canonical call bytes, contract identities and token transfer evidence.</p>
              </li>
            </ol>
            <p className="defi-small">
              No APY promise. No lending or leverage. Code identity checks establish identity, not
              economic safety or an audit. V3 integrations need separate review.
            </p>
          </section>
        </aside>
      </div>
      <section className="defi-card defi-activity">
        <div className="defi-card-top">
          <div>
            <p className="eyebrow">PORTABLE EVIDENCE</p>
            <h2>Activity & recovery</h2>
          </div>
          <div className="defi-actions">
            <button
              disabled={busy || rows.length === 0}
              onClick={() =>
                downloadJson("seam-defi-pilot-metrics.json", pilotMetrics(rows, checks))
              }
            >
              Export pilot metrics
            </button>
            <button
              disabled={busy || rows.length === 0}
              onClick={() => {
                try {
                  downloadJson("seam-defi-archive.json", JSON.parse(localStore().export()));
                } catch (e) {
                  setProblem(errorText(e));
                }
              }}
            >
              Export archive
            </button>
            <button disabled={busy} onClick={() => file.current?.click()}>
              Restore archive
            </button>
            <input
              ref={file}
              hidden
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const selected = e.target.files?.[0];
                e.target.value = "";
                if (selected)
                  void run(async () => {
                    if (selected.size > 4_000_000) throw new Error("Archive exceeds 4 MB");
                    const archiveText = await selected.text();
                    const result = await browserExclusive(JOURNAL_LOCK, async () =>
                      localStore().restore(archiveText),
                    );
                    setNotice(
                      `Archive restored: ${result.checked} plans checked; ${result.added} added. Existing plans deduplicated. Verify restored evidence against its network. Nothing was submitted.`,
                    );
                  });
              }}
            />
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="defi-empty">
            <p>
              Your plans and receipts stay on this device. Export an archive to keep a portable
              copy.
            </p>
          </div>
        ) : (
          rows.map((row) => (
            <article className="defi-receipt" key={row.plan.id}>
              <div className="defi-receipt-title">
                <div>
                  <b>
                    {row.plan.action === "redeem"
                      ? "Withdrawal"
                      : row.plan.action[0].toUpperCase() + row.plan.action.slice(1)}
                  </b>
                  <span>
                    {row.registry.mode === "local" ? "Local chain" : "V3 testnet"} ·{" "}
                    {new Date(row.createdAt).toLocaleString()}
                  </span>
                </div>
                <span className={`defi-proof ${checks[row.plan.id]?.status ?? "unchecked"}`}>
                  {statusLabel(checks[row.plan.id])}
                </span>
              </div>
              <code className="defi-plan-id">Plan {row.plan.id}</code>
              <p className="defi-small">
                {row.attempts.length
                  ? row.attempts
                      .map(
                        (a) =>
                          `${a.phase}: ${a.state === "rejected" ? "rejected by wallet · not sent" : a.state}`,
                      )
                      .join(" / ")
                  : "Plan recorded · no wallet request"}
              </p>
              <div className="defi-actions">
                <button disabled={busy} onClick={() => void verify(row)}>
                  Verify against network
                </button>
                <button disabled={busy} onClick={() => void recover(row)}>
                  Recover receipt
                </button>
                <button disabled={busy || !connection} onClick={() => void revoke(row)}>
                  Revoke unused allowance
                </button>
                <button
                  disabled={
                    busy ||
                    row.attempts.some((a) =>
                      ["requesting", "submitted", "uncertain"].includes(a.state),
                    )
                  }
                  onClick={() => void remove(row)}
                >
                  Remove saved plan
                </button>
              </div>
              {checks[row.plan.id] && (
                <details>
                  <summary>Verification checks</summary>
                  <ul>
                    {checks[row.plan.id].checks.map((c, i) => (
                      <li key={i}>
                        <b>{c.status.toUpperCase()}</b> · {c.label}
                        {c.detail ? ` — ${c.detail}` : ""}
                      </li>
                    ))}
                  </ul>
                  {checks[row.plan.id].hash && (
                    <p className="defi-small">
                      Transaction <code>{checks[row.plan.id].hash}</code>
                    </p>
                  )}
                </details>
              )}
            </article>
          ))
        )}
      </section>
    </div>
  );
}
