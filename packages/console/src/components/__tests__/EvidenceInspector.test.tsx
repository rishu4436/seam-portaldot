// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { prepareEvidenceBundle, type EvidenceBundle } from "@seam/sdk/browser";
import { EvidenceInspector, TeamConsole } from "../WorkspaceCenters";
const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../../lib/evidence", () => ({ verifyEvidence: mocks.verify, downloadJson: vi.fn() }));
// Isolate async UI binding from cryptographic integrity, covered separately by SDK and live-browser checks.
vi.mock("@seam/sdk/browser", async (original) => ({
  ...(await original<typeof import("@seam/sdk/browser")>()),
  inspectEvidenceBundle: (bundle: EvidenceBundle) => ({
    status: "integrity_checked",
    checks: [],
    summary: {
      actions: bundle.plan.steps.length,
      mode: bundle.plan.mode,
      signer: bundle.plan.signer.value,
      claimedResult: bundle.receipt.result,
    },
  }),
}));
const fixtures = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../evidence/testnet-v3/runs",
);
const load = (name: string) => JSON.parse(readFileSync(resolve(fixtures, name), "utf8"));
const seq = () => prepareEvidenceBundle(load("plan-sequential-1792411270138.json"));
const atomic = () => prepareEvidenceBundle(load("plan-atomic-1792411355057.json"));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it("never displays an earlier receipt's completed verification against a newly imported receipt", async () => {
  let finish!: (value: unknown) => void;
  mocks.verify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const initial = seq();
  const view = render(<EvidenceInspector bundle={initial} onBundle={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Verify against live V3 testnet" }));
  expect(mocks.verify).toHaveBeenCalledTimes(1);
  view.rerender(<EvidenceInspector bundle={atomic()} onBundle={vi.fn()} />);
  await act(async () => finish({ status: "chain_verified" }));
  expect(screen.queryByRole("heading", { name: "Independent chain result" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Verify against live V3 testnet" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it("discards an older slow file import after another file was selected", async () => {
  let finish!: (value: string) => void;
  const changed = vi.fn();
  const view = render(<EvidenceInspector onBundle={changed} />);
  const input = view.container.querySelector('input[type="file"]')!;
  const a = new File(["a"], "a.json"),
    b = new File(["b"], "b.json");
  Object.defineProperty(a, "text", {
    value: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  Object.defineProperty(b, "text", {
    value: async () => JSON.stringify(load("plan-atomic-1792411355057.json")),
  });
  fireEvent.change(input, { target: { files: [a] } });
  fireEvent.change(input, { target: { files: [b] } });
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  await act(async () => finish(JSON.stringify(load("plan-sequential-1792411270138.json"))));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].plan.mode).toMatch(/atomic/);
});
const key = `seam_key_${"a".repeat(43)}`;
const teamFetch = async (url: string | URL) =>
  new Response(
    JSON.stringify(
      String(url).endsWith("/v1/session")
        ? {
            name: "Owner",
            keyId: "owner",
            workspaceId: "team",
            scopes: ["evidence:read", "evidence:write", "monitor:read", "keys:write"],
          }
        : String(url).endsWith("/evidence")
          ? { evidence: [] }
          : String(url).endsWith("/monitors")
            ? { monitors: [] }
            : String(url).endsWith("/keys")
              ? {
                  keys: [
                    {
                      id: "owner",
                      name: "Owner",
                      prefix: key.slice(0, 16),
                      scopes: ["keys:write"],
                      revoked_at: null,
                    },
                  ],
                }
              : {},
    ),
  );
async function connect() {
  fireEvent.change(screen.getByLabelText("Backend URL"), {
    target: { value: "https://team.example" },
  });
  fireEvent.change(screen.getByLabelText("Workspace access key"), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Connect team workspace" }));
  await screen.findByText("Connected");
}
it("resets disclosure consent when the evidence bundle changes", async () => {
  vi.stubGlobal("fetch", vi.fn(teamFetch));
  const a = seq(),
    b = atomic();
  const view = render(<TeamConsole bundle={a} />);
  await connect();
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  const consent = screen.getByRole("checkbox") as HTMLInputElement;
  fireEvent.click(consent);
  expect(consent.checked).toBe(true);
  view.rerender(<TeamConsole bundle={b} />);
  expect(consent.checked).toBe(false);
  expect(
    (screen.getByRole("button", { name: "Upload imported evidence" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("prevents accidental revocation of the key used by the current session", async () => {
  const fetcher = vi.fn(teamFetch);
  vi.stubGlobal("fetch", fetcher);
  render(<TeamConsole />);
  await connect();
  const current = await screen.findByRole("button", { name: "Current session key" });
  expect((current as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(current);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/revoke"))).toBe(false);
});
