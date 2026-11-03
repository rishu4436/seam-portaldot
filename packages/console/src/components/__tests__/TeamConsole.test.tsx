// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import WorkspaceCenters from "../WorkspaceCenters";
const key = `seam_key_${"a".repeat(43)}`;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it("keeps credentials in memory and gives a reader no write controls", async () => {
  const fetcher = vi.fn(async (url: string | URL) => {
    const path = String(url);
    return new Response(
      JSON.stringify(
        path.endsWith("/v1/session")
          ? {
              name: "Reader",
              workspaceId: "workspace-1",
              scopes: ["evidence:read", "monitor:read"],
              administrator: false,
            }
          : path.endsWith("/evidence")
            ? { evidence: [] }
            : path.endsWith("/monitors")
              ? { monitors: [] }
              : {},
      ),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const persist = vi.spyOn(Storage.prototype, "setItem");
  render(<WorkspaceCenters view="team" />);
  fireEvent.change(screen.getByLabelText("Backend URL"), {
    target: { value: "https://team.example" },
  });
  fireEvent.change(screen.getByLabelText("Workspace access key"), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Connect team workspace" }));
  await screen.findByText("Connected");
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  expect(screen.queryByRole("button", { name: "Upload imported evidence" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create runtime watch" })).toBeNull();
  expect(JSON.stringify(persist.mock.calls)).not.toContain(key);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect((screen.getByLabelText("Workspace access key") as HTMLInputElement).value).toBe("");
});
it("refuses to transmit access keys to a non-HTTPS remote backend", async () => {
  const fetcher = vi.fn(async (_url: string | URL) => new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  render(<WorkspaceCenters view="team" />);
  fireEvent.change(screen.getByLabelText("Backend URL"), {
    target: { value: "http://untrusted.example" },
  });
  fireEvent.change(screen.getByLabelText("Workspace access key"), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Connect team workspace" }));
  await screen.findByText("Use an HTTPS backend URL.");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("./control-plane.json");
});
