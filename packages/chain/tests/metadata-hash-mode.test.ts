/* eslint-disable @typescript-eslint/no-explicit-any -- raw polkadot.js objects */
/**
 * The trusted decoder reports CheckMetadataHash's mode from the extension bytes themselves (Sentinel's
 * submit-lock layout path requires metadataHashMode === 0). Ground truth: the 19 real finalized V3 extrinsics, all
 * mode 0 (Disabled). A copy with the mode byte set to 1 must report 1, and a runtime without the extension must leave it out.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { describe, expect, it } from "vitest";
import {
  chainInputsFromSnapshot,
  encodeRuntime,
  factsFromChainInputs,
  signedExtrinsicDecoder,
  type SnapshotJson,
} from "../src/index.js";
import * as browser from "../src/browser.js";
import * as chain from "../src/signing.js";

const ev = (n: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../evidence/v3-discovery/${n}`, import.meta.url)),
    "utf8",
  );
const facts = factsFromChainInputs(
  chainInputsFromSnapshot(
    JSON.parse(ev("portaldot-v3-spec3002-snapshot.json")) as SnapshotJson,
    ev("portaldot-v3-spec3002-metadata.hex").trim() as `0x${string}`,
  ),
);
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/v3-signed-extrinsics.json", import.meta.url), "utf8"),
) as { transactions: { label: string; extrinsic: `0x${string}`; birthHash: `0x${string}` }[] };

/** The same extrinsic with only the CheckMetadataHash mode byte set to 1 (found by trying each byte). */
function withModeOne(hex: `0x${string}`): `0x${string}` {
  const { registry } = encodeRuntime(facts);
  const bytes = hexToU8a(hex);
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue;
    const b = bytes.slice();
    b[i] = 1;
    try {
      const x = registry.createType("Extrinsic", b) as any;
      if (
        x.toHex() === u8aToHex(b) &&
        x.inner.signature.mode.toNumber() === 1 &&
        x.method.toHex() === (registry.createType("Extrinsic", bytes) as any).method.toHex()
      )
        return u8aToHex(b) as `0x${string}`;
    } catch {
      /* not this byte */
    }
  }
  throw new Error("mode byte not found");
}

describe("signedExtrinsicDecoder reports metadataHashMode", () => {
  it.each(fixture.transactions.map((t) => [t.label, t] as const))(
    "%s: mode 0 (Disabled)",
    (_l, t) => {
      const d = signedExtrinsicDecoder(facts, { checkpoint: { hash: t.birthHash } })(t.extrinsic);
      expect(d?.metadataHashMode).toBe(0);
    },
  );

  it("mode byte 1 is reported as 1 (and the signature no longer verifies)", () => {
    const t = fixture.transactions[0]!;
    const d = signedExtrinsicDecoder(facts, { checkpoint: { hash: t.birthHash } })(
      withModeOne(t.extrinsic),
    );
    expect(d?.metadataHashMode).toBe(1);
    expect(d?.signatureValid).toBe(false);
  });

  it("browser entry reports it too", () => {
    const t = fixture.transactions[0]!;
    expect(browser.signedExtrinsicDecoder(facts)(t.extrinsic)?.metadataHashMode).toBe(0);
  });

  it("left out when the runtime has no CheckMetadataHash extension", () => {
    const { registry } = encodeRuntime(facts);
    const ext = registry.createType("Extrinsic", fixture.transactions[0]!.extrinsic);
    expect((chain as any).metadataHashModeOf(ext, ["CheckNonce"])).toBeUndefined();
    expect((chain as any).metadataHashModeOf(ext, registry.signedExtensions)).toBe(0);
    expect((chain as any).metadataHashModeOf({}, ["CheckMetadataHash"])).toBeUndefined();
  });
});
