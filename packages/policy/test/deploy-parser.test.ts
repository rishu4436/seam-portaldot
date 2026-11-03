import { it, expect } from "vitest";
import { parsePolicy } from "../src/index.js";
it("parses and retains deploy caps", () => {
  const deploy = {
    allowedCodeHashes: ["0x" + "ab".repeat(32)],
    maxValue: "0",
    maxGasLimit: "100",
    maxProofSize: "10",
    maxStorageDepositLimit: "5",
  };
  const result = parsePolicy({ deploy });
  expect(result.ok && result.policy.deploy).toEqual(deploy);
});
it.each([{ maxGasLimit: -1 }, { unknown: true }, { allowedCodeHashes: ["bad"] }, null])(
  "rejects malformed deploy rules %j",
  (deploy) => {
    expect(parsePolicy({ deploy }).ok).toBe(false);
  },
);
