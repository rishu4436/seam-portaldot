import {
  createPublicClient,
  http,
  encodeFunctionData,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { marketAbi, guardAbi } from "./abi.js";
import { address, digest, hash, invariant, parseRegistry, type Registry } from "./model.js";
import { DeFiClient, same, gasPriceLimit, type Wallet } from "./client.js";
import { DeFiStore, type StorageLike } from "./store.js";
import { browserExclusive, JOURNAL_LOCK, type Exclusive } from "./execution.js";
import { WalletClaimStore, type WalletClaim } from "./wallet-claims.js";
import { factoryCreationData, REVIEW_ID, V3_EVM_GENESIS, V3_RPC } from "./review.js";
export type DeploymentNetwork = { chainId: 31337 | 420420777; rpcUrl: string; genesisHash: Hex };
export const V3_NETWORK: DeploymentNetwork = {
  chainId: 420420777,
  rpcUrl: V3_RPC,
  genesisHash: V3_EVM_GENESIS,
};
export type WalletCost = {
  gas: string;
  baseGasPrice: string;
  gasPrice: string;
  maximumCost: string;
  balance: string;
  fundingShortfall: string;
};
function reader(network: DeploymentNetwork): PublicClient {
  invariant(
    network.chainId === 420420777
      ? network.rpcUrl === V3_RPC
      : network.chainId === 31337 &&
          /^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(network.rpcUrl),
    "Deployment is restricted to the official V3 endpoint or loopback development",
  );
  return createPublicClient({
    cacheTime: 0,
    transport: http(network.rpcUrl, { timeout: 20000, retryCount: 1 }),
  });
}
export function deploymentNetwork(registry: Registry): DeploymentNetwork {
  invariant(
    registry.chainId === 31337 || registry.chainId === 420420777,
    "Unsupported deployment chain",
  );
  return { chainId: registry.chainId, rpcUrl: registry.rpcUrl, genesisHash: registry.genesisHash };
}
export async function assertDeploymentNetwork(network: DeploymentNetwork): Promise<PublicClient> {
  invariant(
    network.chainId !== 420420777 || same(network.genesisHash, V3_EVM_GENESIS),
    "Unrecognized V3 genesis",
  );
  const rpc = reader(network),
    [chain, genesis] = await Promise.all([rpc.getChainId(), rpc.getBlock({ blockNumber: 0n })]);
  invariant(
    chain === network.chainId && same(genesis.hash, network.genesisHash),
    "Deployment network identity mismatch",
  );
  return rpc;
}
export async function assertWalletNetwork(
  wallet: Wallet,
  network: DeploymentNetwork,
  account: Address,
) {
  const [chain, accounts] = await Promise.all([
    wallet.request({ method: "eth_chainId" }),
    wallet.request({ method: "eth_accounts" }),
  ]);
  invariant(
    typeof chain === "string" && BigInt(chain) === BigInt(network.chainId),
    "Wallet network differs from the reviewed test network",
  );
  invariant(
    Array.isArray(accounts) && same(String(accounts[0]), account),
    "Wallet account changed. Connect and review again.",
  );
}
export function newDeploymentId(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
export async function estimateMarketDeployment(
  account: Address,
  deploymentId: Hex,
  network: DeploymentNetwork = V3_NETWORK,
): Promise<WalletCost> {
  return estimateOperation(network, account, null, factoryCreationData(deploymentId), true);
}
async function estimateOperation(
  network: DeploymentNetwork,
  account: Address,
  to: Address | null,
  data: Hex,
  allowTemporaryFunding = false,
): Promise<WalletCost> {
  const rpc = await assertDeploymentNetwork(network),
    [price, balance] = await Promise.all([rpc.getGasPrice(), rpc.getBalance({ address: account })]);
  // A temporary balance is used only to learn the gas requirement of an unfunded fresh account.
  // The real balance remains the funding gate before any wallet request.
  const estimated = await rpc.estimateGas({
    account,
    ...(to ? { to } : {}),
    data,
    value: 0n,
    gasPrice: price,
    ...(allowTemporaryFunding
      ? { stateOverride: [{ address: account, balance: 10n ** 30n }] }
      : {}),
  });
  const gas = (estimated * 120n) / 100n + 5000n,
    priceCap = network.chainId === 420420777 ? (price * 110n + 99n) / 100n : price,
    maximumCost = gas * priceCap;
  return {
    gas: gas.toString(),
    baseGasPrice: price.toString(),
    gasPrice: priceCap.toString(),
    maximumCost: maximumCost.toString(),
    balance: balance.toString(),
    fundingShortfall: (maximumCost > balance ? maximumCost - balance : 0n).toString(),
  };
}
export async function profileFromDeployment(
  transaction: Hex,
  network: DeploymentNetwork = V3_NETWORK,
): Promise<Registry> {
  const rpc = await assertDeploymentNetwork(network),
    [tx, receipt] = await Promise.all([
      rpc.getTransaction({ hash: transaction }),
      rpc.getTransactionReceipt({ hash: transaction }),
    ]);
  invariant(
    receipt.status === "success" && receipt.contractAddress && tx.to === null && tx.value === 0n,
    "This transaction did not create a test market",
  );
  const deploymentId = hash("0x" + tx.input.slice(-64));
  invariant(
    same(tx.input, factoryCreationData(deploymentId)),
    "Creation transaction does not match the bundled reviewed program",
  );
  const factory = getAddress(receipt.contractAddress);
  const read = (functionName: "usd" | "eth" | "pool" | "vault" | "guard") =>
    rpc.readContract({ address: factory, abi: marketAbi, functionName });
  const [usd, eth, pool, vault, guard] = await Promise.all([
    read("usd"),
    read("eth"),
    read("pool"),
    read("vault"),
    read("guard"),
  ]);
  const pin = async (address: Address) => {
    const code = await rpc.getCode({ address });
    invariant(code && code !== "0x", "Created contract is not readable");
    return { address, codeHash: keccak256(code) };
  };
  const registry = parseRegistry({
    version: 1,
    mode: network.chainId === 31337 ? "local" : "v3-testnet",
    chainId: network.chainId,
    rpcUrl: network.rpcUrl,
    genesisHash: network.genesisHash,
    deploymentId,
    guard: await pin(guard),
    pool: await pin(pool),
    tokens: [
      { ...(await pin(usd)), symbol: "sUSD", decimals: 6 },
      { ...(await pin(eth)), symbol: "sETH", decimals: 18 },
    ],
    vault: { ...(await pin(vault)), symbol: "svUSD", decimals: 6 },
    createdAt: new Date().toISOString(),
    review: {
      id: REVIEW_ID,
      factory: await pin(factory),
      deployer: tx.from,
      deploymentTransaction: transaction,
    },
  });
  invariant(
    same(
      await rpc.readContract({ address: guard, abi: guardAbi, functionName: "deploymentId" }),
      deploymentId,
    ),
    "Guard deployment ID differs from creation input",
  );
  await new DeFiClient(registry).audit();
  return registry;
}
async function waitForMarketFinality(transaction: Hex, network: DeploymentNetwork) {
  if (network.chainId !== 420420777) return;
  const rpc = await assertDeploymentNetwork(network);
  const receipt = await rpc.getTransactionReceipt({ hash: transaction });
  const deadline = Date.now() + 45000;
  for (;;) {
    const finalized = await rpc.getBlock({ blockTag: "finalized" });
    if (finalized.number >= receipt.blockNumber) return;
    invariant(
      Date.now() < deadline,
      "Creation is confirmed but finality is still pending. Use Recover without resending after the next finalized blocks.",
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
export class MarketWalletOperations {
  readonly claims: WalletClaimStore;
  constructor(
    readonly storage: StorageLike,
    readonly exclusive: Exclusive = browserExclusive,
  ) {
    this.claims = new WalletClaimStore(storage);
  }
  async deploy(
    wallet: Wallet,
    account: Address,
    deploymentId: Hex,
    maxCost: string,
    notify: (text: string) => void = () => {},
    network: DeploymentNetwork = V3_NETWORK,
    reviewedGasPrice?: string,
  ) {
    return this.exclusive(JOURNAL_LOCK, async () => {
      const claim = await this.send(
        wallet,
        network,
        account,
        "deploy-market",
        null,
        factoryCreationData(deploymentId),
        deploymentId,
        maxCost,
        notify,
        reviewedGasPrice,
      );
      invariant(claim.hash, "Deployment has no transaction hash");
      notify("Checking deployed source, constructor input, code identities and finality…");
      await waitForMarketFinality(claim.hash, network);
      const registry = await profileFromDeployment(claim.hash, network);
      claim.registry = registry;
      this.claims.save(claim);
      return registry;
    });
  }
  async claim(
    wallet: Wallet,
    account: Address,
    registry: Registry,
    maxCost: string,
    notify: (text: string) => void = () => {},
    reviewedGasPrice?: string,
  ) {
    invariant(registry.review, "A reviewed test market is required");
    return this.exclusive(JOURNAL_LOCK, async () => {
      await new DeFiClient(registry).audit();
      return this.send(
        wallet,
        deploymentNetwork(registry),
        account,
        "claim-test-assets",
        registry.review!.factory.address,
        encodeFunctionData({ abi: marketAbi, functionName: "claimTestAssets" }),
        registry.deploymentId,
        maxCost,
        notify,
        reviewedGasPrice,
      );
    });
  }
  async estimateClaim(account: Address, registry: Registry) {
    invariant(registry.review, "A reviewed test market is required");
    await new DeFiClient(registry).audit();
    return estimateOperation(
      deploymentNetwork(registry),
      account,
      registry.review.factory.address,
      encodeFunctionData({ abi: marketAbi, functionName: "claimTestAssets" }),
    );
  }
  private async send(
    wallet: Wallet,
    network: DeploymentNetwork,
    account: Address,
    kind: WalletClaim["kind"],
    to: Address | null,
    data: Hex,
    deploymentId: Hex,
    maxCost: string,
    notify: (text: string) => void,
    reviewedGasPrice?: string,
  ) {
    address(account);
    const rpc = await assertDeploymentNetwork(network);
    await assertWalletNetwork(wallet, network, account);
    invariant(
      this.claims.pending(account, network.chainId).length === 0 &&
        new DeFiStore(this.storage).unresolved(account, network.chainId).length === 0,
      "Recover the earlier wallet request first. Nothing was sent.",
    );
    const cost = await estimateOperation(network, account, to, data);
    const budget = BigInt(maxCost),
      gas = BigInt(cost.gas),
      suggested = BigInt(cost.gasPrice);
    let priceCap = budget / gas < suggested ? budget / gas : suggested;
    if (reviewedGasPrice !== undefined && BigInt(reviewedGasPrice) < priceCap)
      priceCap = BigInt(reviewedGasPrice);
    invariant(
      priceCap >= BigInt(cost.baseGasPrice),
      "The current maximum wallet cost exceeds the reviewed budget. Refresh the estimate.",
    );
    cost.gasPrice = priceCap.toString();
    cost.maximumCost = (gas * priceCap).toString();
    invariant(
      BigInt(cost.balance) >= gas * priceCap,
      "The connected EVM account needs more native test gas before deployment",
    );
    const nonce = await rpc.getTransactionCount({ address: account, blockTag: "pending" }),
      block = await rpc.getBlockNumber();
    await assertWalletNetwork(wallet, network, account);
    const claim: WalletClaim = {
      version: 1,
      id: digest({
        kind,
        account,
        nonce,
        data,
        at: new Date().toISOString(),
        salt: newDeploymentId(),
      }),
      kind,
      ...network,
      account,
      to,
      data,
      deploymentId,
      reviewId: REVIEW_ID,
      nonce,
      fromBlock: block.toString(),
      gas: cost.gas,
      gasPrice: cost.gasPrice,
      maxCost,
      state: "requesting",
      createdAt: new Date().toISOString(),
    };
    this.claims.save(claim);
    notify(
      "Review this testnet-only transaction in your wallet. No native tokens are deposited in the market.",
    );
    try {
      const result = await wallet.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: account,
            chainId: toHex(network.chainId),
            ...(to ? { to } : {}),
            data,
            value: "0x0",
            nonce: toHex(nonce),
            gas: toHex(BigInt(cost.gas)),
            ...(network.chainId === 420420777
              ? {
                  type: "0x2",
                  maxFeePerGas: toHex(BigInt(cost.gasPrice)),
                  maxPriorityFeePerGas: "0x0",
                }
              : { gasPrice: toHex(BigInt(cost.gasPrice)) }),
          },
        ],
      });
      claim.hash = hash(result);
      claim.state = "submitted";
      this.claims.save(claim);
    } catch (error) {
      claim.state =
        typeof error === "object" && error !== null && "code" in error && error.code === 4001
          ? "rejected"
          : "uncertain";
      this.claims.save(claim);
      throw error;
    }
    notify(
      "Waiting for the canonical transaction receipt. A refresh can recover it without resending.",
    );
    await rpc.waitForTransactionReceipt({
      hash: claim.hash!,
      timeout: 60000,
      pollingInterval: 1000,
    });
    const recovered = await this.recoverUnlocked(claim);
    invariant(
      recovered.state === "confirmed",
      "This testnet transaction reverted. No action is being retried.",
    );
    return claim;
  }
  async recover(input: WalletClaim, knownTransaction?: Hex) {
    return this.exclusive(JOURNAL_LOCK, async () => {
      const claim = this.claims.list().find((row) => row.id === input.id);
      invariant(claim, "This wallet request is not in the durable journal");
      if (knownTransaction) {
        const supplied = hash(knownTransaction);
        invariant(
          !claim.hash || same(claim.hash, supplied),
          "A different transaction hash is already recorded",
        );
        // Keep this in memory until canonical receipt, complete payload and fee checks pass.
        // A supplied hash never authorizes another wallet request or clears an uncertain claim by itself.
        claim.hash = supplied;
      }
      await this.recoverUnlocked(claim);
      if (claim.kind === "deploy-market" && claim.state === "confirmed" && claim.hash) {
        await waitForMarketFinality(claim.hash, claim);
        claim.registry = await profileFromDeployment(claim.hash, claim);
        this.claims.save(claim);
      }
      return claim;
    });
  }
  private async recoverUnlocked(claim: WalletClaim) {
    const rpc = await assertDeploymentNetwork(claim);
    if (!claim.hash) {
      if (claim.state === "rejected") return claim;
      const head = await rpc.getBlockNumber(),
        start = BigInt(claim.fromBlock);
      invariant(
        head - start <= 256n,
        "No-hash recovery exceeds 256 blocks; keep this claim and reconcile the nonce manually",
      );
      const deadline = Date.now() + 45000;
      for (let n = start; n <= head; n++) {
        invariant(Date.now() < deadline, "Recovery scan timed out; the request remains uncertain");
        const block = await rpc.getBlock({ blockNumber: n, includeTransactions: true });
        const match = block.transactions.find(
          (tx) => same(tx.from, claim.account) && tx.nonce === claim.nonce,
        );
        if (match) {
          claim.hash = match.hash;
          break;
        }
      }
      if (!claim.hash) return claim;
    }
    const [tx, receipt] = await Promise.all([
        rpc.getTransaction({ hash: claim.hash }),
        rpc.getTransactionReceipt({ hash: claim.hash }),
      ]),
      block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
    invariant(
      same(tx.from, claim.account) &&
        (claim.to ? same(tx.to, claim.to) : tx.to === null) &&
        same(tx.input, claim.data) &&
        tx.value === 0n &&
        tx.nonce === claim.nonce &&
        same(block.hash, receipt.blockHash) &&
        same(tx.blockHash, receipt.blockHash),
      "Wallet transaction differs from the reviewed request; keep it for reconciliation",
    );
    invariant(
      tx.gas <= BigInt(claim.gas) &&
        gasPriceLimit(tx) <= BigInt(claim.gasPrice) &&
        tx.gas * gasPriceLimit(tx) <= BigInt(claim.maxCost) &&
        receipt.effectiveGasPrice <= BigInt(claim.gasPrice) &&
        receipt.gasUsed * receipt.effectiveGasPrice <= BigInt(claim.maxCost),
      "Wallet request exceeded a reviewed fee or gas limit",
    );
    claim.state = receipt.status === "success" ? "confirmed" : "reverted";
    this.claims.save(claim);
    return claim;
  }
}
