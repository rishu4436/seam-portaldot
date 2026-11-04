import {
  createPublicClient,
  http,
  encodeFunctionData,
  keccak256,
  parseUnits,
  type PublicClient,
  type Address,
  type Hex,
} from "viem";
import { guardAbi, poolAbi, tokenAbi, vaultAbi } from "./abi.js";
import {
  address,
  digest,
  invariant,
  parsePlan,
  parseRegistry,
  planId,
  uint,
  type Action,
  type Plan,
  type Registry,
} from "./model.js";
export const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
export type Wallet = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
export class DeFiClient {
  readonly registry: Registry;
  readonly rpc: PublicClient;
  constructor(registry: Registry) {
    this.registry = parseRegistry(registry);
    this.rpc = createPublicClient({
      cacheTime: 0,
      transport: http(this.registry.rpcUrl, { timeout: 12000, retryCount: 1 }),
    });
  }
  async audit() {
    const r = this.registry;
    const [chain, genesis] = await Promise.all([
      this.rpc.getChainId(),
      this.rpc.getBlock({ blockNumber: 0n }),
    ]);
    invariant(
      chain === r.chainId && same(genesis.hash, r.genesisHash),
      "RPC network identity mismatch",
    );
    const head = await this.rpc.getBlock();
    invariant(head.hash, "Missing head hash");
    for (const pin of [r.guard, r.pool, ...r.tokens, r.vault]) {
      const code = await this.rpc.getCode({ address: pin.address, blockNumber: head.number });
      invariant(
        code && code !== "0x" && same(keccak256(code), pin.codeHash),
        `Contract identity changed at ${pin.address}`,
      );
    }
    const id = await this.rpc.readContract({
      address: r.guard.address,
      abi: guardAbi,
      functionName: "deploymentId",
      blockNumber: head.number,
    });
    invariant(same(id, r.deploymentId), "Market deployment instance changed");
    for (const t of [...r.tokens, r.vault]) {
      const precision = await this.rpc.readContract({
        address: t.address,
        abi: tokenAbi,
        functionName: "decimals",
        blockNumber: head.number,
      });
      invariant(precision === t.decimals, "Token precision changed");
    }
    invariant(
      same(
        await this.rpc.readContract({
          address: r.vault.address,
          abi: vaultAbi,
          functionName: "asset",
          blockNumber: head.number,
        }),
        r.tokens[0].address,
      ),
      "Vault underlying asset mismatch",
    );
    return head;
  }
  async positions(account: Address) {
    const head = await this.audit(),
      r = this.registry;
    const balances = await Promise.all(
      [...r.tokens, r.vault].map(async (t) => ({
        token: t,
        balance: (
          await this.rpc.readContract({
            address: t.address,
            abi: tokenAbi,
            functionName: "balanceOf",
            args: [account],
            blockNumber: head.number,
          })
        ).toString(),
      })),
    );
    const shares = BigInt(balances[2].balance);
    const [native, redeemable, maxRedeem, totalAssets] = await Promise.all([
      this.rpc.getBalance({ address: account, blockNumber: head.number }),
      this.rpc.readContract({
        address: r.vault.address,
        abi: vaultAbi,
        functionName: "previewRedeem",
        args: [shares],
        blockNumber: head.number,
      }),
      this.rpc.readContract({
        address: r.vault.address,
        abi: vaultAbi,
        functionName: "maxRedeem",
        args: [account],
        blockNumber: head.number,
      }),
      this.rpc.readContract({
        address: r.vault.address,
        abi: vaultAbi,
        functionName: "totalAssets",
        blockNumber: head.number,
      }),
    ]);
    return {
      block: head.number.toString(),
      balances,
      native: native.toString(),
      redeemable: redeemable.toString(),
      maxRedeem: maxRedeem.toString(),
      totalAssets: totalAssets.toString(),
    };
  }
  async quote(input: {
    action: Action;
    account: string;
    recipient: string;
    amount: string;
    reverse?: boolean;
    slippageBps: number;
    ttlSeconds: number;
    maxTotalFee: string;
  }) {
    const r = this.registry,
      head = await this.audit();
    invariant(
      Number.isInteger(input.ttlSeconds) && input.ttlSeconds >= 60 && input.ttlSeconds <= 600,
      "Quote lifetime must be 60–600 seconds",
    );
    const account = address(input.account),
      recipient = address(input.recipient);
    const tokenIn =
      input.action === "swap"
        ? r.tokens[input.reverse ? 1 : 0]
        : input.action === "deposit"
          ? r.tokens[0]
          : r.vault;
    const tokenOut =
      input.action === "swap"
        ? r.tokens[input.reverse ? 0 : 1]
        : input.action === "deposit"
          ? r.vault
          : r.tokens[0];
    invariant(
      /^(0|[1-9]\d*)(\.\d+)?$/.test(input.amount) &&
        input.amount.length < 100 &&
        (input.amount.split(".")[1]?.length ?? 0) <= tokenIn.decimals,
      "Enter an exact positive amount within the token's precision",
    );
    const amount = parseUnits(input.amount, tokenIn.decimals);
    uint(amount.toString());
    const balance = await this.rpc.readContract({
      address: tokenIn.address,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [account],
      blockNumber: head.number,
    });
    invariant(balance >= amount, "Insufficient token balance");
    let quoted: bigint;
    if (input.action === "swap") {
      const amounts = await this.rpc.readContract({
        address: r.pool.address,
        abi: poolAbi,
        functionName: "getAmountsOut",
        args: [amount, [tokenIn.address, tokenOut.address]],
        blockNumber: head.number,
      });
      invariant(amounts.length === 2 && amounts[0] === amount, "Malformed venue quote");
      quoted = amounts[1];
    } else {
      const limit = await this.rpc.readContract({
        address: r.vault.address,
        abi: vaultAbi,
        functionName: input.action === "deposit" ? "maxDeposit" : "maxRedeem",
        args: [account],
        blockNumber: head.number,
      });
      invariant(amount <= limit, "Vault deposit or redemption limit exceeded");
      quoted = await this.rpc.readContract({
        address: r.vault.address,
        abi: vaultAbi,
        functionName: input.action === "deposit" ? "previewDeposit" : "previewRedeem",
        args: [amount],
        blockNumber: head.number,
      });
    }
    invariant(
      Number.isInteger(input.slippageBps) && input.slippageBps >= 1 && input.slippageBps <= 500,
      "Slippage must be between 0.01% and 5%",
    );
    const gasPrice = await this.rpc.getGasPrice();
    const entropy = new Uint8Array(32);
    globalThis.crypto.getRandomValues(entropy);
    const body: Omit<Plan, "id"> = {
      version: 1,
      registryHash: digest(r),
      action: input.action,
      account,
      recipient,
      target: input.action === "swap" ? r.pool.address : r.vault.address,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: amount.toString(),
      quotedOut: quoted.toString(),
      minAmountOut: ((quoted * BigInt(10000 - input.slippageBps)) / 10000n).toString(),
      slippageBps: input.slippageBps,
      quoteBlock: head.number.toString(),
      quoteBlockHash: head.hash!,
      deadline: Number(head.timestamp) + input.ttlSeconds,
      maxGasPrice: (gasPrice * 2n + 1n).toString(),
      maxTotalFee: input.maxTotalFee,
      salt: ("0x" + Array.from(entropy, (b) => b.toString(16).padStart(2, "0")).join("")) as Hex,
    };
    const plan = parsePlan({ id: planId(body), ...body }, r);
    invariant(
      plan.deadline > Math.floor(Date.now() / 1000),
      "RPC head is stale; quote already expired",
    );
    return plan;
  }
  data(plan: Plan): Hex {
    parsePlan(plan, this.registry);
    return encodeFunctionData({
      abi: guardAbi,
      functionName: plan.action,
      args: [
        {
          deploymentId: this.registry.deploymentId,
          planId: plan.id,
          target: plan.target,
          tokenIn: plan.tokenIn,
          tokenOut: plan.tokenOut,
          amountIn: BigInt(plan.amountIn),
          minAmountOut: BigInt(plan.minAmountOut),
          recipient: plan.recipient,
          deadline: BigInt(plan.deadline),
          maxGasPrice: BigInt(plan.maxGasPrice),
        },
      ],
    });
  }
  async preflight(plan: Plan) {
    parsePlan(plan, this.registry);
    const head = await this.audit();
    invariant(
      Number(head.timestamp) < plan.deadline && Math.floor(Date.now() / 1000) < plan.deadline,
      "Quote expired. Read a new quote before continuing.",
    );
    const quoteBlock = await this.rpc.getBlock({ blockNumber: BigInt(plan.quoteBlock) });
    invariant(same(quoteBlock.hash, plan.quoteBlockHash), "Quoted block was reorganized");
    invariant(
      plan.deadline >= Number(quoteBlock.timestamp) + 60 &&
        plan.deadline <= Number(quoteBlock.timestamp) + 600,
      "Quote lifetime is outside the allowed range",
    );
    const consumed = await this.rpc.readContract({
      address: this.registry.guard.address,
      abi: guardAbi,
      functionName: "consumed",
      args: [plan.account, plan.id],
    });
    invariant(!consumed, "This plan has already executed");
    return head;
  }
  async allowance(plan: Plan) {
    return this.rpc.readContract({
      address: plan.tokenIn,
      abi: tokenAbi,
      functionName: "allowance",
      args: [plan.account, this.registry.guard.address],
    });
  }
  async walletIdentity(wallet: Wallet, account: Address) {
    const [chain, accounts] = await Promise.all([
      wallet.request({ method: "eth_chainId" }),
      wallet.request({ method: "eth_accounts" }),
    ]);
    invariant(
      typeof chain === "string" && BigInt(chain) === BigInt(this.registry.chainId),
      "Wallet is on a different network",
    );
    invariant(
      Array.isArray(accounts) && accounts.length > 0 && same(String(accounts[0]), account),
      "Selected wallet account changed. Reconnect and quote again.",
    );
  }
}
