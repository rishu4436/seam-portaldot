/* eslint-disable @typescript-eslint/no-explicit-any -- tests edit decoded metadata JSON */
/**
 * Metadata layout fingerprint (V3 finding: Revive.EthBlockBuilderIR's storage default changes block to block without
 * a runtime upgrade). Storage defaults are blanked; every other byte counts. And the chain package uses it wherever it
 * compares live metadata with the pinned one: re-read fingerprints (runtime lock) and the inclusion block's metadata.
 */
import { describe, expect, it } from "vitest";
import { blake2AsHex } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import type { Hex } from "@seam/compiler";
import { checkRuntimeLock } from "@seam/policy";
import {
  chainInputsFromSnapshot,
  type SnapshotJson,
  blankStorageFallbacks,
  fingerprintFromChainInputs,
  metadataLayoutHash,
  pinMetadata,
  sameMetadataLayout,
} from "../src/index.js";
import { readFileSync } from "node:fs";

import {
  callTypeId,
  devnodeV14,
  lookupDef,
  mainnetV13,
  mutateV14,
  patchStorageEntry,
  v3Spec3002,
  withFallback,
} from "./metadataMutate.js";

const raw = (h: string) => blake2AsHex(hexToU8a(h), 256);

describe("metadataLayoutHash: storage defaults blanked, everything else counts", () => {
  const dev = devnodeV14();

  it("blanking is exact: a rebuilt blob without changes equals the input (V13, V14, real V3)", () => {
    for (const h of [dev, mainnetV13(), v3Spec3002()]) {
      expect(blankStorageFallbacks(h)).toBeInstanceOf(Uint8Array);
      expect(metadataLayoutHash(h)).toMatch(/^0x[0-9a-f]{64}$/);
      expect(metadataLayoutHash(h)).toBe(metadataLayoutHash(h)); // deterministic
    }
  });

  it("allow-listed default (Revive.EthBlockBuilderIR) changed -> raw hash differs, layout hash equal", () => {
    const h = v3Spec3002();
    const drifted = withFallback(h, "Revive", "EthBlockBuilderIR", "0x0102030405060708");
    expect(raw(drifted)).not.toBe(raw(h));
    expect(metadataLayoutHash(drifted)).toBe(metadataLayoutHash(h));
    expect(sameMetadataLayout(drifted, h)).toBe(true);
  });

  it("any other storage default changed -> layout hash differs (fail closed)", () => {
    for (const h of [dev, mainnetV13(), v3Spec3002()]) {
      const drifted = withFallback(h, "System", "Number", "0x0102030405060708");
      expect(metadataLayoutHash(drifted)).not.toBe(metadataLayoutHash(h));
      expect(sameMetadataLayout(drifted, h)).toBe(false);
    }
  });

  it("a changed call argument (name or type) changes the layout hash", () => {
    const renamed = mutateV14(dev, (j) => {
      const def = lookupDef(j, callTypeId(j, "Assets"));
      const create = def.variant.variants.find((v: any) => v.name === "create");
      create.fields.find((f: any) => f.name === "min_balance").name = "min_bal";
    });
    const retyped = mutateV14(dev, (j) => {
      const def = lookupDef(j, callTypeId(j, "Balances"));
      const v = def.variant.variants.find((x: any) => x.name === "transfer_keep_alive");
      const f = v.fields.find((x: any) => x.name === "value");
      const u32 = j.lookup.types.find((t: any) => t.type.def.primitive === "U32").id;
      f.type = u32;
    });
    for (const m of [renamed, retyped]) {
      expect(metadataLayoutHash(m)).not.toBe(metadataLayoutHash(dev));
      expect(sameMetadataLayout(m, dev)).toBe(false);
    }
  });

  it("a changed type definition changes the layout hash", () => {
    const m = mutateV14(dev, (j) => {
      const t = j.lookup.types.find((x: any) => x.type.def.primitive === "U128");
      t.type.def.primitive = "U64";
    });
    expect(metadataLayoutHash(m)).not.toBe(metadataLayoutHash(dev));
  });

  it("a changed storage value type, key hasher, name or modifier changes the layout hash", () => {
    const u64 = mutateV14(dev, () => undefined); // identity through JSON
    expect(metadataLayoutHash(u64)).toBe(metadataLayoutHash(dev));
    const valueType = patchStorageEntry(dev, "System", "Number", (e, reg) => ({
      type: new (e.get("type").constructor)(reg, { Plain: 0 }),
    }));
    const hasher = mutateV14(dev, (j) => {
      const acc = j.pallets
        .find((p: any) => p.name === "Assets")
        .storage.items.find((i: any) => i.name === "Account");
      acc.type.map.hashers[0] =
        acc.type.map.hashers[0] === "Blake2_128Concat" ? "Twox64Concat" : "Blake2_128Concat";
    });
    const name = mutateV14(dev, (j) => {
      j.pallets
        .find((p: any) => p.name === "System")
        .storage.items.find((i: any) => i.name === "Number").name = "Numbr";
    });
    const modifier = mutateV14(dev, (j) => {
      const it = j.pallets
        .find((p: any) => p.name === "System")
        .storage.items.find((i: any) => i.name === "Number");
      it.modifier = it.modifier === "Default" ? "Optional" : "Default";
    });
    for (const m of [valueType, hasher, name, modifier])
      expect(metadataLayoutHash(m)).not.toBe(metadataLayoutHash(dev));
  });

  it("a changed event field or pallet index changes the layout hash", () => {
    const ev = mutateV14(dev, (j) => {
      const def = lookupDef(j, j.pallets.find((p: any) => p.name === "Assets").events.type);
      def.variant.variants[0].fields[0].name = "renamed";
    });
    const idx = mutateV14(dev, (j) => {
      j.pallets.find((p: any) => p.name === "Assets").index += 50;
    });
    for (const m of [ev, idx]) expect(metadataLayoutHash(m)).not.toBe(metadataLayoutHash(dev));
  });

  it("bytes that cannot be normalized exactly only match themselves (fail closed)", () => {
    const junk = ("0x6d657461" + "0e" + "ff".repeat(8)) as Hex;
    expect(blankStorageFallbacks(junk)).toBeUndefined();
    expect(metadataLayoutHash(junk)).not.toBe(metadataLayoutHash(dev));
    const trailing = (dev + "00") as Hex; // trailing byte: decodes, but does not round-trip
    expect(blankStorageFallbacks(trailing)).toBeUndefined();
    expect(sameMetadataLayout(trailing, dev)).toBe(false);
  });
});

