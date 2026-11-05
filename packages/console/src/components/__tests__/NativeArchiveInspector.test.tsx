// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
