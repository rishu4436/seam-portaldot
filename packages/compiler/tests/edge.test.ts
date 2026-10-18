import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compile,
  computeAbiHash,
  SeamCompileError,
  type Manifest,
  type RuntimeFacts,
} from "../src/index.js";
import { ALICE, BOB, GENESIS, demoManifest, expectIssue, realFacts } from "./helpers.js";

const facts = realFacts();
const withCap = (
  f: RuntimeFacts,
  name: string,
  status: "not_observed" | "unknown",
): RuntimeFacts => ({
  ...f,
  capabilities: { ...f.capabilities, [name]: { status } },
});
const one = (kind: "assets.mint" | "assets.transfer", assetId: unknown): Manifest => ({
  version: 1,
  chain: { genesisHash: GENESIS, specVersion: 1002 },
  signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
  actions: [{ id: "a", kind, args: { assetId, amount: "1", recipient: BOB } }],
});

describe("edge cases", () => {
  it("missing pallet: the step is unavailable, names the capability and spec, and has no indices or bytes", () => {
    const p = compile(demoManifest(), withCap(facts, "Assets.transfer_keep_alive", "not_observed"));
    expect(p.mode).toBe("unavailable");
    const s = p.steps.find((x) => x.actionId === "pay")!;
    expect(s).toMatchObject({
      status: "unavailable",
      palletIndex: null,
      callIndex: null,
      encodedCall: null,
    });
    expect(s.reason).toBe("Assets.transfer_keep_alive is not on this runtime (spec 1002)");
    expect(p.modeReason).toContain('step "pay": Assets.transfer_keep_alive is not on this runtime');
    expect(p.outerCall).toBeUndefined();
    // the other steps still compile
    expect(p.steps.filter((x) => x.status === "ok")).toHaveLength(2);
  });

  it('capability that could not be read says "could not be confirmed", not "not on this runtime"', () => {
    const s = compile(demoManifest(), withCap(facts, "Contracts.call", "unknown")).steps[1]!;
    expect(s.status).toBe("unavailable");
    expect(s.reason).toMatch(/could not be confirmed.*spec 1002/);
    expect(s.reason).not.toMatch(/not on this runtime/);
  });

  it("empty manifest is refused with a clear MANIFEST_INVALID, never an empty plan", () => {
    expectIssue(
      () => compile({ ...demoManifest(), actions: [] }, facts),
      "MANIFEST_INVALID",
      "actions",
    );
    try {
      compile({ ...demoManifest(), actions: [] }, facts);
    } catch (e) {
      expect((e as SeamCompileError).message).toContain("actions must be a non-empty array");
    }
  });

  it("unknown asset id: malformed ids are refused; a well-formed id the chain has never seen still compiles (no chain read)", () => {
    for (const bad of ["abc", "-1", "1.5", "", "x".repeat(5)])
      expectIssue(
        () => compile(one("assets.mint", bad), facts),
        "MANIFEST_INVALID",
        "actions[0].args.assetId",
      );
    expectIssue(() => compile(one("assets.mint", undefined), facts), "MANIFEST_INVALID", "assetId");
    // The compiler is offline: it cannot know whether asset 999999 exists. Existence is a preflight concern.
    const p = compile(one("assets.mint", "999999"), facts);
    expect(p.steps[0]!.status).toBe("ok");
  });

  it("unknown asset id too large for the runtime id type is refused, not truncated", () => {
    expect(() => compile(one("assets.transfer", "99999999999999999999999999"), facts)).toThrow(
      SeamCompileError,
    );
  });

  it("ABI hash mismatch names both the computed and the pinned hash", () => {
    const abi = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../fixtures/ink/flipper.v3.json", import.meta.url)),
        "utf8",
      ),
    );
    const pinned = `0x${"ab".repeat(32)}`;
    const m: Manifest = {
      ...demoManifest(),
      actions: [
        {
          id: "c",
          kind: "contracts.call",
          args: { contract: BOB, value: "0", gasLimit: "1", message: "flip", abi, abiHash: pinned },
        },
      ],
    };
    try {
      compile(m, facts);
      throw new Error("should not compile");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("ABI_HASH_MISMATCH");
      expect(msg).toContain("actions[0].args.abiHash");
      expect(msg).toContain(`the ABI hashes to ${computeAbiHash(abi)}`);
      expect(msg).toContain(`the manifest pins ${pinned}`);
    }
  });
});
