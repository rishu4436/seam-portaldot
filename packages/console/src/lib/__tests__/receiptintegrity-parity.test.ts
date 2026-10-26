// @vitest-environment node
// Drift guard: the console's INTEGRITY_ALGO and SECRET_KEYS must equal the SDK copies (packages/sdk/src/console-receipt.ts) that `seam verify` uses.
import { describe, expect, it } from "vitest";
import { CONSOLE_INTEGRITY_ALGO, CONSOLE_SECRET_KEYS } from "@seam/sdk";
import { INTEGRITY_ALGO, SECRET_KEYS } from "../receiptintegrity";

describe("console receipt integrity constants match the SDK", () => {
  it("INTEGRITY_ALGO equals CONSOLE_INTEGRITY_ALGO", () => {
    expect(INTEGRITY_ALGO).toBe(CONSOLE_INTEGRITY_ALGO);
  });
  it("SECRET_KEYS deep-equals CONSOLE_SECRET_KEYS", () => {
    expect([...SECRET_KEYS]).toEqual([...CONSOLE_SECRET_KEYS]);
  });
});
