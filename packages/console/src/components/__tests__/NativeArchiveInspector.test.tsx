// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EvidenceInspector } from "../WorkspaceCenters";
const mocks = vi.hoisted(() => ({
  verify: vi.fn(async () => ({ status: "verified", message: "Finalized swap matched." })),
}));
vi.mock("@seam/chain/browser", async (original) => ({
  ...(await original<typeof import("@seam/chain/browser")>()),
  parseNativeSwapPlan: (p: unknown) => p,
  verifyNativeSwap: mocks.verify,
}));
vi.mock("../../lib/browserChain", () => ({ transportFor: () => async () => null }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("imports native archives without trusting success claims and verifies without a wallet", async () => {
  const onBundle = vi.fn();
  const view = render(<EvidenceInspector onBundle={onBundle} />);
  const hash = `0x${"ab".repeat(32)}`;
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {
    target: {
      files: [
        {
          size: 500,
          text: async () =>
            JSON.stringify({
              kind: "seam-native-swaps",
              archiveVersion: 1,
              rows: [
                {
                  plan: { id: hash, signer: "test account", assetId: 8801000, reverse: false },
                  hash,
                  state: "verified",
                  verification: { status: "verified", message: "An imported claim" },
                },
              ],
            }),
        },
      ],
    },
  });
  await screen.findByRole("heading", { name: "Native swap archive" });
  expect(screen.queryByText(/Verified execution/)).toBeNull();
  expect(screen.queryByText("An imported claim")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Verify native swap on V3" }));
  expect(await screen.findByText(/Verified execution: Finalized swap matched/)).toBeTruthy();
  expect(mocks.verify).toHaveBeenCalledTimes(1);
  expect(onBundle).not.toHaveBeenCalled();
});
it("malformed archives explain the JSON problem", async () => {
  const view = render(<EvidenceInspector onBundle={vi.fn()} />);
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {
    target: { files: [{ size: 10, text: async () => '{"bad":' }] },
  });
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("not valid JSON"),
  );
});
it("keeps another receipt available during verification and releases every button after success or failure", async () => {
  let finish!: (value: { status: string; message: string }) => void;
  mocks.verify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mocks.verify.mockRejectedValueOnce(new Error("RPC unavailable"));
  const view = render(<EvidenceInspector onBundle={vi.fn()} />);
  const rows = ["ab", "cd"].map((part) => ({
    plan: { id: `0x${part.repeat(32)}`, signer: "test account", assetId: 8801000, reverse: false },
    hash: `0x${part.repeat(32)}`,
    state: "submitted",
  }));
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {
    target: {
      files: [
        {
          size: 1000,
          text: async () => JSON.stringify({ kind: "seam-native-swaps", archiveVersion: 1, rows }),
        },
      ],
    },
  });
  await screen.findByRole("heading", { name: "Native swap archive" });
  fireEvent.click(screen.getAllByRole("button", { name: "Verify native swap on V3" })[0]!);
  expect(
    (screen.getByRole("button", { name: "Verifying on V3…" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  const other = screen.getByRole("button", { name: "Verify native swap on V3" });
  expect((other as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(other);
  await screen.findByText("RPC unavailable");
  await act(async () => finish({ status: "verified", message: "Finalized swap matched." }));
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Verify native swap on V3" })).toHaveLength(2),
  );
  for (const button of screen.getAllByRole("button", { name: "Verify native swap on V3" }))
    expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getAllByRole("button", { name: "Verify native swap on V3" })[1]!);
  await waitFor(() => expect(mocks.verify).toHaveBeenCalledTimes(3));
});
