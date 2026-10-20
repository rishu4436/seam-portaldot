// Layout hash v2: only allow-listed storage defaults (Revive.EthBlockBuilderIR) are blanked, and the compiler's copy
// gives the same value as @seam/chain's on the real committed V3 spec 3002 blob. Offline.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLANKED_STORAGE_DEFAULTS, metadataLayout, metadataLayoutHash } from "../src/index.js";
import {
  BLANKED_STORAGE_DEFAULTS as CHAIN_BLANKED,
  METADATA_LAYOUT_DOMAIN as CHAIN_DOMAIN,
  metadataLayoutHash as chainLayoutHash,
} from "../../chain/src/metadata-layout.js";
import { METADATA_LAYOUT_DOMAIN } from "../src/layout.js";
import { withFallback } from "../../chain/tests/metadataMutate.js";

const v3Hex = readFileSync(
  fileURLToPath(
    new URL("../../../evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex", import.meta.url),
  ),
  "utf8",
).trim() as `0x${string}`;
const V3_LAYOUT_V2 = "0x221ba8f7dd81e0341fca9f0074a3e433659c97300cbbb2f874dbd5f0d998b304";

describe("metadata layout hash v2 (compiler copy)", () => {
  it("pins the real V3 spec 3002 v2 value", () =>
    expect(metadataLayout(v3Hex)).toEqual({ hash: V3_LAYOUT_V2, normalized: true }));
  it("matches @seam/chain: same list, same domain, same value", () => {
    expect(BLANKED_STORAGE_DEFAULTS).toEqual(CHAIN_BLANKED);
    expect(METADATA_LAYOUT_DOMAIN).toBe(CHAIN_DOMAIN);
    expect(metadataLayoutHash(v3Hex)).toBe(chainLayoutHash(v3Hex));
  });
  it("a Revive.EthBlockBuilderIR default change keeps the hash (the observed drift)", () => {
    const drifted = withFallback(v3Hex, "Revive", "EthBlockBuilderIR", "0x00");
    expect(drifted).not.toBe(v3Hex);
    expect(metadataLayoutHash(drifted)).toBe(V3_LAYOUT_V2);
    expect(chainLayoutHash(drifted)).toBe(V3_LAYOUT_V2);
  });
  it("any other storage default change fails closed (System.Number)", () => {
    const changed = withFallback(v3Hex, "System", "Number", "0x2a000000");
    expect(metadataLayoutHash(changed)).not.toBe(V3_LAYOUT_V2);
    expect(metadataLayoutHash(changed)).toBe(chainLayoutHash(changed));
  });
});
