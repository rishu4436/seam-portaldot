// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuilderPolicy } from "../BuilderPolicy";
import demo from "../../demo/v3-demo-transfer.json";
import type { Plan } from "@seam/policy/browser";
afterEach(cleanup);
it("every editable policy field invalidates the previously handed-off approval", async () => {
  const invalidate = vi.fn();
  render(
    <BuilderPolicy
      plan={demo.plan as unknown as Plan}
      manifest={demo.manifest}
      onInvalidate={invalidate}
      readPreflight={async () => ({ totalFee: { value: "1000" } })}
    />,
  );
  fireEvent.click(screen.getByText("Read fee from preflight"));
  await screen.findByLabelText("Fee cap");
  invalidate.mockClear();
  fireEvent.change(screen.getByLabelText("Fee cap"), { target: { value: "1000" } });
  fireEvent.change(screen.getByLabelText("Max amount 806707"), { target: { value: "0" } });
  fireEvent.click(screen.getByLabelText("Allow asset 806707"));
  fireEvent.click(screen.getByLabelText(/^Allow recipient/));
  expect(invalidate).toHaveBeenCalledTimes(4);
});
