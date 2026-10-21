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

describe("MultiStepPanel Result line is the sequential receipt's result", () => {
  const base = {
    signRequests: 2,
    message: "m",
    approval: { hash: "0x" + "ab".repeat(32), inputs: { now: "t" } },
  };
  const sentStep = (index: number, verification: "verified" | "not_verified") => ({
    index,
    actionId: `s${index}`,
    status: "sent" as const,
    message: "x",
    sendIndex: index,
    receipt: {
      actionId: `s${index}`,
      status: "finalized" as const,
      events: [],
      verification,
      reason: "x",
    },
  });
  it.each([
    ["verified", { ok: true, steps: [sentStep(0, "verified"), sentStep(1, "verified")] }],
    ["not_verified", { ok: true, steps: [sentStep(0, "verified"), sentStep(1, "not_verified")] }],
    [
      "partial",
      {
        ok: false,
        stoppedAt: 1,
        steps: [
          sentStep(0, "verified"),
          { index: 1, actionId: "s1", status: "not_run" as const, message: "Not run." },
        ],
      },
    ],
  ])("renders %s", async (want, r) => {
    const { MultiStepPanel } = await import("../Modes");
    const { buildSequentialReceipt } = await import("../../lib/seqreceipt");
    const res = { ...base, ...r } as never;
    render(<MultiStepPanel r={res} />);
    expect(screen.getByTestId("seq-receipt-result").textContent).toBe(want);
    expect(buildSequentialReceipt(res).result).toBe(want);
  });
});

describe("MultiStepPanel shows the runtime lock basis", () => {
  it("says plainly when the lock passed on the layout hash, with both raw hashes shortened", async () => {
    const { MultiStepPanel } = await import("../Modes");
    const lock = {
      lockBasis: "layout_hash" as const,
      preparedMetadataHash: "0x523cc072" + "0".repeat(56),
      currentMetadataHash: "0xec8e7fb6" + "0".repeat(56),
    };
    render(
      <MultiStepPanel
        r={
          {
            ok: true,
            signRequests: 1,
            message: "m",
            steps: [
              {
                index: 0,
                actionId: "s0",
                status: "sent",
                message: "x",
                sendIndex: 0,
                runtimeLock: lock,
              },
            ],
          } as never
        }
      />,
    );
    expect(screen.getByTestId("seq-lock-basis-0").textContent).toBe(
      "Runtime lock passed on the layout hash: only the raw metadata hash changed (0x523cc072… -> 0xec8e7fb6…).",
    );
  });
});

describe("MultiStepPanel shows the signed dry-run block detail", () => {
  const AT = { number: 120600, hash: "0x" + "5a".repeat(32) };
  const run = (blockDetail: object) =>
    ({
      ok: false,
      signRequests: 2,
      stoppedAt: 1,
      message: "m",
      steps: [
        { index: 0, actionId: "s0", status: "sent", message: "x", sendIndex: 0 },
        {
          index: 1,
          actionId: "s1",
          status: "blocked",
          message: "Blocked at submit (signed_dry_run_failed)",
          blockDetail,
        },
      ],
    }) as never;
  it.each([
    [
      "dispatch error",
      { outcome: "failed", detail: "system_dryRun: dispatch failed: assets.BalanceLow: low" },
    ],
    ["validity error", { outcome: "failed", detail: "system_dryRun: invalid transaction: Stale" }],
  ])("%s: shown on the blocked step with the dry-run block", async (_n, dryRun) => {
    const { MultiStepPanel } = await import("../Modes");
    render(
      <MultiStepPanel
        r={run({ code: "signed_dry_run_failed", dryRun, dryRunAt: AT, source: "s" })}
      />,
    );
    expect(screen.getByTestId("seq-block-detail-1").textContent).toBe(
      `Dry-run detail: failed, ${dryRun.detail} (dry run at block #120600, 0x5a5a5a5a…).`,
    );
    expect(screen.queryByTestId("seq-block-detail-0")).toBeNull();
  });
  it("no detail: says so plainly", async () => {
    const { MultiStepPanel } = await import("../Modes");
    render(<MultiStepPanel r={run({ code: "signed_dry_run_failed", source: "s" })} />);
    expect(screen.getByTestId("seq-block-detail-1").textContent).toBe(
      "Dry-run detail: no detail reported by the gate.",
    );
  });
});

describe("LiveReceipt shows the atomic run's atomicity", () => {
  it("atomic_unverified is shown with its reason, and is in the receipt", async () => {
    const atomicity = {
      status: "atomic_unverified" as const,
      reason:
        "The plan compiled as atomic_unverified: rollback on failure is not proven for this runtime.",
      basis: "compiled plan mode",
    };
    render(
      <LiveReceipt
        out={out}
        plan={plan}
        rpc={rpc}
        effectCheck={vi.fn().mockResolvedValue({ verdict: "not_verified", reason: "x" })}
        compiled={{
          step: undefined,
          signerAccountId: "0x01",
          plan: { mode: "atomic_unverified", steps: [] },
          atomicity,
        }}
      />,
    );
    expect(screen.getByTestId("receipt-atomicity").textContent).toBe(
      `atomic_unverified: ${atomicity.reason}`,
    );
  });
});
