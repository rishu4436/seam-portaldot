import { expect, it } from "vitest";
import { factsFromMetadata } from "@seam/compiler";
import { withFallback, v3Spec3002 } from "./metadataMutate.js";
import { loadRuntimeCore } from "../src/runtime-core.js";
import { decodeRuntime } from "../src/runtime.js";

it("bounds encoder and decorated decoder retention while preserving exact metadata identities", () => {
  const original = v3Spec3002();
  const variants = Array.from({ length: 8 }, (_, i) =>
    withFallback(original, "Revive", "EthBlockBuilderIR", `0x${i.toString(16).padStart(4, "0")}`),
  );
  const facts = variants.map((metadataHex) =>
    factsFromMetadata({
      metadataHex,
      genesisHash: `0x${"ab".repeat(32)}`,
      tokenSymbol: "tPOT",
      tokenDecimals: 14,
    }),
  );
  const hotEncoder = loadRuntimeCore(variants[0]!);
  const oldEncoder = loadRuntimeCore(variants[1]!);
  const hotDecoder = decodeRuntime(facts[0]!);
  const oldDecoder = decodeRuntime(facts[1]!);
  oldDecoder.decorated();
  loadRuntimeCore(variants[0]!);
  decodeRuntime(facts[0]!);
  for (let i = 2; i < variants.length; i++) {
    loadRuntimeCore(variants[i]!);
    decodeRuntime(facts[i]!).decorated();
    expect(loadRuntimeCore(variants[0]!)).toBe(hotEncoder);
    expect(decodeRuntime(facts[0]!)).toBe(hotDecoder);
  }
  const rebuiltEncoder = loadRuntimeCore(variants[1]!);
  const rebuiltDecoder = decodeRuntime(facts[1]!);
  expect(rebuiltEncoder).not.toBe(oldEncoder);
  expect(rebuiltDecoder).not.toBe(oldDecoder);
  expect(rebuiltEncoder.metadataHash).toBe(oldEncoder.metadataHash);
  expect(rebuiltDecoder.metadata.toHex()).toBe(oldDecoder.metadata.toHex());
  expect(rebuiltDecoder.decorated().query.system.account).toBeTruthy();
}, 60000);
