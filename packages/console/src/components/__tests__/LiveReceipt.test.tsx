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

  it("with the compiled step, verifyStep decides for any step kind (not only transfers)", async () => {
    const stepCheck = vi.fn(async () => ({
      verdict: "effect_proven" as const,
      extrinsicIndex: -1,
      event: {},
      reason: "NFT confirmed",
      checkedAt: "",
    }));
    const check = vi.fn();
    render(
      <LiveReceipt
        out={out}
        plan={{ ...plan, steps: [] }}
        rpc={rpc}
        effectCheck={check}
        compiled={{ step: { kind: "nfts.mint" }, signerAccountId: "0x01" }}
        stepCheck={stepCheck}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("receipt-effect").textContent).toMatch(
        /verifyStep\): NFT confirmed/,
      ),
    );
    expect(check).not.toHaveBeenCalled();
    expect(stepCheck).toHaveBeenCalledTimes(1);
  });

  it("Download writes exactly the receipt the panel shows (result + verifyStep steps)", async () => {
    const step = {
      actionId: "pay",
      status: "finalized",
      events: [],
      verification: "verified",
      coverage: "effect_proven",
      reason: "Transfer confirmed: asset, amount and account all match the plan.",
    };
    const stepCheck = vi.fn(async () => ({
      verdict: "effect_proven" as const,
      extrinsicIndex: -1,
      event: {},
      reason: step.reason,
      steps: [step as never],
      checkedAt: "t",
    }));
    const blobs: string[] = [];
    const RealBlob = globalThis.Blob;
    vi.stubGlobal(
      "Blob",
      class extends RealBlob {
        constructor(parts: BlobPart[], o?: BlobPropertyBag) {
          super(parts, o);
          blobs.push(String(parts[0]));
        }
      },
    );
    URL.createObjectURL = vi.fn(() => "blob:x");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <LiveReceipt
        out={out}
        plan={plan}
        rpc={rpc}
        compiled={{ step: { kind: "assets.transfer" }, signerAccountId: "0x01" }}
        stepCheck={stepCheck}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("receipt-result").textContent).toBe("verified"));
    expect(screen.getByTestId("receipt-steps").textContent).toMatch(/pay verified/);
    screen.getByRole("button", { name: /download receipt/i }).click();
    expect(click).toHaveBeenCalled();
    const saved = JSON.parse(blobs.at(-1)!);
    expect(saved.result).toBe(screen.getByTestId("receipt-result").textContent);
    expect(saved.steps).toEqual([step]);
    expect(saved.verification).toBe("effect_proven");
    vi.unstubAllGlobals();
  });
});

describe("top-level Result line renders the receipt's result (single source of truth)", () => {
  // Anchor's run 0xf883200e: the raw live status was "unverified" while the receipt said "verified".
  const unverifiedOut = { ...out, status: "unverified" } as unknown as LiveOutcome;
  const okStep = {
    actionId: "pay",
    status: "finalized",
    events: [],
    verification: "verified",
    coverage: "effect_proven",
    reason: "Transfer confirmed.",
  };
  const downloaded = (): Record<string, unknown> => {
    const blobs: string[] = [];
    const RealBlob = globalThis.Blob;
    vi.stubGlobal(
      "Blob",
      class extends RealBlob {
        constructor(parts: BlobPart[], o?: BlobPropertyBag) {
          super(parts, o);
          blobs.push(String(parts[0]));
        }
      },
    );
    URL.createObjectURL = vi.fn(() => "blob:x");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    screen.getByRole("button", { name: /download receipt/i }).click();
    vi.unstubAllGlobals();
    return JSON.parse(blobs.at(-1)!);
  };
  const resultLines = () =>
    screen.getAllByText(/^Result$/).map((dt) => dt.nextElementSibling?.textContent);
  const compiled = { step: { kind: "assets.transfer" }, signerAccountId: "0x01" };

  it("verified: Result shows verified while the live status stays labelled separately as unverified", async () => {
    const stepCheck = vi.fn(async () => ({
      verdict: "effect_proven" as const,
      extrinsicIndex: 1,
      event: {},
      steps: [okStep as never],
      checkedAt: "t",
    }));
    render(
      <LiveReceipt
        out={unverifiedOut}
        plan={plan}
        rpc={rpc}
        compiled={compiled}
        stepCheck={stepCheck}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("receipt-result").textContent).toBe("verified"));
    expect(resultLines()).toEqual(["verified"]);
    expect(screen.getByTestId("receipt-live-status").textContent).toBe("unverified");
    expect(
      screen.getByText(/Live status at finalization \(before the effect check, not the verdict\)/),
    ).toBeTruthy();
    expect(downloaded().result).toBe("verified");
  });
  it("not_verified: a failed effect check renders not_verified, same as the download", async () => {
    const stepCheck = vi.fn(async () => ({
      verdict: "not_verified" as const,
      reason: "amount differs",
      steps: [{ ...okStep, verification: "not_verified" } as never],
      checkedAt: "t",
    }));
    render(
      <LiveReceipt out={out} plan={plan} rpc={rpc} compiled={compiled} stepCheck={stepCheck} />,
    );
    await waitFor(() => expect(stepCheck).toHaveBeenCalled());
    await waitFor(() => expect(resultLines()).toEqual(["not_verified"]));
    expect(downloaded().result).toBe("not_verified");
  });
  it("unverified live status with no proven effect: Result is the receipt's not_verified, never the raw status", async () => {
    const check = vi
      .fn()
      .mockResolvedValue({ verdict: "not_verified", reason: "no event", checkedAt: "t" });
    render(<LiveReceipt out={unverifiedOut} plan={plan} rpc={rpc} effectCheck={check} />);
    await waitFor(() =>
      expect(screen.getByTestId("receipt-effect").textContent).toMatch(/not verified/),
    );
    const saved = downloaded();
    expect(resultLines()).toEqual([saved.result]);
    expect(saved.result).toBe("not_verified");
    expect(screen.getByTestId("receipt-live-status").textContent).toBe("unverified");
  });
});