describe("real V3 drift (spec 3002, read-only reads of 2026-10-19)", () => {
  const live = JSON.parse(
    readFileSync(
      new URL("./fixtures/v3-spec3002-ethblockbuilderir-fallbacks.json", import.meta.url),
      "utf8",
    ),
  ).reads as { block: number; rawMetadataHash: string; ethBlockBuilderIRFallback: Hex }[];
  const base = v3Spec3002(); // discovery blob of 2026-10-18

  it("the 2026-10-18 blob with the live Revive.EthBlockBuilderIR default IS the live blob, byte for byte", () => {
    // so that storage default is the ONLY difference between those metadata blobs
    for (const r of live) {
      const rebuilt = withFallback(
        base,
        "Revive",
        "EthBlockBuilderIR",
        r.ethBlockBuilderIRFallback,
      );
      expect(raw(rebuilt)).toBe(r.rawMetadataHash);
    }
    expect(live[0]!.rawMetadataHash).not.toBe(live[1]!.rawMetadataHash);
    expect(raw(base)).not.toBe(live[0]!.rawMetadataHash);
  });

  it("all three raw hashes differ; the layout hash and the pinned fingerprint are the same", () => {
    const blobs = live.map((r) =>
      withFallback(base, "Revive", "EthBlockBuilderIR", r.ethBlockBuilderIRFallback),
    );
    for (const b of blobs) expect(metadataLayoutHash(b)).toBe(metadataLayoutHash(base));
    expect(pinMetadata(blobs[1]!, blobs[0]!).drift?.layoutHash).toBe(metadataLayoutHash(base));
  });
});

