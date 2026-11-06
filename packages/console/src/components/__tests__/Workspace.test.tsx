// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../../App";
vi.mock("../WorkspaceCenters", () => ({
  default: ({ view }: { view: string }) => <h1>{view}</h1>,
}));
const mocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("../../lib/signflow", () => ({
  loadChainFns: async () => ({}),
  engineApprovalCheck: (...args: unknown[]) => mocks.check(...args),
}));
vi.mock("../../lib/browserChain", () => ({ transportFor: () => async () => null }));
vi.mock("../../lib/rebind", () => ({
  approveWithRebind: async (args: { check: (f: unknown) => Promise<unknown> }) => ({
    kind: "checked",
    gate: await args.check({}),
    liveFacts: {},
  }),
}));
vi.mock("../ManifestBuilder", () => ({
  ManifestBuilder: (props: {
    onInvalidate: () => void;
    onPolicyEdit: () => void;
    onUsePolicy: (s: unknown) => void;
  }) => {
    const select = (id: string, downgrade = false) =>
      props.onUsePolicy({
        plan: {
          planDigest: id,
          steps: [],
          signer: { value: "account" },
          mode: "sequential",
          ...(downgrade
            ? { modeDowngrade: { from: "atomic", to: "sequential", requiresApproval: true } }
            : {}),
        },
        policy: { maxApprovalSeconds: 600 },
        manifest: {},
        facts: {},
      });
    return (
      <div>
        <button onClick={() => select("plan-a")}>Provide plan A</button>
        <button onClick={() => select("plan-b")}>Provide plan B</button>
        <button onClick={() => select("downgraded", true)}>Provide downgraded plan</button>
        <button onClick={() => props.onInvalidate()}>Edit draft</button>
        <button onClick={props.onPolicyEdit}>Edit policy</button>
      </div>
    );
  },
}));
vi.mock("../Modes", () => ({
  liveFactsStep: vi.fn(),
  PolicyGatePanel: () => <p>Policy checked</p>,
  LivePanel: (p: { plan?: { digest: string }; approval?: unknown }) => (
    <p data-testid="execution">
      {p.plan?.digest ?? "no plan"} / {p.approval ? "approved" : "unapproved"}
    </p>
  ),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/console.html");
});
it("opens a shared developer URL directly and keeps navigation in browser history", async () => {
  const scrolling = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  window.history.replaceState({}, "", "/console.html?view=developers");
  render(<App />);
  await screen.findByRole("heading", { name: "developers" });
  fireEvent.click(screen.getByRole("button", { name: "New transaction" }));
  expect(window.location.search).toBe("");
  window.history.replaceState({}, "", "/console.html?view=developers");
  fireEvent(window, new PopStateEvent("popstate"));
  await waitFor(() => expect(screen.getByRole("heading", { name: "developers" })).toBeTruthy());
  scrolling.mockRestore();
});
it("opens the live workspace without a demo-mode detour", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Make your next move." })).toBeTruthy();
  expect(screen.getByTestId("execution").textContent).toBe("no plan / unapproved");
  expect(screen.queryByText("OFFLINE DEMO")).toBeNull();
});
it("refreshes the review fee from the same preflight used by the approval check", async () => {
  mocks.check.mockImplementation(async (args: { onPreflight: (value: unknown) => void }) => {
    args.onPreflight({ totalFee: { value: "1234" } });
    return { ok: true, explanations: [] };
  });
  render(<App />);
  fireEvent.click(screen.getByText("Provide plan A"));
  fireEvent.click(screen.getByText("Check policy and approve"));
  expect(await screen.findByText("1234 native base units")).toBeTruthy();
  expect(screen.getByTestId("execution").textContent).toBe("plan-a / approved");
});
it("invalidates review and approval when the draft changes", async () => {
  mocks.check.mockResolvedValue({ ok: true, codes: [], explanations: [] });
  render(<App />);
  fireEvent.click(screen.getByText("Provide plan A"));
  fireEvent.click(screen.getByText("Check policy and approve"));
  await waitFor(() =>
    expect(screen.getByTestId("execution").textContent).toBe("plan-a / approved"),
  );
  fireEvent.click(screen.getByText("Edit draft"));
  expect(screen.getByTestId("execution").textContent).toBe("no plan / unapproved");
});
it("clears an approval immediately on a policy edit and names the cause", async () => {
  mocks.check.mockResolvedValue({ ok: true, codes: [], explanations: [] });
  render(<App />);
  fireEvent.click(screen.getByText("Provide plan A"));
  fireEvent.click(screen.getByText("Check policy and approve"));
  await waitFor(() =>
    expect(screen.getByTestId("execution").textContent).toBe("plan-a / approved"),
  );
  fireEvent.click(screen.getByText("Edit policy"));
  expect(screen.getByTestId("execution").textContent).toBe("no plan / unapproved");
  expect(screen.getByText(/Policy changed\. The previous approval was cleared/)).toBeTruthy();
});
it("discards a late approval result when a different plan was selected", async () => {
  let resolve!: (v: unknown) => void;
  mocks.check.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<App />);
  fireEvent.click(screen.getByText("Provide plan A"));
  fireEvent.click(screen.getByText("Check policy and approve"));
  await waitFor(() => expect(mocks.check).toHaveBeenCalled());
  fireEvent.click(screen.getByText("Provide plan B"));
  resolve({ ok: true, codes: [], explanations: [] });
  await waitFor(() => expect(screen.queryByText("Checking live policy…")).toBeNull());
  expect(screen.getByTestId("execution").textContent).toBe("plan-b / unapproved");
});

it("requires an explicit acknowledgement before approving an atomic-to-sequential downgrade", async () => {
  mocks.check.mockResolvedValue({ ok: true, codes: [], explanations: [] });
  render(<App />);
  fireEvent.click(screen.getByText("Provide downgraded plan"));
  expect(screen.getByText("Check policy and approve").closest("button")?.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByText("Check policy and approve").closest("button")?.disabled).toBe(false);
  fireEvent.click(screen.getByText("Check policy and approve"));
  await waitFor(() => expect(mocks.check).toHaveBeenCalled());
  expect(mocks.check.mock.calls[0][0].acknowledgedDowngrade).toBe(true);
});
