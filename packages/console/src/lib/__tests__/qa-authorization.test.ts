import { expect, it, vi } from "vitest";
import { callPermissionBlock, engineApprovalCheck, preSign, type ChainFns } from "../signflow";
import { parseJsonFile } from "../json-input";
import { NativeSwapStore } from "../native-swap-store";
const plan = { steps: [{ actionId: "call", kind: "revive.call" }] };
it("refuses unknown or missing contract simulations, including policy exceptions", async () => {
  const chain = {
    preflight: async () => ({ steps: [{ actionId: "call", dryRun: "unknown" }] }),
  } as unknown as ChainFns;
  const gate = vi.fn();
  const result = await engineApprovalCheck({
    chain,
    send: async () => null,
    readFacts: async () => ({}),
    input: { plan, policy: { allowUnknownDryRun: true } },
    now: new Date(),
    gate,
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw Error("Expected refusal before the wallet request");
  expect(result.codes).toContain("CALL_PERMISSION_UNVERIFIED");
  expect(gate).not.toHaveBeenCalled();
  const sign = await preSign({
    chain,
    send: async () => null,
    facts: {},
    input: { plan, policy: {} },
    signer: "account",
    ctx: { nonce: 0, mortalityBlocks: 32, checkpointNumber: 1, checkpointHash: "0x00" },
    now: new Date(),
    gate,
  });
  expect(sign.res.ok).toBe(false);
  expect(gate).not.toHaveBeenCalled();
});
it("accepts supported successful call simulation without assuming all calls are issuer-only", () => {
  expect(
    callPermissionBlock(plan, { steps: [{ actionId: "call", dryRun: "ok" }] }),
  ).toBeUndefined();
  expect(callPermissionBlock(plan, { steps: [] })).toContain("could not be verified");
});
it("gives malformed JSON a useful error without exposing the parser or file", () => {
  expect(() => parseJsonFile('{"secret": broken}')).toThrow("not valid JSON");
});
it("distinguishes a different archive kind from a size-limit problem", () => {
  const store = new NativeSwapStore({ getItem: () => null, setItem: () => {} });
  expect(() => store.restore({ archiveVersion: 1, receipts: [] })).toThrow(
    "not a native swap archive",
  );
  expect(() =>
    store.restore({ archiveVersion: 1, kind: "seam-native-swaps", rows: Array(101).fill({}) }),
  ).toThrow("at most 100 records");
});
