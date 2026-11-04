// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import WorkspaceCenters from "../WorkspaceCenters";
const mocks = vi.hoisted(() => ({ restore: vi.fn(async () => 2) }));
vi.mock("../../lib/receiptarchive", () => ({
  listLocalReceipts: async () => [],
  importLocalReceipts: mocks.restore,
  exportLocalReceipts: vi.fn(),
  removeLocalReceipt: vi.fn(),
  RECEIPT_ARCHIVE_EVENT: "seam:receipts-changed",
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});
it("announces archive completion and deduplication without suggesting any transaction was sent", async () => {
  render(<WorkspaceCenters view="activity" />);
  fireEvent.change(screen.getByLabelText("Restore receipt archive"), {
    target: {
      files: [{ size: 20, text: async () => JSON.stringify({ archiveVersion: 1, receipts: [] }) }],
    },
  });
  expect(await screen.findByText(/Archive restored: 2 receipts checked and merged/)).toBeTruthy();
  expect(
    screen.getByText(/Existing receipts were deduplicated. Nothing was submitted./),
  ).toBeTruthy();
  expect(mocks.restore).toHaveBeenCalledTimes(1);
});
