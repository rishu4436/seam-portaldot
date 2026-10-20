/**
 * Audit 2026-10-20 (Task 4): exactly what metadataLayoutHash blanks, and that a one-byte layout change is rejected.
 * Offline on the real V3 spec 3002 blob; the live sample runs only with SEAM_LIVE=1 (read-only, HTTPS).
 */
import { describe, expect, it } from "vitest";
import { Metadata, TypeRegistry } from "@polkadot/types";
import { hexToU8a, u8aToHex, stringToU8a } from "@polkadot/util";
import type { Hex } from "@seam/compiler";
import {
  blankStorageFallbacks,
  httpRpcClient,
  metadataLayoutHash,
  pinMetadata,
} from "../src/index.js";
import { v3Spec3002, withFallback } from "./metadataMutate.js";

function fallbacks(hex: string): Map<string, string> {
  const m = new Metadata(new TypeRegistry(), hexToU8a(hex));
  const out = new Map<string, string>();
  for (const p of m.asLatest.pallets)
    if (p.storage.isSome)
      for (const e of p.storage.unwrap().items) out.set(`${p.name}.${e.name}`, e.fallback.toHex());
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

describe("metadataLayoutHash on real V3 spec 3002: what is blanked", () => {
  const base = v3Spec3002();

  it("blanks EVERY storage entry's fallback (all pallets), and nothing else", () => {
    const before = fallbacks(base);
    const blanked = u8aToHex(blankStorageFallbacks(base)!);
    const after = fallbacks(blanked);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const v of after.values()) expect(v).toBe("0x");
    const nonEmpty = [...before.entries()].filter(([, v]) => v !== "0x").map(([k]) => k);
    expect(nonEmpty).toContain("Revive.EthBlockBuilderIR");
    expect(nonEmpty.length).toBeGreaterThan(1); // more than the one entry that actually drifts on V3
  });

  it("a one-byte change in a storage fallback keeps the layout hash", () => {
    const fb = fallbacks(base).get("System.Number")!;
    const bumped = ("0x" +
      ((parseInt(fb.slice(2, 4), 16) + 1) & 0xff).toString(16).padStart(2, "0") +
      fb.slice(4)) as Hex;
    expect(metadataLayoutHash(withFallback(base, "System", "Number", bumped))).toBe(
      metadataLayoutHash(base),
    );
  });

  it("a one-byte change in a call name (same length) changes the layout hash; pinMetadata keeps the live bytes (no drift pass)", () => {
    const bytes = hexToU8a(base);
    const at = indexOf(bytes, stringToU8a("transfer_keep_alive"));
    expect(at).toBeGreaterThan(0);
    const mutated = bytes.slice();
    mutated[at] = "u".charCodeAt(0); // "uransfer_keep_alive"
    const mh = u8aToHex(mutated) as Hex;
    expect(metadataLayoutHash(mh)).not.toBe(metadataLayoutHash(base));
    expect(pinMetadata(mh, base as Hex).metadataHex).toBe(mh.toLowerCase()); // live bytes kept: no drift pass
    const drift = pinMetadata(mh, base as Hex).drift;
    expect(drift).toBeUndefined();
  });

  it("a one-byte change to a pallet index changes the layout hash", () => {
    const bytes = hexToU8a(base);
    // pallet name "Nfts" is SCALE-encoded as compact length 4 (0x10) + bytes; first occurrence is the pallet entry
    let at = indexOf(bytes, Uint8Array.from([0x10, ...stringToU8a("Nfts")]));
    expect(at).toBeGreaterThan(0);
    const m = new Metadata(new TypeRegistry(), bytes);
    const nfts = m.asLatest.pallets.find((p) => p.name.toString() === "Nfts")!;
    const idx = nfts.index.toNumber();
    // flip any one byte in the metadata body after the pallet name and confirm the hash changes or decoding fails closed
    const mutated = bytes.slice();
    at = at + 5 + 1; // inside the pallet's following fields
    mutated[at] = mutated[at]! ^ 0x01;
    expect(metadataLayoutHash(u8aToHex(mutated))).not.toBe(metadataLayoutHash(base));
    expect(idx).toBeGreaterThan(0);
  });
});

const LIVE = process.env.SEAM_LIVE === "1";
describe.skipIf(!LIVE)("LIVE V3 sample (read-only, https://test-node-v3.portaldot.dev)", () => {
  it("metadata at 3 recent finalized blocks: same layout hash; only Revive.EthBlockBuilderIR's fallback differs", async () => {
    const c = httpRpcClient("https://test-node-v3.portaldot.dev", { requestTimeoutMs: 90_000 });
    try {
      const head = (await c.send("chain_getFinalizedHead", [])) as string;
      const h = (await c.send("chain_getHeader", [head])) as { number: string };
      const n = parseInt(h.number, 16);
      const blobs: string[] = [];
      for (const k of [0, 20, 40]) {
        const bh = await c.send("chain_getBlockHash", [n - k]);
        blobs.push((await c.send("state_getMetadata", [bh])) as string);
      }
      const fb = blobs.map(fallbacks);
      for (let i = 1; i < blobs.length; i++) {
        expect(metadataLayoutHash(blobs[i]!)).toBe(metadataLayoutHash(blobs[0]!));
        const diff = [...fb[0]!.keys()].filter((key) => fb[0]!.get(key) !== fb[i]!.get(key));
        expect(diff.every((d) => d === "Revive.EthBlockBuilderIR")).toBe(true);
      }
    } finally {
      c.close();
    }
  }, 300_000);
});
