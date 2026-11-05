import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseUnits, keccak256, type Address, type Hex } from "viem";
import { bootstrap, startNode } from "../scripts/local-node.mjs";
import {
  DeFiClient,
  DeFiStore,
  Executor,
  digest,
  parsePlan,
  parseRegistry,
  pilotMetrics,
  planId,
  tokenAbi,
  verifyRecord,
  type Registry,
  type Wallet,
  MarketWalletOperations,
  estimateMarketDeployment,
  newDeploymentId,
  deploymentNetwork,
  WalletClaimStore,
  WALLET_CLAIMS_KEY,
  reviewedBindings,
  assertReviewedCode,
  poolAbi,
  marketAbi,
} from "../src/index.js";
import { V3_PROGRAM } from "../src/reviewed-v3.js";
let node: Awaited<ReturnType<typeof startNode>>,
  registry: Registry,
  accounts: Address[],
  client: DeFiClient,
  snapshot: Hex;
let reviewed: Registry;
const exclusive = async <T>(_name: string, fn: () => Promise<T>) => fn();
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
}
async function raw(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(node.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result;
}
const wallet: Wallet = {
  request: ({ method, params }) =>
    method === "eth_accounts" ? Promise.resolve([accounts[1]]) : raw(method, params),
};
async function quote(overrides: Partial<Parameters<DeFiClient["quote"]>[0]> = {}) {
  return client.quote({
    action: "swap",
    account: accounts[1],
    recipient: accounts[2],
    amount: "100",
    slippageBps: 50,
    ttlSeconds: 300,
    maxTotalFee: parseUnits("0.1", 18).toString(),
    ...overrides,
  });
}
beforeAll(async () => {
  node = await startNode(18546);
  const market = await bootstrap(node.url);
  registry = parseRegistry(market.registry);
  accounts = market.accounts;
  client = new DeFiClient(registry);
  expect(market.artifacts.SeamTestMarket.bytecode).toBe(V3_PROGRAM.factoryCreationCode);
  const network = deploymentNetwork(registry),
    id = newDeploymentId();
  const cost = await estimateMarketDeployment(accounts[1], id, network);
  reviewed = await new MarketWalletOperations(memory(), exclusive).deploy(
    wallet,
    accounts[1],
    id,
    cost.maximumCost,
    () => {},
    network,
  );
  snapshot = (await raw("evm_snapshot")) as Hex;
}, 120000);
beforeEach(async () => {
  await raw("evm_revert", [snapshot]);
  snapshot = (await raw("evm_snapshot")) as Hex;
});
afterAll(() => node?.stop());
describe("bundled engineering-reviewed test market", () => {
  it("attests all six deployed programs and constructor bindings, not self-declared hashes", async () => {
    const rpc = new DeFiClient(reviewed).rpc;
    await new DeFiClient(reviewed).audit();
    for (const binding of reviewedBindings(reviewed)) {
      const code = (await rpc.getCode({ address: binding.address }))!;
      assertReviewedCode(binding.name, code, binding.bindings);
      expect(() =>
        assertReviewedCode(binding.name, (code.slice(0, -2) + "fe") as Hex, binding.bindings),
      ).toThrow(/Unreviewed/);
    }
    const bad = structuredClone(reviewed);
    bad.review!.deployer = accounts[2];
    await expect(new DeFiClient(bad).audit()).rejects.toThrow(/immutable/);
    const factory = reviewed.review!.factory.address;
    await raw("anvil_setCode", [factory, "0x60006000f3"]);
    const selfBlessed = structuredClone(reviewed);
    selfBlessed.review!.factory.codeHash = keccak256("0x60006000f3");
    await expect(new DeFiClient(selfBlessed).audit()).rejects.toThrow(/Unreviewed/);
  });
  it("seeds actual test liquidity and only permits one faucet allocation per address", async () => {
    const c = new DeFiClient(reviewed),
      factory = reviewed.review!.factory.address;
    expect(
      await c.rpc.readContract({
        address: reviewed.pool.address,
        abi: poolAbi,
        functionName: "reserve0",
      }),
    ).toBe(1_000_000n * 10n ** 6n);
    expect(
      await c.rpc.readContract({
        address: reviewed.pool.address,
        abi: poolAbi,
        functionName: "reserve1",
      }),
    ).toBe(500n * 10n ** 18n);
    expect(
      await c.rpc.readContract({
        address: factory,
        abi: marketAbi,
        functionName: "claimed",
        args: [accounts[1]],
      }),
    ).toBe(true);
    const other: Wallet = {
      request: ({ method, params }) =>
        method === "eth_accounts" ? Promise.resolve([accounts[2]]) : raw(method, params),
    };
    const ops = new MarketWalletOperations(memory(), exclusive),
      cost = await ops.estimateClaim(accounts[2], reviewed);
    await ops.claim(other, accounts[2], reviewed, cost.maximumCost);
    expect((await c.positions(accounts[2])).balances[0].balance).toBe("10000000000");
    await expect(ops.estimateClaim(accounts[2], reviewed)).rejects.toThrow();
  }, 30000);
  it("simulates approval and action costs before approval, then swaps, deposits and fully redeems", async () => {
    const c = new DeFiClient(reviewed),
      store = new DeFiStore(memory()),
      executor = new Executor(c, wallet, store, exclusive);
    for (const action of ["swap", "deposit", "redeem"] as const) {
      const p = await c.quote({
        action,
        account: accounts[1],
        recipient: accounts[1],
        amount: "100",
        slippageBps: 50,
        ttlSeconds: 300,
        maxTotalFee: parseUnits("0.1", 18).toString(),
      });
      const estimate = await c.previewCost(p);
      expect(estimate.steps.map((row) => row.phase)).toEqual(["Exact token approval", action]);
      expect(BigInt(estimate.maximumCost)).toBeGreaterThan(0n);
      expect(await c.allowance(p)).toBe(0n);
      const row = await executor.execute(p);
      expect((await verifyRecord(row)).status).toBe("local-confirmed");
      expect(await c.allowance(p)).toBe(0n);
    }
    expect((await c.positions(accounts[1])).balances[2].balance).toBe("0");
  }, 30000);
  it("recovers market creation after a lost wallet response without deploying twice", async () => {
    const storage = memory(),
      ops = new MarketWalletOperations(storage, exclusive),
      network = deploymentNetwork(registry),
      id = newDeploymentId();
    let sends = 0;
    const lossy: Wallet = {
      request: async (input) => {
        if (input.method === "eth_sendTransaction") {
          sends++;
          await wallet.request(input);
          throw new Error("Response lost");
        }
        return wallet.request(input);
      },
    };
    const cost = await estimateMarketDeployment(accounts[1], id, network);
    await expect(
      ops.deploy(lossy, accounts[1], id, cost.maximumCost, () => {}, network),
    ).rejects.toThrow("Response lost");
    expect(ops.claims.list()[0].state).toBe("uncertain");
    expect(() => ops.claims.remove(ops.claims.list()[0].id)).toThrow(/Unresolved/);
    expect(() => new DeFiStore(storage).assertNoExternalRequests(accounts[1], 31337)).toThrow(
      /Recover/,
    );
    const restored = await ops.recover(ops.claims.list()[0]);
    expect(restored.state).toBe("confirmed");
    expect(restored.registry?.deploymentId).toBe(id);
    expect(sends).toBe(1);
    new DeFiStore(storage).assertNoExternalRequests(accounts[1], 31337);
    ops.claims.remove(restored.id);
    expect(ops.claims.list()).toHaveLength(0);
  }, 30000);
  it("can reconcile an old no-hash claim using a supplied canonical hash, but rejects unrelated transactions", async () => {
    const ops = new MarketWalletOperations(memory(), exclusive),
      network = deploymentNetwork(registry),
      id = newDeploymentId();
    let sent: Hex | undefined;
    const lossy: Wallet = {
      request: async (input) => {
        if (input.method === "eth_sendTransaction") {
          sent = (await wallet.request(input)) as Hex;
          throw new Error("Lost");
        }
        return wallet.request(input);
      },
    };
    const cost = await estimateMarketDeployment(accounts[1], id, network);
    await expect(
      ops.deploy(lossy, accounts[1], id, cost.maximumCost, () => {}, network),
    ).rejects.toThrow("Lost");
    const claim = ops.claims.list()[0];
    await raw("anvil_mine", ["0x101", "0x1"]);
    await expect(ops.recover(claim)).rejects.toThrow(/256 blocks/);
    await expect(ops.recover(claim, reviewed.review!.deploymentTransaction)).rejects.toThrow(
      /differs/,
    );
    expect(ops.claims.list()[0].hash).toBeUndefined();
    expect(ops.claims.list()[0].state).toBe("uncertain");
    const recovered = await ops.recover(claim, sent!);
    expect(recovered.state).toBe("confirmed");
    expect(recovered.registry?.deploymentId).toBe(id);
  }, 30000);
  it("persists a claim before the wallet and treats only explicit rejection as unsent", async () => {
    const storage = memory(),
      ops = new MarketWalletOperations(storage, exclusive),
      network = deploymentNetwork(registry),
      id = newDeploymentId();
    const cost = await estimateMarketDeployment(accounts[1], id, network);
    const requests = vi.fn(wallet.request);
    await expect(
      ops.deploy({ request: requests }, accounts[1], id, cost.maximumCost, () => {}, network, "1"),
    ).rejects.toThrow(/reviewed budget/);
    expect(requests.mock.calls.some(([request]) => request.method === "eth_sendTransaction")).toBe(
      false,
    );
    expect(ops.claims.list()).toHaveLength(0);
    const rejecting: Wallet = {
      request: async (input) => {
        if (input.method === "eth_sendTransaction") {
          expect(ops.claims.list()[0].state).toBe("requesting");
          throw Object.assign(new Error("Rejected"), { code: 4001 });
        }
        return wallet.request(input);
      },
    };
    await expect(
      ops.deploy(rejecting, accounts[1], id, cost.maximumCost, () => {}, network),
    ).rejects.toThrow("Rejected");
    expect(ops.claims.pending(accounts[1], 31337)).toHaveLength(0);
    const rows = ops.claims.list();
    rows[0].state = "confirmed";
    storage.setItem(WALLET_CLAIMS_KEY, JSON.stringify(rows));
    expect(() => new WalletClaimStore(storage).list()).toThrow(/hash/);
  });
});
describe("executable reference market", () => {
  it("swaps with an exact approval, verifies economic evidence and rejects replay", async () => {
    const p = await quote(),
      store = new DeFiStore(memory()),
      executor = new Executor(client, wallet, store, exclusive);
    const row = await executor.execute(p);
    expect(row.attempts.map((a) => a.phase)).toEqual(["approve", "execute"]);
    expect(await client.allowance(p)).toBe(0n);
    const verification = await verifyRecord(row);
    expect(verification.status).toBe("local-confirmed");
    expect(BigInt(verification.amountOut!)).toBeGreaterThanOrEqual(BigInt(p.minAmountOut));
    await expect(executor.execute(p)).rejects.toThrow(/already executed/);
    await expect(
      client.rpc.call({ account: p.account, to: registry.guard.address, data: client.data(p) }),
    ).rejects.toThrow();
  }, 30000);
  it("deposits assets, tracks shares and redeems back to the owner", async () => {
    const store = new DeFiStore(memory()),
      executor = new Executor(client, wallet, store, exclusive);
    const before = await client.positions(accounts[1]);
    const deposit = await quote({ action: "deposit", recipient: accounts[1], amount: "200" });
    const deposited = await executor.execute(deposit);
    expect((await verifyRecord(deposited)).status).toBe("local-confirmed");
    const positions = await client.positions(accounts[1]);
    expect(BigInt(positions.balances[2].balance)).toBeGreaterThan(0n);
    expect(BigInt(positions.redeemable)).toBe(200_000_000n);
    const redeem = await quote({ action: "redeem", recipient: accounts[1], amount: "200" });
    const redeemed = await executor.execute(redeem);
    expect((await verifyRecord(redeemed)).status).toBe("local-confirmed");
    const after = await client.positions(accounts[1]);
    expect(after.balances[0].balance).toBe(before.balances[0].balance);
    expect(after.balances[2].balance).toBe("0");
  }, 30000);
  it("clears a prior allowance before creating a new exact approval", async () => {
    await raw("eth_sendTransaction", [
      {
        from: accounts[1],
        to: registry.tokens[0].address,
        data: encodeFunctionData({
          abi: tokenAbi,
          functionName: "approve",
          args: [registry.guard.address, 2n ** 256n - 1n],
        }),
      },
    ]);
    const store = new DeFiStore(memory()),
      row = await new Executor(client, wallet, store, exclusive).execute(await quote());
    expect(row.attempts.map((a) => a.phase)).toEqual(["reset", "approve", "execute"]);
  }, 30000);
  it("wallet rejection remains explicitly unsent and a later retry can succeed", async () => {
    const p = await quote(),
      store = new DeFiStore(memory());
    const rejecting: Wallet = {
      request: async (input) => {
        if (input.method === "eth_sendTransaction")
          throw Object.assign(new Error("Rejected"), { code: 4001 });
        return wallet.request(input);
      },
    };
    await expect(new Executor(client, rejecting, store, exclusive).execute(p)).rejects.toThrow(
      "Rejected",
    );
    expect(store.list()[0].attempts[0].state).toBe("rejected");
    expect(store.unresolved(p.account, 31337)).toHaveLength(0);
    expect(
      (await new Executor(client, wallet, store, exclusive).execute(p)).attempts.at(-1)?.state,
    ).toBe("confirmed");
  }, 30000);
  it("recovers a lost wallet response by account and nonce without resubmission", async () => {
    const p = await quote(),
      store = new DeFiStore(memory());
    let sends = 0;
    const lossy: Wallet = {
      request: async (input) => {
        if (input.method === "eth_sendTransaction") {
          sends++;
          await wallet.request(input);
          throw new Error("Response lost");
        }
        return wallet.request(input);
      },
    };
    const executor = new Executor(client, lossy, store, exclusive);
    await expect(executor.execute(p)).rejects.toThrow("Response lost");
    expect(store.unresolved(p.account, 31337)).toHaveLength(1);
    await expect(
      new Executor(client, wallet, store, exclusive).execute(await quote({ amount: "50" })),
    ).rejects.toThrow(/earlier pending/);
    await executor.recover(store.list()[0]);
    expect(sends).toBe(1);
    expect(store.list()[0].attempts[0].state).toBe("confirmed");
    expect(
      (await new Executor(client, wallet, store, exclusive).execute(p)).attempts.at(-1)?.state,
    ).toBe("confirmed");
  }, 30000);
  it("never treats an absent hash in a bounded recovery scan as unsent", async () => {
    const p = await quote(),
      store = new DeFiStore(memory());
    const failed: Wallet = {
      request: async (input) => {
        if (input.method === "eth_sendTransaction") throw new Error("Disconnected");
        return wallet.request(input);
      },
    };
    const executor = new Executor(client, failed, store, exclusive);
    await expect(executor.execute(p)).rejects.toThrow();
    await executor.recover(store.list()[0]);
    expect(store.unresolved(p.account, 31337)).toHaveLength(1);
  }, 30000);
  it("blocks expired quotes, changed accounts and impossible fee budgets before sending", async () => {
    const p = await quote({ ttlSeconds: 60 });
    await raw("evm_increaseTime", [61]);
    await raw("evm_mine");
    const store = new DeFiStore(memory());
    await expect(new Executor(client, wallet, store, exclusive).execute(p)).rejects.toThrow(
      /expired/,
    );
    expect(store.list()).toHaveLength(0);
    const fresh = await quote();
    const wrong: Wallet = {
      request: (input) =>
        input.method === "eth_accounts" ? Promise.resolve([accounts[2]]) : wallet.request(input),
    };
    await expect(new Executor(client, wrong, store, exclusive).execute(fresh)).rejects.toThrow(
      /account changed/,
    );
    await expect(
      new Executor(client, wallet, store, exclusive).execute(await quote({ maxTotalFee: "1" })),
    ).rejects.toThrow(/fee budget/);
    expect(store.list().every((r) => r.attempts.length === 0)).toBe(true);
  }, 30000);
  it("enforces minimum output after adverse movement and permits revoking the unused allowance", async () => {
    const p = await quote(),
      store = new DeFiStore(memory());
    // Another account trades through the guard first, moving the market beyond this plan's minimum.
    const mover = await quote({
      account: accounts[0],
      recipient: accounts[0],
      amount: "900000",
      slippageBps: 500,
    });
    const ownerWallet: Wallet = {
      request: (i) =>
        i.method === "eth_accounts" ? Promise.resolve([accounts[0]]) : raw(i.method, i.params),
    };
    await new Executor(client, ownerWallet, new DeFiStore(memory()), exclusive).execute(mover);
    const executor = new Executor(client, wallet, store, exclusive);
    await expect(executor.execute(p)).rejects.toThrow();
    expect(store.list()[0].attempts.map((a) => a.phase)).toEqual(["approve"]);
    expect(await client.allowance(p)).toBe(BigInt(p.amountIn));
    await executor.revoke(p);
    expect(await client.allowance(p)).toBe(0n);
  }, 30000);
  it("restores atomically, deduplicates and independently rechecks imported evidence", async () => {
    const store = new DeFiStore(memory());
    await new Executor(client, wallet, store, exclusive).execute(await quote());
    const archive = store.export(),
      restored = new DeFiStore(memory());
    expect(restored.restore(archive)).toEqual({ checked: 1, added: 1 });
    expect(restored.restore(archive)).toEqual({ checked: 1, added: 0 });
    expect((await verifyRecord(restored.list()[0])).status).toBe("local-confirmed");
    const before = restored.export();
    expect(() => restored.restore(archive.replace('"version": 1', '"version": 9'))).toThrow();
    expect(restored.export()).toBe(before);
    const forged = restored.list()[0];
    forged.plan.minAmountOut = "1";
    expect((await verifyRecord(forged)).status).toBe("failed");
  }, 30000);
});
describe("strict intent and market boundaries", () => {
  it("never promotes an unreviewed imported V3 profile into trusted economic proof", async () => {
    const original = await quote();
    const unreviewed: Registry = {
      ...registry,
      mode: "v3-testnet",
      chainId: 420420777,
      rpcUrl: "https://test-evm-rpc-v3.portaldot.dev/",
    };
    const { id: _id, ...body } = original;
    const bound = { ...body, registryHash: digest(unreviewed) };
    const now = new Date().toISOString();
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network request"));
    try {
      const result = await verifyRecord({
        version: 1,
        registry: unreviewed,
        plan: { id: planId(bound), ...bound },
        attempts: [],
        createdAt: now,
        updatedAt: now,
      });
      expect(result.status).toBe("pending");
      expect(result.checks.at(-1)?.label).toBe("Reviewed V3 market required");
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
  it("refuses an occupied local port without bootstrapping another node", async () => {
    await expect(startNode(18546)).rejects.toThrow(/already in use/);
    expect(await client.rpc.getChainId()).toBe(31337);
  });
  it("rejects an order from a different deployment even if the client check is bypassed", async () => {
    const p = await quote(),
      encoded = client.data(p);
    const altered = (encoded.slice(0, 10) + "ab".repeat(32) + encoded.slice(74)) as Hex;
    await expect(
      client.rpc.call({ account: p.account, to: registry.guard.address, data: altered }),
    ).rejects.toThrow(/DEPLOYMENT_CHANGED/);
  });
  it("keeps an RPC outage unknown instead of claiming an execution failed", async () => {
    const store = new DeFiStore(memory()),
      row = await new Executor(client, wallet, store, exclusive).execute(await quote());
    const offlineRegistry = { ...row.registry, rpcUrl: "http://127.0.0.1:18547/" };
    const { id: _id, ...body } = row.plan;
    const changed = { ...body, registryHash: digest(offlineRegistry) };
    const proof = await verifyRecord({
      ...row,
      registry: offlineRegistry,
      plan: { id: planId(changed), ...changed },
    });
    expect(proof.status).toBe("pending");
    expect(proof.checks.at(-1)?.status).toBe("unknown");
  }, 30000);
  it("allows removing settled evidence but never removes an uncertain wallet claim", async () => {
    const p = await quote(),
      store = new DeFiStore(memory()),
      executor = new Executor(client, wallet, store, exclusive);
    const row = await executor.execute(p),
      archive = store.export();
    expect(store.remove(p.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    store.restore(archive);
    row.attempts.push({ ...row.attempts[0], hash: undefined, fee: undefined, state: "uncertain" });
    // Optional fields are omitted in portable records.
    delete row.attempts.at(-1)!.hash;
    delete row.attempts.at(-1)!.fee;
    store.save(row);
    expect(() => store.remove(p.id)).toThrow(/cannot be removed/);
    expect(store.list()).toHaveLength(1);
  }, 30000);
  it("recovers an actually reverted execution without treating it as pending or resending", async () => {
    const p = await quote(),
      store = new DeFiStore(memory());
    let sends = 0;
    const delayed: Wallet = {
      request: async (input) => {
        if (input.method === "eth_sendTransaction") {
          sends++;
          const tx = input.params![0] as { to: string };
          if (tx.to.toLowerCase() === registry.guard.address.toLowerCase()) {
            await raw("evm_increaseTime", [301]);
            await raw("evm_mine");
          }
        }
        return wallet.request(input);
      },
    };
    const executor = new Executor(client, delayed, store, exclusive);
    await expect(executor.execute(p)).rejects.toThrow();
    const row = await executor.recover(store.list()[0]);
    expect(row.attempts.at(-1)?.state).toBe("reverted");
    expect((await verifyRecord(row)).status).toBe("reverted");
    expect(sends).toBe(2);
    expect(store.unresolved(p.account, 31337)).toHaveLength(0);
  }, 30000);
  it("rejects unreviewed networks, endpoint credentials and changed code", async () => {
    expect(() => parseRegistry({ ...registry, chainId: 1 })).toThrow();
    expect(() =>
      parseRegistry({ ...registry, rpcUrl: "http://user:pass@localhost:8545" }),
    ).toThrow();
    const bad = {
      ...registry,
      guard: { ...registry.guard, codeHash: ("0x" + "ab".repeat(32)) as Hex },
    };
    await expect(new DeFiClient(bad).audit()).rejects.toThrow(/identity changed/);
  });
  it("rejects edited limits, recipients, token paths, excessive precision and dust", async () => {
    const p = await quote();
    expect(() => parsePlan({ ...p, recipient: accounts[0] }, registry)).toThrow(/integrity/);
    expect(() => parsePlan({ ...p, maxTotalFee: "01" }, registry)).toThrow();
    expect(() => parsePlan({ ...p, extra: true }, registry)).toThrow();
    await expect(quote({ amount: "0.0000001" })).rejects.toThrow(/precision/);
    await expect(quote({ amount: "0" })).rejects.toThrow();
    await expect(quote({ slippageBps: 501 })).rejects.toThrow();
    expect(digest(registry)).toBe(p.registryHash);
  });
  it("keeps on-chain deadline and gas-price bounds when client preflight is bypassed", async () => {
    const p = await quote({ ttlSeconds: 60 });
    await expect(
      client.rpc.call({
        account: p.account,
        to: registry.guard.address,
        data: client.data(p),
        gasPrice: BigInt(p.maxGasPrice) + 1n,
      }),
    ).rejects.toThrow();
    await raw("evm_increaseTime", [61]);
    await raw("evm_mine");
    await expect(
      client.rpc.call({ account: p.account, to: registry.guard.address, data: client.data(p) }),
    ).rejects.toThrow();
  });
  it("rejects a vault quote whose shares changed after an intervening donation", async () => {
    const p = await quote({ action: "deposit", recipient: accounts[1] }),
      store = new DeFiStore(memory());
    const donation = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "transfer",
          inputs: [
            { type: "address", name: "to" },
            { type: "uint256", name: "value" },
          ],
          outputs: [{ type: "bool" }],
          stateMutability: "nonpayable",
        },
      ],
      functionName: "transfer",
      args: [registry.vault.address, 1_000_000_000n],
    });
    await raw("eth_sendTransaction", [
      { from: accounts[0], to: registry.tokens[0].address, data: donation },
    ]);
    await expect(new Executor(client, wallet, store, exclusive).execute(p)).rejects.toThrow();
    const positions = await client.positions(accounts[1]);
    expect(positions.balances[2].balance).toBe("0");
    expect(await client.allowance(p)).toBe(BigInt(p.amountIn));
  }, 30000);
  it("does not accept a wallet fee override as a policy-compliant receipt", async () => {
    const p = await quote(),
      store = new DeFiStore(memory());
    const override: Wallet = {
      request: async (input) => {
        if (input.method !== "eth_sendTransaction") return wallet.request(input);
        const tx = input.params![0] as Record<string, unknown>;
        return raw(input.method, [
          { ...tx, gasPrice: "0x" + (BigInt(p.maxGasPrice) + 1n).toString(16) },
        ]);
      },
    };
    await expect(new Executor(client, override, store, exclusive).execute(p)).rejects.toThrow(
      /fee limit/,
    );
    expect(store.list()[0].attempts).toHaveLength(1);
    expect((await verifyRecord(store.list()[0])).status).toBe("failed");
  }, 30000);
  it("rejects a wallet gas-limit override whose upfront cost exceeds the plan even when actual fees are small", async () => {
    const p = await quote({ maxTotalFee: parseUnits("0.01", 18).toString() }),
      store = new DeFiStore(memory());
    const override: Wallet = {
      request: async (input) =>
        input.method === "eth_sendTransaction"
          ? raw(input.method, [
              { ...(input.params![0] as Record<string, unknown>), gas: "0x1c9c380" },
            ])
          : wallet.request(input),
    };
    await expect(new Executor(client, override, store, exclusive).execute(p)).rejects.toThrow(
      /fee limit/,
    );
    const result = await verifyRecord(store.list()[0]);
    expect(result.status).toBe("failed");
    expect(result.checks.some((check) => check.detail?.includes("upfront gas limits"))).toBe(true);
  }, 30000);
  it("exports counters once per plan and distinguishes local inclusion from adoption", async () => {
    const store = new DeFiStore(memory()),
      row = await new Executor(client, wallet, store, exclusive).execute(await quote());
    const proof = await verifyRecord(row),
      metrics = pilotMetrics([row, row], { [row.plan.id]: proof });
    expect(metrics.networks[0].recordedPlans).toBe(1);
    expect(metrics.networks[0].checkedExecutions.swap).toBe(1);
    expect(metrics.networks[0].network).toBe("local:31337");
    expect(metrics.scope).toContain("not live testnet adoption");
  }, 30000);
  it("fails closed when persistence fails before asking the wallet", async () => {
    let sends = 0;
    const blocked = new DeFiStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("Storage full");
      },
    });
    const counting: Wallet = {
      request: async (i) => {
        if (i.method === "eth_sendTransaction") sends++;
        return wallet.request(i);
      },
    };
    await expect(
      new Executor(client, counting, blocked, exclusive).execute(await quote()),
    ).rejects.toThrow("Storage full");
    expect(sends).toBe(0);
  });
});
