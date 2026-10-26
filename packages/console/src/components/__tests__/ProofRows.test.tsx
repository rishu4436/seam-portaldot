// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ProofRows } from "../ProofRows";
import { proofRows } from "../../lib/statuslabels";

describe("ProofRows view", () => {
  it("renders the five rows with plain labels", () => {
    render(
      <ProofRows
        rows={proofRows({ fee: "5", txState: "finalized", status: "unverified" }, "live")}
      />,
    );
    const g = screen.getByRole("group", { name: "Proof" });
    for (const [id, text] of [
      ["fee_estimate", "Live"],
      ["unsigned_sim", "Unknown"],
      ["signed_dry_run", "Unknown"],
      ["dispatch_result", "Finalized"],
      ["verified_effect", "Unknown"],
    ])
      expect(within(g).getByTestId(`proof-${id}`).textContent).toContain(text);
  });
});
