import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { withFallback, v3Spec3002 } from "../../chain/tests/metadataMutate.js";
import { loadRuntime } from "../src/runtime.js";

it("evicts historical metadata registries, keeps hot entries, and rebuilds identical call bytes", () => {
  const original = v3Spec3002();
  const variants = Array.from({ length: 8 }, (_, i) =>
    withFallback(original, "Revive", "EthBlockBuilderIR", `0x${i.toString(16).padStart(4, "0")}`),
  );
  const hot = loadRuntime(variants[0]!);
  const old = loadRuntime(variants[1]!);
  loadRuntime(variants[0]!);
  for (const hex of variants.slice(2)) {
    loadRuntime(hex);
    expect(loadRuntime(variants[0]!)).toBe(hot);
  }
  const rebuilt = loadRuntime(variants[1]!);
  expect(rebuilt).not.toBe(old);
  expect(rebuilt.metadataHash).toBe(old.metadataHash);
  expect(rebuilt.metadata.toHex()).toBe(old.metadata.toHex());
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../console/src/demo/v3-demo-transfer.json", import.meta.url)),
      "utf8",
    ),
  );
  const call = fixture.plan.steps[0].encodedCall;
  expect(rebuilt.registry.createType("Call", call).toHex()).toBe(
    old.registry.createType("Call", call).toHex(),
  );
}, 60000);