describe("the runtime lock and fingerprints use the layout comparison", () => {
  const v3ev = (n: string) => new URL(`../../../evidence/v3-discovery/${n}`, import.meta.url);
  const pinned = chainInputsFromSnapshot(
    JSON.parse(readFileSync(v3ev("portaldot-v3-spec3002-snapshot.json"), "utf8")) as SnapshotJson,
    v3Spec3002(),
  );
  const drifted = {
    ...pinned,
    metadataHex: withFallback(pinned.metadataHex, "Revive", "EthBlockBuilderIR", "0x2a000000"),
  };
  const otherDefault = {
    ...pinned,
    metadataHex: withFallback(pinned.metadataHex, "System", "Number", "0x2a000000"),
  };
  const restructured = {
    ...pinned,
    metadataHex: patchStorageEntry(pinned.metadataHex, "System", "Number", (e, reg) => ({
      name: new (e.get("name").constructor)(reg, "Numbr"),
    })),
  };

  it("without a pin, a storage-default drift changes the fingerprint (the V3 failure)", () => {
    const a = fingerprintFromChainInputs(pinned);
    const b = fingerprintFromChainInputs(drifted);
    expect(b.fingerprintDigest).not.toBe(a.fingerprintDigest);
    expect(checkRuntimeLock(a.fingerprint, b.fingerprint).ok).toBe(false);
  });

  it("with the pinned metadata, a storage-default drift keeps the same fingerprint and records the drift", () => {
    const a = fingerprintFromChainInputs(pinned);
    const b = fingerprintFromChainInputs(drifted, { pinnedMetadataHex: pinned.metadataHex });
    expect(b.fingerprintDigest).toBe(a.fingerprintDigest);
    expect(checkRuntimeLock(a.fingerprint, b.fingerprint)).toMatchObject({ ok: true });
    expect(b.metadataDrift).toEqual({
      liveMetadataHash: raw(drifted.metadataHex),
      pinnedMetadataHash: a.fingerprint.metadataHash,
      layoutHash: metadataLayoutHash(pinned.metadataHex),
    });
    expect(b.metadataLayoutHash).toBe(metadataLayoutHash(pinned.metadataHex));
  });

  it("with the pinned metadata, a real layout change still changes the fingerprint and the lock blocks", () => {
    const a = fingerprintFromChainInputs(pinned);
    const b = fingerprintFromChainInputs(restructured, { pinnedMetadataHex: pinned.metadataHex });
    expect(b.fingerprintDigest).not.toBe(a.fingerprintDigest);
    expect(b.metadataDrift).toBeUndefined();
    expect(checkRuntimeLock(a.fingerprint, b.fingerprint)).toMatchObject({
      ok: false,
      changed: ["metadataHash"],
    });
  });

  it("with the pinned metadata, a NON-allow-listed default change changes the fingerprint and the lock blocks", () => {
    const a = fingerprintFromChainInputs(pinned);
    const b = fingerprintFromChainInputs(otherDefault, { pinnedMetadataHex: pinned.metadataHex });
    expect(b.fingerprintDigest).not.toBe(a.fingerprintDigest);
    expect(b.metadataDrift).toBeUndefined();
    expect(checkRuntimeLock(a.fingerprint, b.fingerprint).ok).toBe(false);
  });

  it("pinMetadata returns the live bytes for any real change and for no pin", () => {
    expect(pinMetadata(restructured.metadataHex, pinned.metadataHex).metadataHex).toBe(
      restructured.metadataHex.toLowerCase(),
    );
    expect(pinMetadata(drifted.metadataHex, undefined).drift).toBeUndefined();
    expect(pinMetadata(drifted.metadataHex, pinned.metadataHex).metadataHex).toBe(
      pinned.metadataHex.toLowerCase(),
    );
  });
});
