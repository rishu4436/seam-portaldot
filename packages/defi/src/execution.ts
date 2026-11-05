import { encodeFunctionData, toHex, type Address, type Hex } from "viem";
import { DeFiClient, same, gasPriceLimit, type Wallet } from "./client.js";
import { tokenAbi } from "./abi.js";
import { hash, invariant, parsePlan, type Plan } from "./model.js";
import { DeFiStore, type Attempt, type RecordEntry } from "./store.js";
import { hasReviewedProgram } from "./review.js";
export type Exclusive = <T>(name: string, work: () => Promise<T>) => Promise<T>;
export const JOURNAL_LOCK = "seam.defi.wallet-journal.v1";
export const browserExclusive: Exclusive = async (name, work) => {
  invariant(
    typeof navigator !== "undefined" && navigator.locks,
    "This browser cannot safely coordinate wallet requests across tabs",
  );
  return navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    invariant(lock, "A wallet operation is already open in another tab");
    return work();
  });
};
export class Executor {
  constructor(
    readonly client: DeFiClient,
    readonly wallet: Wallet,
    readonly store: DeFiStore,
    readonly exclusive: Exclusive = browserExclusive,
  ) {}
  private async send(
    row: RecordEntry,
    phase: Attempt["phase"],
    to: Address,
    data: Hex,
    notify: (text: string) => void,
  ) {
    const { client, wallet, store } = this,
      p = row.plan;
    if (phase === "revoke") {
      parsePlan(p, client.registry);
      await client.audit();
    } else await client.preflight(p);
    await client.walletIdentity(wallet, p.account);
    store.assertNoExternalRequests(p.account, client.registry.chainId);
    const unresolved = store.unresolved(p.account, client.registry.chainId);
    invariant(
      unresolved.length === 0,
      "An earlier wallet request needs recovery before another can be sent",
    );
    const nonce = await client.rpc.getTransactionCount({ address: p.account, blockTag: "pending" });
    const gasPrice = await client.rpc.getGasPrice();
    invariant(gasPrice <= BigInt(p.maxGasPrice), "Gas price exceeds your approved limit");
    const walletPriceCap = client.registry.mode === "v3-testnet" ? BigInt(p.maxGasPrice) : gasPrice;
    // eth_estimateGas executes the exact call. After a scoped approval it checks actual swap/vault preconditions.
    const estimated = await client.rpc.estimateGas({
      account: p.account,
      to,
      data,
      value: 0n,
      gasPrice,
    });
    const gas = (estimated * 120n) / 100n + 5000n;
    const spent = await this.actualFees(row, true);
    invariant(
      spent + gas * walletPriceCap <= BigInt(p.maxTotalFee),
      "This transaction would exceed the remaining fee budget",
    );
    const native = await client.rpc.getBalance({ address: p.account });
    invariant(native >= gas * walletPriceCap, "Insufficient native balance for network fees");
    const head = await client.rpc.getBlockNumber();
    const attempt: Attempt = {
      phase,
      to,
      data,
      nonce,
      fromBlock: head.toString(),
      gas: gas.toString(),
      gasPrice: walletPriceCap.toString(),
      state: "requesting",
    };
    row.attempts.push(attempt);
    row.updatedAt = new Date().toISOString();
    store.save(row);
    notify(`Confirm ${phase === "execute" ? p.action : phase} in your wallet`);
    let result: unknown;
    try {
      result = await wallet.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: p.account,
            chainId: toHex(client.registry.chainId),
            to,
            data,
            value: "0x0",
            nonce: toHex(nonce),
            gas: toHex(gas),
            ...(client.registry.mode === "v3-testnet"
              ? { type: "0x2", maxFeePerGas: toHex(walletPriceCap), maxPriorityFeePerGas: "0x0" }
              : { gasPrice: toHex(gasPrice) }),
          },
        ],
      });
    } catch (error) {
      // Only an explicit EIP-1193 rejection establishes that the wallet did not submit.
      attempt.state =
        typeof error === "object" && error !== null && "code" in error && error.code === 4001
          ? "rejected"
          : "uncertain";
      row.updatedAt = new Date().toISOString();
      store.save(row);
      throw error;
    }
    try {
      attempt.hash = hash(result);
      attempt.state = "submitted";
      store.save(row);
    } catch (error) {
      attempt.state = "uncertain";
      store.save(row);
      throw error;
    }
    notify("Waiting for the network receipt. You can recover this request after a refresh.");
    const receipt = await client.rpc.waitForTransactionReceipt({
      hash: attempt.hash,
      timeout: 60000,
      pollingInterval: 1000,
    });
    const tx = await client.rpc.getTransaction({ hash: attempt.hash });
    invariant(
      same(tx.from, p.account) &&
        same(tx.to, to) &&
        same(tx.input, data) &&
        tx.value === 0n &&
        tx.nonce === nonce,
      "Wallet returned a transaction that differs from the approved request; inspect it before continuing",
    );
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    attempt.fee = fee.toString();
    attempt.state = receipt.status === "success" ? "confirmed" : "reverted";
    row.updatedAt = new Date().toISOString();
    store.save(row);
    invariant(
      tx.gas <= gas &&
        receipt.effectiveGasPrice <= BigInt(p.maxGasPrice) &&
        gasPriceLimit(tx) <= BigInt(p.maxGasPrice) &&
        spent + tx.gas * gasPriceLimit(tx) <= BigInt(p.maxTotalFee),
      "Wallet transaction exceeded an approved network fee limit",
    );
    invariant(
      receipt.status === "success",
      "The network reverted this transaction. No action effect was accepted; network fees were charged.",
    );
    return attempt.hash;
  }
  async actualFees(row: RecordEntry, upfrontLimits = false) {
    let fees = 0n;
    for (const a of row.attempts)
      if (a.hash) {
        const receipt = await this.client.rpc.getTransactionReceipt({ hash: a.hash });
        const tx = await this.client.rpc.getTransaction({ hash: a.hash });
        invariant(
          same(tx.from, row.plan.account) &&
            same(tx.to, a.to) &&
            same(tx.input, a.data) &&
            tx.value === 0n &&
            tx.nonce === a.nonce,
          "Journal transaction sender or payload mismatch",
        );
        const block = await this.client.rpc.getBlock({ blockNumber: receipt.blockNumber });
        invariant(same(block.hash, receipt.blockHash), "Transaction receipt is not canonical");
        // Carry the complete earlier gas limits forward. RPC gas fees alone need not
        // describe all native storage reservations on a revive chain.
        fees += upfrontLimits
          ? tx.gas * gasPriceLimit(tx)
          : receipt.gasUsed * receipt.effectiveGasPrice;
      }
    return fees;
  }
  async execute(plan: Plan, notify: (text: string) => void = () => {}) {
    const c = this.client;
    invariant(
      c.registry.mode === "local" || hasReviewedProgram(c.registry),
      "V3 DeFi submission is disabled until a reviewed deployment and liquidity profile are included in the release",
    );
    plan = Object.freeze(parsePlan({ ...plan }, c.registry));
    return this.exclusive(JOURNAL_LOCK, async () => {
      await c.preflight(plan);
      invariant(
        this.store.unresolved(plan.account, c.registry.chainId).length === 0,
        "Recover the earlier pending wallet request first",
      );
      let row = this.store.list().find((r) => r.plan.id === plan.id);
      if (!row) {
        const now = new Date().toISOString();
        row = {
          version: 1,
          registry: c.registry,
          plan,
          attempts: [],
          createdAt: now,
          updatedAt: now,
        };
        this.store.save(row);
      }
      invariant(
        !row.attempts.some(
          (a) => a.phase === "execute" && a.state !== "rejected" && a.state !== "reverted",
        ),
        "An execution attempt already exists. Recover it before continuing.",
      );
      let allowance = await c.allowance(plan);
      if (allowance !== BigInt(plan.amountIn)) {
        if (allowance > 0n)
          await this.send(
            row,
            "reset",
            plan.tokenIn,
            encodeFunctionData({
              abi: tokenAbi,
              functionName: "approve",
              args: [c.registry.guard.address, 0n],
            }),
            notify,
          );
        await this.send(
          row,
          "approve",
          plan.tokenIn,
          encodeFunctionData({
            abi: tokenAbi,
            functionName: "approve",
            args: [c.registry.guard.address, BigInt(plan.amountIn)],
          }),
          notify,
        );
        allowance = await c.allowance(plan);
        invariant(allowance === BigInt(plan.amountIn), "Exact token approval was not established");
      }
      await this.send(row, "execute", c.registry.guard.address, c.data(plan), notify);
      return row;
    });
  }
  async revoke(plan: Plan, notify: (text: string) => void = () => {}) {
    invariant(
      this.client.registry.mode === "local" || hasReviewedProgram(this.client.registry),
      "V3 DeFi submission is disabled in this local development release",
    );
    return this.exclusive(JOURNAL_LOCK, async () => {
      const now = new Date().toISOString();
      const row = this.store.list().find((r) => r.plan.id === plan.id) ?? {
        version: 1,
        registry: this.client.registry,
        plan,
        attempts: [],
        createdAt: now,
        updatedAt: now,
      };
      return this.send(
        row,
        "revoke",
        row.plan.tokenIn,
        encodeFunctionData({
          abi: tokenAbi,
          functionName: "approve",
          args: [this.client.registry.guard.address, 0n],
        }),
        notify,
      );
    });
  }
  async recover(row: RecordEntry) {
    return this.exclusive(JOURNAL_LOCK, () => this.recoverLocked(row));
  }
  private async recoverLocked(row: RecordEntry) {
    row = this.store.list().find((r) => r.plan.id === row.plan.id) ?? row;
    const c = this.client;
    await c.audit();
    for (const a of row.attempts.filter((a) =>
      ["submitted", "requesting", "uncertain"].includes(a.state),
    )) {
      if (!a.hash) {
        const head = await c.rpc.getBlockNumber(),
          start = BigInt(a.fromBlock);
        invariant(
          head - start <= 256n,
          "The no-hash recovery window exceeds 256 blocks. Keep this claim and reconcile the account nonce manually; nothing was resent.",
        );
        for (let n = start; n <= head; n++) {
          const block = await c.rpc.getBlock({ blockNumber: n, includeTransactions: true });
          const tx = block.transactions.find(
            (tx) => same(tx.from, row.plan.account) && tx.nonce === a.nonce,
          );
          if (tx) {
            invariant(
              same(tx.to, a.to) && same(tx.input, a.data) && tx.value === 0n,
              "This nonce was used by another transaction; manual reconciliation is required",
            );
            a.hash = tx.hash;
            break;
          }
        }
        if (!a.hash) continue; // absence in a bounded scan never proves a wallet request was not sent
      }
      const receipt = await c.rpc.getTransactionReceipt({ hash: a.hash });
      const block = await c.rpc.getBlock({ blockNumber: receipt.blockNumber });
      invariant(same(block.hash, receipt.blockHash), "Recovery receipt is not canonical");
      const tx = await c.rpc.getTransaction({ hash: a.hash });
      invariant(
        same(tx.from, row.plan.account) &&
          same(tx.to, a.to) &&
          same(tx.input, a.data) &&
          tx.nonce === a.nonce,
        "Recovered transaction differs from request",
      );
      a.state = receipt.status === "success" ? "confirmed" : "reverted";
      a.fee = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
    }
    row.updatedAt = new Date().toISOString();
    this.store.save(row);
    return row;
  }
}
