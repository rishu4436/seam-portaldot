// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DeFiWorkspace from "../DeFiWorkspace";
import { NativeSwapStore } from "../../lib/native-swap-store";
const mock = vi.hoisted(() => ({
  context: vi.fn(),
  pools: vi.fn(),
  readiness: vi.fn(),
  quote: vi.fn(),
  verify: vi.fn(),
  sign: vi.fn(),
}));
vi.mock("@seam/chain/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@seam/chain/browser")>()),
  readNativeSwapContext: mock.context,
  discoverNativePools: mock.pools,
  readNativePool: async () => (await mock.pools())[0],
  readAccountReadiness: mock.readiness,
  quoteNativeSwap: mock.quote,
  verifyNativeSwap: mock.verify,
  parseNativeSwapPlan: (p: unknown) => p,
}));
vi.mock("../ContractDeFiWorkspace", () => ({
  default: () => <p>Separate contract vault setup</p>,
}));
const who = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const h = `0x${"ab".repeat(32)}` as const;
const quoted = {
  ctx: { block: { number: 100, hash: h } },
  pool: {
    assetId: 8801000,
    symbol: "DUCAT",
    decimals: 10,
    nativeReserve: "2000000000000000",
    assetReserve: "200000000000000",
    minBalance: "1",
    feePpm: 3000,
  },
  plan: {
    version: 1 as const,
    id: h,
    signer: who,
    assetId: 8801000,
    reverse: false,
    assetDecimals: 10,
    poolFeePpm: 3000,
    amountIn: "1000000000000",
    quotedOut: "99650324313",
    minOut: "99152072691",
    slippageBps: 50,
    estimatedFee: "1810737180385",
    feeLimit: "5000000000000",
    nonce: 0,
    block: { number: 100, hash: h },
    layoutHash: h,
    createdAt: Date.now(),
    expiresAt: Date.now() + 120000,
  },
  balances: {
    native: { known: true, value: { free: "10000000000000000" } },
    assets: [{ balance: { known: true, value: { balance: "0" } } }],
  },
};
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mock.context.mockResolvedValue(quoted.ctx);
  mock.pools.mockResolvedValue([quoted.pool]);
  mock.readiness.mockResolvedValue(quoted.balances);
  mock.quote.mockResolvedValue(quoted);
  Object.defineProperty(window, "injectedWeb3", {
    configurable: true,
    value: {
      "polkadot-js": {
        enable: async () => ({
          accounts: { get: async () => [{ address: who, name: "Native test account" }] },
          signer: { signPayload: mock.sign },
        }),
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState({}, "", "/console.html?view=defi");
});
async function connected() {
  render(<DeFiWorkspace onBusyChange={() => {}} />);
  await waitFor(() =>
    expect((screen.getByLabelText("Native pool") as HTMLSelectElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Polkadot wallet" }));
  await screen.findByText(who);
}
it("opens native swaps first, discovers live liquidity and requires no EVM market setup", async () => {
  render(<DeFiWorkspace onBusyChange={() => {}} />);
  expect(screen.getByRole("heading", { name: "Swap with what you have." })).toBeTruthy();
  await waitFor(() => expect(screen.getByText("20 tPOT")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Native swaps" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(mock.sign).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Contract markets & vaults" }));
  expect(screen.getByText("Separate contract vault setup")).toBeTruthy();
});
it("preserves existing contract-market recovery links", () => {
  history.replaceState({}, "", `/console.html?view=defi&marketTx=${h}`);
  render(<DeFiWorkspace onBusyChange={() => {}} />);
  expect(screen.getByText("Separate contract vault setup")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Contract markets & vaults" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(mock.context).not.toHaveBeenCalled();
});
it("connecting and reading a quote never sign; changing the amount discards approval", async () => {
  await connected();
  expect(mock.sign).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Read live quote" }));
  await screen.findByRole("heading", { name: "What you are approving" });
  const execute = screen.getByRole("button", {
    name: "Sign & submit native swap",
  }) as HTMLButtonElement;
  expect(execute.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(execute.disabled).toBe(false);
  expect(screen.getByText("0.01810737180385 tPOT")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Native swap amount"), { target: { value: "0.02" } });
  expect(screen.queryByRole("heading", { name: "What you are approving" })).toBeNull();
  expect(mock.sign).not.toHaveBeenCalled();
});
it("rejects precision loss in input before asking for a quote", async () => {
  await connected();
  fireEvent.change(screen.getByLabelText("Native swap amount"), {
    target: { value: "0.000000000000001" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read live quote" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(mock.quote).not.toHaveBeenCalled();
  expect(mock.sign).not.toHaveBeenCalled();
});
it.each([
  ["Native fee review limit", "0", "Fee review limit must be greater than 0"],
  ["Native fee review limit", "-1", "Fee review limit must be greater than 0"],
  ["Native slippage (%)", "-1", "Slippage must be between 0.01% and 5%"],
])("names the invalid %s field for input %s", async (field, value, expected) => {
  await connected();
  fireEvent.change(screen.getByLabelText(field), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Read live quote" }));
  expect((await screen.findByRole("alert")).textContent).toContain(expected);
  expect(mock.quote).not.toHaveBeenCalled();
  expect(mock.sign).not.toHaveBeenCalled();
});
it("Use available leaves the required minimum when reversing a swap", async () => {
  mock.readiness.mockResolvedValue({
    ...quoted.balances,
    assets: [{ balance: { known: true, value: { balance: "99650324313" } } }],
  });
  await connected();
  await waitFor(() => expect(screen.getByText(/Balance: 100 tPOT/)).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Reverse native swap direction" }));
  fireEvent.click(screen.getByRole("button", { name: "Use available" }));
  expect((screen.getByLabelText("Native swap amount") as HTMLInputElement).value).toBe(
    "9.9650324312",
  );
  expect(screen.getByText("Keep 0.0000000001 DUCAT to preserve the asset account.")).toBeTruthy();
  expect(mock.sign).not.toHaveBeenCalled();
});
it("expired quotes disable signing and explain how to recover", async () => {
  await connected();
  fireEvent.click(screen.getByRole("button", { name: "Read live quote" }));
  await screen.findByRole("heading", { name: "What you are approving" });
  vi.spyOn(Date, "now").mockReturnValue(quoted.plan.expiresAt + 1);
  await waitFor(() => expect(screen.getByText("Expired — read a new quote")).toBeTruthy(), {
    timeout: 2000,
  });
  expect(
    (screen.getByRole("button", { name: "Sign & submit native swap" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(await screen.findByText(/Quote expired\. Read a new quote/)).toBeTruthy();
  expect(screen.queryByText(/^Quote ready\./)).toBeNull();
  expect(mock.sign).not.toHaveBeenCalled();
});
it("warns when the network fee is greater than the trade and preserves input per direction", async () => {
  await connected();
  fireEvent.change(screen.getByLabelText("Native swap amount"), { target: { value: "0.00001" } });
  mock.quote.mockResolvedValueOnce({ ...quoted, plan: { ...quoted.plan, amountIn: "1000000000" } });
  fireEvent.click(screen.getByRole("button", { name: "Read live quote" }));
  expect(await screen.findByText(/High fee relative to trade/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reverse native swap direction" }));
  expect(screen.getByText(/Native fee balance:/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reverse native swap direction" }));
  expect((screen.getByLabelText("Native swap amount") as HTMLInputElement).value).toBe("0.00001");
});
it("a failed RPC read shows an error and a retry without claiming liquidity", async () => {
  mock.context.mockRejectedValueOnce(Error("RPC temporarily unavailable"));
  render(<DeFiWorkspace onBusyChange={() => {}} />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("Refresh pools to read available liquidity.")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Refresh live pools" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
it("saved verified effects agree with the live status banner after refresh", async () => {
  new NativeSwapStore(localStorage).save({
    plan: quoted.plan,
    state: "verified",
    hash: `0x${"ab".repeat(32)}`,
    verification: {
      status: "verified",
      message: "Finalized call and native swap effect match the approved plan.",
      actualOut: quoted.plan.quotedOut,
    },
  });
  render(<DeFiWorkspace onBusyChange={() => {}} />);
  expect(await screen.findByText("Verified native swap")).toBeTruthy();
  expect(screen.getByText("VERIFIED EXECUTION")).toBeTruthy();
  expect(mock.sign).not.toHaveBeenCalled();
});
it("does not label a newer unsigned attempt as verified because an older swap succeeded", async () => {
  const store = new NativeSwapStore(localStorage);
  store.save({
    plan: quoted.plan,
    state: "verified",
    hash: h,
    verification: { status: "verified", message: "Older swap verified." },
  });
  store.save({ plan: { ...quoted.plan, id: `0x${"cd".repeat(32)}` }, state: "not_sent" });
  render(<DeFiWorkspace onBusyChange={() => {}} />);
  expect(await screen.findByText("Not sent")).toBeTruthy();
  expect(screen.queryByText("VERIFIED EXECUTION")).toBeNull();
});
it("a recovery read cannot modify the journal while another tab owns the wallet lock", async () => {
  const store = new NativeSwapStore(localStorage);
  store.save({ plan: quoted.plan, state: "submitted", hash: h });
  mock.verify.mockResolvedValueOnce({ status: "verified", message: "Finalized." });
  const prior = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_n: unknown, _o: unknown, work: (lock: null) => unknown) => work(null),
    },
  });
  try {
    render(<DeFiWorkspace onBusyChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Verify / recover on V3" }));
    expect(
      await screen.findByText(/A wallet operation is already open in another tab/),
    ).toBeTruthy();
    expect(store.list()[0]!.state).toBe("submitted");
  } finally {
    if (prior) Object.defineProperty(navigator, "locks", prior);
    else Reflect.deleteProperty(navigator, "locks");
  }
});
