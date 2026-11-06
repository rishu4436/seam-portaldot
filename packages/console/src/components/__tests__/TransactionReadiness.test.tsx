// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RuntimeFacts } from "@seam/compiler/browser";
import type { Plan } from "@seam/policy/browser";
import type {
  AccountReadiness as AccountResult,
  RecipientReadiness as RecipientResult,
} from "@seam/chain/browser";
import { AccountReadiness } from "../AccountReadiness";
import { RecipientReadiness } from "../RecipientReadiness";
import { TransactionReview } from "../TransactionReview";
import { BuilderPolicy } from "../BuilderPolicy";
const facts = {
  fingerprint: {
    specName: "portaldot-v3",
    specVersion: 3002,
    tokenSymbol: "tPOT",
    tokenDecimals: 14,
  },
  fingerprintDigest: "0x01",
} as unknown as RuntimeFacts;
const transport = () => vi.fn();
const asset = {
  assetId: "806707",
  balance: {
    known: true as const,
    value: { exists: true, balance: "9007199254740993123", minBalance: "1", isSufficient: false },
  },
};
const account = (address = "public-account"): AccountResult => ({
  address,
  block: { hash: "0x01", number: 100 },
  native: { known: false, reason: "unavailable" },
  assets: [asset],
  discovery: { complete: true, scanned: 2 },
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("automatically discovers held assets, offers a transfer and merges pagination without duplicates", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      ...account(),
      discovery: { complete: false, scanned: 32, nextCursor: "0x02" },
    })
    .mockResolvedValueOnce(account());
  const choose = vi.fn();
  render(
    <AccountReadiness
      address="public-account"
      facts={facts}
      rpcUrl="https://example.test"
      transportFor={transport}
      read={read}
      onChooseAsset={choose}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Send asset 806707" }));
  expect(choose).toHaveBeenCalledWith("806707");
  expect(read.mock.calls[0][4]).toEqual({ discover: true });
  await screen.findByText(/Discovery complete/);
  expect(screen.getAllByRole("button", { name: "Send asset 806707" })).toHaveLength(1);
  expect(read.mock.calls[1][4]).toMatchObject({ at: "0x01", after: "0x02" });
});
it("bounds automatic discovery and lets the user continue a larger asset list", async () => {
  const read = vi.fn().mockImplementation(async () => ({
    ...account(),
    discovery: {
      complete: read.mock.calls.length > 4,
      scanned: 32,
      ...(read.mock.calls.length > 4 ? {} : { nextCursor: `0x0${read.mock.calls.length}` }),
    },
  }));
  render(
    <AccountReadiness
      address="public-account"
      facts={facts}
      rpcUrl="https://example.test"
      transportFor={transport}
      read={read}
    />,
  );
  const more = await screen.findByRole("button", { name: "Find more assets" });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  await vi.waitFor(() => expect(more.hasAttribute("disabled")).toBe(false));
  fireEvent.click(more);
  await screen.findByText(/Discovery complete/);
  expect(read).toHaveBeenCalledTimes(5);
});
it("discards balance discovery results from an account that was replaced", async () => {
  let resolve!: (value: AccountResult) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ ...account("second"), assets: [] });
  const view = render(
    <AccountReadiness
      address="first"
      facts={facts}
      rpcUrl="https://example.test"
      transportFor={transport}
      read={read}
    />,
  );
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  view.rerender(
    <AccountReadiness
      address="second"
      facts={facts}
      rpcUrl="https://example.test"
      transportFor={transport}
      read={read}
    />,
  );
  await screen.findByText(/No asset balances found/);
  await act(async () => resolve(account("first")));
  expect(screen.queryByText(/Asset 806707/)).toBeNull();
});
it("clears recipient funding results on edits and ignores a stale completion", async () => {
  let finish!: (value: RecipientResult) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    )
    .mockResolvedValue({
      status: "needs_funding",
      message: "Fund the recipient with native tPOT before signing.",
      block: { number: 101, hash: "0x02" },
      nativeShortfall: "1000000000000",
    });
  const props = {
    recipient: "5".repeat(48),
    assetId: "806707",
    amount: "1",
    facts,
    rpcUrl: "https://example.test",
    transportFor: transport,
    read,
  };
  const view = render(<RecipientReadiness {...props} />);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  view.rerender(<RecipientReadiness {...props} recipient={"6".repeat(48)} />);
  await screen.findByText(/Fund the recipient/);
  await act(async () =>
    finish({
      status: "ready",
      message: "Stale recipient ready",
      block: { number: 100, hash: "0x01" },
    }),
  );
  expect(screen.queryByText("Stale recipient ready")).toBeNull();
  expect(screen.getByText(/Native funding shortfall: 0.01 tPOT/)).toBeTruthy();
});
const plan = {
  signer: { value: "5".repeat(48) },
  mode: "sequential",
  steps: [
    {
      actionId: "pay",
      kind: "assets.transfer",
      capability: "Assets.transfer_keep_alive",
      status: "ok",
      decodedArgs: { assetId: "806707", amount: "9007199254740993123", recipient: "6".repeat(48) },
    },
  ],
} as unknown as Plan;
it("reviews exact decoded addresses, precision-safe amounts, fee estimate and a distinct cap", () => {
  render(
    <TransactionReview
      plan={plan}
      facts={facts}
      feeEstimate="1000000000000"
      feeCap="1250000000000"
    />,
  );
  expect(screen.getByText("6".repeat(48))).toBeTruthy();
  expect(screen.getByText("9,007,199,254,740,993,123 asset base units")).toBeTruthy();
  expect(screen.getByText("0.01 tPOT (1000000000000 base units)")).toBeTruthy();
  expect(screen.getByText("0.0125 tPOT (1250000000000 base units)")).toBeTruthy();
  expect(screen.getByText(/sender keeps the asset account alive/)).toBeTruthy();
});
it("keeps an unavailable fee distinct from zero and carries the real preflight fee into approval review", async () => {
  const view = render(<TransactionReview plan={plan} />);
  expect(screen.getAllByText(/Unavailable — run the live policy check again/)).toHaveLength(2);
  view.unmount();
  const use = vi.fn();
  render(
    <BuilderPolicy
      plan={plan}
      manifest={{}}
      onUse={use}
      readPreflight={async () => ({ totalFee: { value: "100" } })}
    />,
  );
  fireEvent.click(screen.getByText("Read fee from preflight"));
  fireEvent.click(await screen.findByText("Send to approval and signing"));
  expect(use.mock.calls[0][0]).toMatchObject({ feeEstimate: "100", policy: { maxFee: "125" } });
});
