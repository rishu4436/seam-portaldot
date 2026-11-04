import { expect, it } from "vitest";
import { blockDetailText } from "../signflow";
it("explains generic Token failures as possible balance or recipient-funding issues while preserving the runtime error", () => {
  const text = blockDetailText({
    code: "signed_dry_run_failed",
    source: "test",
    dryRun: { outcome: "failed", detail: "dispatch failed: Token.CannotCreate" },
  });
  expect(text).toContain("Token.CannotCreate");
  expect(text).toContain("recipient's native tPOT");
  expect(text).toContain("check the sender's spendable balance");
  expect(
    blockDetailText({
      code: "signed_dry_run_failed",
      source: "test",
      dryRun: { outcome: "failed", detail: "assets.BalanceLow" },
    }),
  ).not.toContain("recipient's native tPOT");
});
