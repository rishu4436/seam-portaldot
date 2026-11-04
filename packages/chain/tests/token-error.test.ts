import { expect, it } from "vitest";
import { describeDispatchError } from "../src/runtime.js";
import { devFacts, devInputs, devHex } from "./syntheticV3.js";
it("preserves the runtime Token sub-error instead of reducing it to the generic variant", () => {
  const facts = devFacts(devInputs(devHex));
  expect(describeDispatchError(facts, { Token: "CannotCreate" })).toBe("Token.CannotCreate");
  expect(describeDispatchError(facts, { Token: "Frozen" })).toBe("Token.Frozen");
});
