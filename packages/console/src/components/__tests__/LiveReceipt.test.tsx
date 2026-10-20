// @vitest-environment jsdom
// The LIVE receipt's effect check and download. The effect checker is mocked; nothing here touches a real chain.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { LiveReceipt, transferExpectation } from "../Modes";
import type { LiveOutcome } from "../../lib/live";
import { walletDemoPlan } from "../../lib/walletdemo";

const plan = walletDemoPlan();
const out = {
  status: "finalized",
  message: "",
  coverage: "none",
  simulation: "none",
  signing: "signed",
  txState: "finalized",
  provenance: "live",
  txHash: "0x" + "8a".repeat(32),
  block: { number: 118310, hash: "0x" + "aa".repeat(32) },
  rpcAttempts: 1,
  submitted: true,
} as unknown as LiveOutcome;
const rpc = vi.fn();
afterEach(cleanup);

describe("LiveReceipt effect check", () => {
  it("reads the planned transfer from the demo plan", () => {
    const w = transferExpectation(plan)!;
    expect(w).toMatchObject({ assetId: "806707", amount: "1", from: plan.signer });
  });
  it("shows effect proven only when the checker proves it, with a download button", async () => {
    const check = vi.fn().mockResolvedValue({
      verdict: "effect_proven",
      extrinsicIndex: 1,
      event: { assetId: "806707", amount: "1", from: "a", to: "b" },
      checkedAt: "t",
    });
    render(<LiveReceipt out={out} plan={plan} rpc={rpc} effectCheck={check} />);
    await waitFor(() =>
      expect(screen.getByTestId("receipt-effect").textContent).toMatch(/effect proven/),
    );
    expect(check).toHaveBeenCalledWith(rpc, out.txHash, out.block!.hash, transferExpectation(plan));
    expect(screen.getByRole("button", { name: /download receipt/i })).toBeTruthy();
  });
  it("stays unverified when the check fails", async () => {
    const check = vi.fn().mockResolvedValue({
      verdict: "not_verified",
      reason: "No Assets.Transferred event",
      checkedAt: "t",
    });
    render(<LiveReceipt out={out} plan={plan} rpc={rpc} effectCheck={check} />);
    await waitFor(() =>
      expect(screen.getByTestId("receipt-effect").textContent).toMatch(/not verified: No Assets/),
    );
    expect(screen.getByTestId("receipt-effect").textContent).toMatch(/effect unverified/);
  });
  it("does not check before finality", () => {
    const check = vi.fn();
    render(
      <LiveReceipt
        out={{ ...out, txState: "submitted" } as LiveOutcome}
        plan={plan}
        rpc={rpc}
        effectCheck={check}
      />,
    );
    expect(check).not.toHaveBeenCalled();
    expect(screen.getByTestId("receipt-effect").textContent).toMatch(/not finalized/);
  });
});
