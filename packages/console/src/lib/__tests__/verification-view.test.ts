import { it, expect } from "vitest";
import { verificationLabel, verificationTone } from "../verification-view";
import { formatUnits } from "../../components/AccountReadiness";
it("never presents a chain-checked partial receipt as a completed execution", () => {
  expect(verificationLabel("chain_verified", "partial")).toContain("partial execution");
  expect(verificationTone("chain_verified", "partial")).toBe("neutral");
  expect(verificationTone("failed", "verified")).toBe("bad");
  expect(verificationLabel("unknown")).toBe("Verification incomplete");
  expect(verificationLabel("chain_verified", "verified")).toBe("Verified execution");
});
it("formats native units without rounding through floating point", () => {
  expect(formatUnits("1234567890123456789012345", 14)).toBe("12,345,678,901.23456789012345");
  expect(formatUnits("1", 14)).toBe("0.00000000000001");
});
