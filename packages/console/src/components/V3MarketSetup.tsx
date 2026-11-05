import { useEffect, useRef, useState } from "react";
import { encodeAddress } from "@polkadot/util-crypto";
import { formatUnits, keccak256, type Address } from "viem";
import {
  address,
  hash,
  MarketWalletOperations,
  estimateMarketDeployment,
  newDeploymentId,
  profileFromDeployment,
  V3_NETWORK,
  factoryCreationData,
  REVIEW_ID,
  assertWalletNetwork,
  type Registry,
  type Wallet,
  type WalletClaim,
  type WalletCost,
} from "@seam/defi";
import { browserKV } from "../lib/runstore";
import { downloadJson } from "../lib/evidence";

type Props = {
  busy: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  onReady: (registry: Registry) => void;
  onNotice: (text: string) => void;
};
function operations() {
  const storage = browserKV();
  if (!storage) throw new Error("Persistent browser storage is required before a wallet request");
  return new MarketWalletOperations(storage);
}
export default function V3MarketSetup({ busy, run, onReady, onNotice }: Props) {
  const [connected, setConnected] = useState<{ account: Address; wallet: Wallet }>();
  const [deploymentId] = useState(newDeploymentId);
  const [cost, setCost] = useState<WalletCost>();
  const [funding, setFunding] = useState<string>();
  const [ack, setAck] = useState(false);
  const [transaction, setTransaction] = useState(
    () => new URLSearchParams(location.search).get("marketTx") ?? "",
  );
  const [claims, setClaims] = useState<WalletClaim[]>([]);
  const [knownHashes, setKnownHashes] = useState<Record<string, string>>({});
  const revision = useRef(0);
  const refresh = () => setClaims(operations().claims.list());
  useEffect(() => {
    try {
      refresh();
    } catch {
      /* The explicit read or deployment reports storage errors. */
    }
    const provider = (
      window as Window & {
        ethereum?: Wallet & {
          on?: (event: string, fn: () => void) => void;
          removeListener?: (event: string, fn: () => void) => void;
        };
      }
    ).ethereum;
    const changed = () => {
      revision.current++;
      setConnected(undefined);
      setCost(undefined);
      setFunding(undefined);
      setAck(false);
    };
    provider?.on?.("accountsChanged", changed);
    provider?.on?.("chainChanged", changed);
    return () => {
      provider?.removeListener?.("accountsChanged", changed);
      provider?.removeListener?.("chainChanged", changed);
    };
  }, []);
  useEffect(() => {
    if (!busy) {
      try {
        refresh();
      } catch {
        /* Explicit recovery reports errors. */
      }
    }
  }, [busy]);
  const connect = () =>
    run(async () => {
      setAck(false);
      setCost(undefined);
      setFunding(undefined);
      const wallet = (window as Window & { ethereum?: Wallet }).ethereum;
      if (!wallet)
        throw new Error(
          "Open this page with a fresh MetaMask, Rabby or compatible EVM test wallet installed.",
        );
      const accounts = await wallet.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts)) throw new Error("No EVM account selected");
      const account = address(accounts[0]);
      try {
        await wallet.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x190f1ca9" }],
        });
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === 4902))
          throw error;
        await wallet.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x190f1ca9",
              chainName: "Portaldot V3 Testnet",
              nativeCurrency: { name: "Test POT", symbol: "tPOT", decimals: 18 },
              rpcUrls: [V3_NETWORK.rpcUrl],
            },
          ],
        });
        await wallet.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x190f1ca9" }],
        });
      }
      await assertWalletNetwork(wallet, V3_NETWORK, account);
      setConnected({ account, wallet });
      onNotice(
        "Connected to V3. Connection and funding checks do not sign or submit a transaction.",
      );
    });
  const estimate = () =>
    run(async () => {
      if (!connected) return;
      setAck(false);
      setCost(undefined);
      setFunding(undefined);
      const version = revision.current;
      await assertWalletNetwork(connected.wallet, V3_NETWORK, connected.account);
      const next = await estimateMarketDeployment(connected.account, deploymentId);
      const response = await fetch("https://test-node-v3.portaldot.dev/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "state_call",
          params: ["ReviveApi_account_id", connected.account],
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw new Error(
          "The native funding destination could not be checked. Retry before funding.",
        );
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        !("result" in result) ||
        typeof result.result !== "string" ||
        !/^0x[0-9a-f]{64}$/i.test(result.result)
      )
        throw new Error("The V3 runtime did not return a valid native funding destination.");
      const mapped = encodeAddress(result.result, 42);
      await assertWalletNetwork(connected.wallet, V3_NETWORK, connected.account);
      if (revision.current !== version) return;
      setCost(next);
      setFunding(mapped);
      onNotice(
        "Cost and native funding destination checked without a signature. Refresh this estimate after funding.",
      );
    });
  const deploy = () =>
    run(async () => {
      if (!connected || !cost || !ack || cost.fundingShortfall !== "0") return;
      setAck(false);
      try {
        const registry = await operations().deploy(
          connected.wallet,
          connected.account,
          deploymentId,
          cost.maximumCost,
          onNotice,
          V3_NETWORK,
          cost.gasPrice,
        );
        onReady(registry);
      } finally {
        refresh();
        setCost(undefined);
      }
    });
  const recover = (claim: WalletClaim) =>
    run(async () => {
      try {
        const supplied = knownHashes[claim.id]?.trim();
        const recovered = await operations().recover(claim, supplied ? hash(supplied) : undefined);
        if (recovered.registry) onReady(recovered.registry);
        onNotice(
          `Wallet request: ${recovered.state}. Recovery read the chain; nothing was resent.`,
        );
      } finally {
        refresh();
      }
    });
  return (
    <section className="defi-card defi-setup" aria-label="V3 test market setup">
      <div className="defi-card-top">
        <div>
          <p className="eyebrow">PORTALDOT V3 TESTNET</p>
          <h2>Start a test market.</h2>
        </div>
        <span className="defi-environment">TEST ASSETS ONLY</span>
      </div>
      <p>
        Create a pool with 1,000,000 sUSD and 500 sETH, plus a vault seeded with 1,000 sUSD. Your
        wallet receives 10,000 sUSD and 10 sETH for swap, deposit and withdrawal testing. These
        minted assets have no monetary value. Native tPOT pays network costs; none is pooled.
      </p>
      <p>
        The bundled contracts have an engineering review and exact deployed bytecode checks. They
        have <strong>no independent security audit</strong>. The vault holds sUSD and has no yield
        strategy. The deployer controls the pool’s initial liquidity shares.
      </p>
      <p>
        <a href="https://github.com/rishu4436/seam-portaldot/blob/codex/defi-local-20261104/docs/defi-v3-engineering-review.md">
          Read the engineering review
        </a>{" "}
        ·{" "}
        <a href="https://github.com/rishu4436/seam-portaldot/tree/codex/defi-local-20261104/contracts/defi">
          Inspect the contract source
        </a>
      </p>
      <div className="defi-setup-actions">
        <button disabled={busy} onClick={() => void connect()}>
          {connected ? "Reconnect setup wallet" : "Connect test wallet for setup"}
        </button>
        <button disabled={busy || !connected} onClick={() => void estimate()}>
          Check funding & deployment cost
        </button>
      </div>
      {connected && (
        <p className="defi-account">
          Setup account<code>{connected.account}</code>
        </p>
      )}
      {cost && connected && (
        <div className="defi-review">
          <h3>Review market creation</h3>
          <dl>
            <dt>Network</dt>
            <dd>Portaldot V3 · {V3_NETWORK.chainId}</dd>
            <dt>Signer</dt>
            <dd>
              <code>{connected.account}</code>
            </dd>
            <dt>Maximum upfront wallet cost</dt>
            <dd>{formatUnits(BigInt(cost.maximumCost), 18)} tPOT</dd>
            <dt>Maximum gas price</dt>
            <dd>{formatUnits(BigInt(cost.gasPrice), 9)} Gwei · zero priority fee</dd>
            <dt>EVM spendable balance</dt>
            <dd>{formatUnits(BigInt(cost.balance), 18)} tPOT</dd>
            <dt>Funding shortfall</dt>
            <dd>{formatUnits(BigInt(cost.fundingShortfall), 18)} tPOT</dd>
            <dt>Native value sent to market</dt>
            <dd>0 tPOT</dd>
            <dt>Deployment ID</dt>
            <dd>
              <code>{deploymentId}</code>
            </dd>
            <dt>Creation input hash</dt>
            <dd>
              <code>{keccak256(factoryCreationData(deploymentId))}</code>
            </dd>
            <dt>Program review ID</dt>
            <dd>
              <code>{REVIEW_ID}</code>
            </dd>
          </dl>
          <p>
            V3’s gas estimate can include storage reservation. This buffered upfront limit is not a
            promise of the final fee. The estimate includes a 10% gas price buffer with zero
            priority fee. Wallet fee edits can invalidate the reviewed budget.
          </p>
          {funding && (
            <div className="defi-funding">
              <strong>Fund this native destination from your polkadot-js test account</strong>
              <code>{funding}</code>
              <p>
                The runtime resolved this destination for the EVM account above. For a fresh
                account, allow the current 0.1 tPOT native account deposit in addition to the EVM
                shortfall. Refresh the estimate after funding. Your native account and EVM wallet
                use different signing keys.
              </p>
              <p>
                Fresh-account funding guide: at least{" "}
                {formatUnits(BigInt(cost.fundingShortfall) + 100000000000000000n, 18)} tPOT, plus a
                margin for later approvals and actions. Confirm the destination and native account
                deposit in your funding wallet.
              </p>
            </div>
          )}
          <label className="defi-ack">
            <input
              type="checkbox"
              checked={ack}
              disabled={busy}
              onChange={(e) => setAck(e.target.checked)}
            />
            I reviewed the test assets, signer, liquidity ownership and maximum wallet cost.
          </label>
          <button
            className="defi-primary"
            disabled={busy || !ack || cost.fundingShortfall !== "0"}
            onClick={() => void deploy()}
          >
            Create test market in wallet
          </button>
        </div>
      )}
      <details>
        <summary>Open an existing reviewed market</summary>
        <label className="defi-setup-label">
          Market creation transaction
          <input
            spellCheck={false}
            value={transaction}
            disabled={busy}
            onChange={(e) => setTransaction(e.target.value)}
          />
        </label>
        <button
          disabled={busy || !transaction}
          onClick={() =>
            void run(async () => {
              onReady(await profileFromDeployment(hash(transaction.trim())));
              onNotice(
                "Market creation, finalized inclusion and all six deployed programs checked. Nothing was submitted.",
              );
            })
          }
        >
          Verify & open market
        </button>
      </details>
      {claims.length > 0 && (
        <details open>
          <summary>Saved setup wallet requests</summary>
          {claims.map((claim) => (
            <div className="defi-setup-claim" key={claim.id}>
              <strong>
                {claim.kind === "deploy-market" ? "Market creation" : "Test asset claim"} ·{" "}
                {claim.state}
              </strong>
              <code>{claim.hash ?? "No hash returned · reconcile before another request"}</code>
              {!claim.hash && (
                <label className="defi-setup-label">
                  Transaction hash from your wallet (optional)
                  <input
                    disabled={busy}
                    spellCheck={false}
                    value={knownHashes[claim.id] ?? ""}
                    onChange={(e) =>
                      setKnownHashes((old) => ({ ...old, [claim.id]: e.target.value }))
                    }
                  />
                </label>
              )}
              <button disabled={busy} onClick={() => void recover(claim)}>
                Recover without resending
              </button>
              {claim.registry && (
                <button
                  disabled={busy}
                  onClick={() => downloadJson("seam-v3-market.json", claim.registry!)}
                >
                  Export market profile
                </button>
              )}
              {!["requesting", "submitted", "uncertain"].includes(claim.state) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await operations().exclusive("seam.defi.wallet-journal.v1", async () =>
                        operations().claims.remove(claim.id),
                      );
                      refresh();
                    })
                  }
                >
                  Remove settled local request
                </button>
              )}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
