// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DeFiClient,
  DeFiStore,
  STORE_KEY,
  digest,
  planId,
  type Plan,
  type Registry,
} from "@seam/defi";
import type { Address, Hex } from "viem";
import DeFiWorkspace from "../ContractDeFiWorkspace";
const addr = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as Address;
const pin = (n: number) => ({ address: addr(n), codeHash: ("0x" + "ab".repeat(32)) as Hex });
const registry: Registry = {
  version: 1,
  mode: "local",
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545/",
  genesisHash: pin(1).codeHash,
  deploymentId: pin(1).codeHash,
  guard: pin(1),
  pool: pin(2),
  tokens: [
    { ...pin(3), symbol: "lUSD", decimals: 6 },
    { ...pin(4), symbol: "lETH", decimals: 18 },
  ],
  vault: { ...pin(5), symbol: "svUSD", decimals: 6 },
  createdAt: "2026-11-04T00:00:00Z",
};
const account = addr(6),
  wallet = vi.fn();
const listeners = new Map<string, Set<() => void>>();
function emitWalletChange() {
  for (const callback of listeners.get("accountsChanged") ?? []) callback();
}
function plan(): Plan {
  const body: Omit<Plan, "id"> = {
    version: 1,
    registryHash: digest(registry),
    action: "swap",
    account,
    recipient: account,
    target: registry.pool.address,
    tokenIn: registry.tokens[0].address,
    tokenOut: registry.tokens[1].address,
    amountIn: "100000000",
    quotedOut: "1000000000000000000",
    minAmountOut: "995000000000000000",
    slippageBps: 50,
    quoteBlock: "1",
    quoteBlockHash: pin(1).codeHash,
    deadline: Math.floor(Date.now() / 1000) + 300,
    maxGasPrice: "1000000000",
    maxTotalFee: "10000000000000000",
    salt: pin(1).codeHash,
  };
  return { id: planId(body), ...body };
}
beforeEach(() => {
  localStorage.clear();
  wallet.mockReset();
  listeners.clear();
  wallet.mockImplementation(async ({ method }: { method: string }) =>
    method === "eth_chainId" ? "0x7a69" : [account],
  );
  Object.defineProperty(window, "ethereum", {
    configurable: true,
    value: {
      request: wallet,
      on: vi.fn((event: string, callback: () => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(callback);
      }),
      removeListener: vi.fn((event: string, callback: () => void) =>
        listeners.get(event)?.delete(callback),
      ),
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => registry }));
  vi.spyOn(DeFiClient.prototype, "audit").mockResolvedValue(
    {} as Awaited<ReturnType<DeFiClient["audit"]>>,
  );
  vi.spyOn(DeFiClient.prototype, "positions").mockResolvedValue({
    block: "1",
    balances: [...registry.tokens, registry.vault].map((token) => ({ token, balance: "0" })),
    native: "1000000000000000000",
    redeemable: "0",
    maxRedeem: "0",
    totalAssets: "0",
  });
  vi.spyOn(DeFiClient.prototype, "quote").mockImplementation(async () => plan());
  vi.spyOn(DeFiClient.prototype, "allowance").mockResolvedValue(0n);
  vi.spyOn(DeFiClient.prototype, "previewCost").mockResolvedValue({
    steps: [
      { phase: "Exact token approval", gas: "20000", maximumCost: "100000" },
      { phase: "swap", gas: "40000", maximumCost: "200000" },
    ],
    maximumCost: "300000",
    balance: "1000000000000000000",
    fundingShortfall: "0",
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete (window as Window & { ethereum?: unknown }).ethereum;
});
async function connectAndQuote() {
  render(<DeFiWorkspace onBusyChange={() => {}} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Connect EVM wallet" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect EVM wallet" }));
  fireEvent.click(await screen.findByRole("button", { name: "Read protected quote" }));
  await screen.findByRole("heading", { name: "What you are approving" });
}
it("keeps an unconfigured market disconnected and does not ask the wallet for permissions", async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
  render(<DeFiWorkspace onBusyChange={() => {}} />);
  expect(screen.getByText("V3 TESTNET · SETUP REQUIRED")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connect EVM wallet" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(wallet).not.toHaveBeenCalled();
});
it("shows swap, deposit and withdrawal before setup while keeping unfunded trading locked", async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
  render(<DeFiWorkspace onBusyChange={() => {}} />);
  expect(screen.getByRole("heading", { name: "Swap assets" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Swap" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("Market setup & recovery").closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  expect(screen.getByRole("heading", { name: "Deposit into the vault" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
  expect(screen.getByRole("heading", { name: "Withdraw your assets" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connect EVM wallet" }).hasAttribute("disabled")).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Set up or open market" }));
  expect(screen.getByRole("button", { name: "Connect test wallet for setup" })).toBeTruthy();
  expect(wallet).not.toHaveBeenCalled();
});
it("quotes without a signature and invalidates review when any spending field changes", async () => {
  await connectAndQuote();
  expect(wallet.mock.calls.every(([arg]) => arg.method !== "eth_sendTransaction")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  expect(
    screen.getByRole("button", { name: "Approve exact amount & execute" }).hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.change(screen.getByLabelText("Amount to spend"), { target: { value: "101" } });
  expect(screen.queryByRole("heading", { name: "What you are approving" })).toBeNull();
});
it("requires a fresh quote after raising a budget below the simulated wallet cost", async () => {
  vi.mocked(DeFiClient.prototype.previewCost).mockResolvedValue({
    steps: [{ phase: "swap", gas: "1", maximumCost: "20000000000000000" }],
    maximumCost: "20000000000000000",
    balance: "1000000000000000000",
    fundingShortfall: "0",
  });
  await connectAndQuote();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  expect(
    screen.getByRole("button", { name: "Approve exact amount & execute" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Use estimate + 10% budget & clear review" }));
  expect(screen.queryByRole("heading", { name: "What you are approving" })).toBeNull();
  expect(wallet.mock.calls.every(([arg]) => arg.method !== "eth_sendTransaction")).toBe(true);
});
it("adds or switches only the pinned V3 test network without requesting a transaction", async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
  wallet.mockImplementation(async ({ method }: { method: string }) =>
    method === "eth_chainId"
      ? "0x190f1ca9"
      : method === "eth_requestAccounts" || method === "eth_accounts"
        ? [account]
        : null,
  );
  render(<DeFiWorkspace onBusyChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Set up or open market" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect test wallet for setup" }));
  await screen.findByText("Setup account");
  expect(
    wallet.mock.calls.find(([arg]) => arg.method === "wallet_switchEthereumChain")?.[0].params,
  ).toEqual([{ chainId: "0x190f1ca9" }]);
  expect(wallet.mock.calls.every(([arg]) => arg.method !== "eth_sendTransaction")).toBe(true);
  expect(screen.queryByRole("button", { name: "Create test market in wallet" })).toBeNull();
});
it("clears the quote and connection when the wallet announces an account change", async () => {
  await connectAndQuote();
  const { act } = await import("@testing-library/react");
  act(emitWalletChange);
  expect(screen.queryByRole("heading", { name: "What you are approving" })).toBeNull();
  expect(screen.getByText(/Wallet account or network changed/)).toBeTruthy();
});
it("discards a slow balance response after the wallet account changes", async () => {
  await connectAndQuote();
  let resolve!: (value: Awaited<ReturnType<DeFiClient["positions"]>>) => void;
  vi.mocked(DeFiClient.prototype.positions).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  const { act } = await import("@testing-library/react");
  act(emitWalletChange);
  await act(async () =>
    resolve({
      block: "2",
      balances: [...registry.tokens, registry.vault].map((token) => ({
        token,
        balance: "777000000",
      })),
      native: "1",
      redeemable: "0",
      maxRedeem: "0",
      totalAssets: "0",
    }),
  );
  expect(screen.getByRole("button", { name: "Connect EVM wallet" })).toBeTruthy();
  expect(screen.queryAllByText("777")).toHaveLength(0);
  expect(
    screen.getByText("Connect an account to read token balances and available vault exits."),
  ).toBeTruthy();
});
it("restores an archive with confirmation and deduplicates without sending anything", async () => {
  const store = new DeFiStore(localStorage),
    now = new Date().toISOString();
  store.save({ version: 1, registry, plan: plan(), attempts: [], createdAt: now, updatedAt: now });
  const archive = store.export();
  localStorage.clear();
  const { container } = render(<DeFiWorkspace onBusyChange={() => {}} />);
  const input = container.querySelectorAll('input[type="file"]')[1];
  const file = { size: archive.length, text: async () => archive };
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText(/Archive restored: 1 plans checked; 1 added/);
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText(/Archive restored: 1 plans checked; 0 added/);
  expect(new DeFiStore(localStorage).list()).toHaveLength(1);
  expect(wallet).not.toHaveBeenCalled();
});
it("rejects a corrupt archive without changing existing evidence", async () => {
  const store = new DeFiStore(localStorage),
    now = new Date().toISOString();
  store.save({ version: 1, registry, plan: plan(), attempts: [], createdAt: now, updatedAt: now });
  const previous = localStorage.getItem(STORE_KEY);
  const { container } = render(<DeFiWorkspace onBusyChange={() => {}} />);
  const input = container.querySelectorAll('input[type="file"]')[1];
  fireEvent.change(input, { target: { files: [{ size: 2, text: async () => "{}" }] } });
  await screen.findByRole("alert");
  expect(localStorage.getItem(STORE_KEY)).toBe(previous);
  expect(wallet).not.toHaveBeenCalled();
});
