// Rollback proofs matched on the metadata layout hash (storage defaults blanked). Uses the real V3 spec 3002
// atomic run (#102671), whose proof was taken on raw metadata 0x1c8226…, and the committed spec 3002 blob
// (raw 0x1840e6…, read a day earlier): the same runtime layout, different raw bytes. Offline.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compile,
  computePlanDigest,
  factsFromMetadata,
  metadataLayout,
  metadataLayoutHash,
  SeamCompileError,
  type AtomicRollbackProof,
  type Manifest,
  type RuntimeFacts,
} from "../src/index.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const v3Hex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const mainnetHex = readFileSync(
  fileURLToPath(new URL("../fixtures/portaldot-mainnet-metadata.hex", import.meta.url)),
  "utf8",
).trim();
const rec = JSON.parse(
  readFileSync(root("evidence/testnet-v3/runs/plan-atomic-1792411355057.json"), "utf8"),
);
const manifest = rec.manifest as Manifest;
const recorded: AtomicRollbackProof = rec.facts.behaviour.batchAllRollbackProof;
const fp = rec.facts.fingerprint;
/** Same value @seam/chain's metadataLayoutHash gives for every spec 3002 blob read so far. */
const V3_LAYOUT = "0x221ba8f7dd81e0341fca9f0074a3e433659c97300cbbb2f874dbd5f0d998b304";

function facts(proof: unknown, hex = v3Hex, extra: object = {}): RuntimeFacts {
  return factsFromMetadata({
    metadataHex: hex,
    genesisHash: fp.genesisHash,
    tokenSymbol: fp.tokenSymbol,
    tokenDecimals: fp.tokenDecimals,
    batchAllRollback: "verified",
    batchAllRollbackProof: proof as AtomicRollbackProof,
    ...extra,
  });
}
const batchCap = rec.facts.capabilities["Utility.batch_all"];
const withLayout = (over: Partial<AtomicRollbackProof> = {}): AtomicRollbackProof => ({
  ...recorded,
  specName: "portaldot-v3",
  transactionVersion: fp.transactionVersion,
  ss58Prefix: fp.ss58Prefix,
  batchAll: { palletIndex: batchCap.palletIndex, callIndex: batchCap.callIndex },
  metadataLayoutHash: V3_LAYOUT as AtomicRollbackProof["metadataLayoutHash"],
  ...over,
});

/** The V3 blob with one doc-string letter changed: decodes fine, but a real (non-storage-default) layout change. */
function layoutChangedHex(): string {
  const needle = Buffer.from("Revive", "utf8").toString("hex");
  const at = v3Hex.indexOf(needle, 1000);
  expect(at).toBeGreaterThan(0);
  const patched = Buffer.from("Revivf", "utf8").toString("hex");
  return v3Hex.slice(0, at) + patched + v3Hex.slice(at + needle.length);
}

describe("metadataLayoutHash (compiler port)", () => {
  it("matches @seam/chain's value for the real spec 3002 blob, and normalizes", () => {
    expect(metadataLayout(v3Hex)).toEqual({ hash: V3_LAYOUT, normalized: true });
  });
  it("is deterministic and differs for a different runtime", () => {
    expect(metadataLayoutHash(v3Hex)).toBe(metadataLayoutHash(` ${v3Hex}\n`));
    expect(metadataLayoutHash(mainnetHex)).not.toBe(V3_LAYOUT);
  });
  it("a real layout change (doc text) changes it", () => {
    expect(metadataLayoutHash(layoutChangedHex())).not.toBe(V3_LAYOUT);
  });
  it("fails closed to the raw domain when the bytes cannot be decoded and rebuilt", () => {
    const junk = "0x6d657461" + "0e" + "00ff";
    const r = metadataLayout(junk);
    expect(r.normalized).toBe(false);
    expect(r.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(metadataLayout(junk + "00").hash).not.toBe(r.hash);
  });
});

describe("facts.metadataLayoutHash is opt-in and outside every digest", () => {
  it("withLayoutHash changes no fingerprint or plan digest", () => {
    const a = facts(withLayout());
    const b = facts(withLayout(), v3Hex, { withLayoutHash: true });
    expect(a.metadataLayoutHash).toBeUndefined();
    expect(b.metadataLayoutHash).toBe(V3_LAYOUT);
    expect(b.fingerprint).toEqual(a.fingerprint);
    expect(b.fingerprintDigest).toBe(a.fingerprintDigest);
    const pa = compile(manifest, a);
    const pb = compile(manifest, b);
    expect(pb.planDigest).toBe(pa.planDigest);
    expect(computePlanDigest(pb)).toBe(pa.planDigest);
  });
  it("a facts.metadataLayoutHash that does not match the bytes is FACTS_INVALID", () => {
    const f = { ...facts(withLayout()), metadataLayoutHash: `0x${"11".repeat(32)}` as const };
    expect(() => compile(manifest, f as RuntimeFacts)).toThrow(SeamCompileError);
  });
});

describe("rollback proof accepted on layout hash", () => {
  it("fresh V3 compile is atomic_verified when the proof carries the matching layout hash", () => {
    const f = facts(withLayout());
    expect(f.fingerprint.metadataHash).not.toBe(recorded.metadataHash); // real raw drift
    const p = compile(manifest, f);
    expect(p.mode).toBe("atomic_verified");
    expect(p.modeReason).toContain(
      "accepted on layout hash; raw metadata differs only in storage defaults",
    );
    expect(p.rollbackProofBasis).toBe("layout_hash");
    // The basis is covered by the plan digest.
    expect(computePlanDigest({ ...p, rollbackProofBasis: undefined })).not.toBe(p.planDigest);
    expect(computePlanDigest(p)).toBe(p.planDigest);
    // Same calls as the recorded atomic run.
    expect(p.steps.map((s) => s.encodedCall)).toEqual(
      rec.plan.steps.map((s: { encodedCall: string }) => s.encodedCall),
    );
  });

  it("raw hash equal: the strict path, with the usual reason text", () => {
    const f0 = facts(undefined);
    const proof = withLayout({
      metadataHash: f0.fingerprint.metadataHash,
      fingerprintDigest: undefined,
    });
    const p = compile(manifest, facts(proof));
    expect(p.mode).toBe("atomic_verified");
    expect(p.modeReason).not.toContain("layout hash");
    expect("rollbackProofBasis" in p).toBe(false); // raw_hash basis: field absent, digest as before
  });

  const rejected = (proof: unknown, hex = v3Hex, re: RegExp) => {
    const p = compile(manifest, facts(proof, hex));
    expect(p.mode).not.toBe("atomic_verified");
    expect(p.modeReason).toMatch(re);
  };

  it("a real layout change is rejected", () =>
    rejected(
      withLayout(),
      layoutChangedHex(),
      /metadata layout differs, not just storage defaults/,
    ));
  it("a layout hash of another runtime is rejected", () =>
    rejected(
      withLayout({ metadataLayoutHash: metadataLayoutHash(mainnetHex) }),
      v3Hex,
      /metadataLayoutHash .* is not this runtime's/,
    ));
  it("a different genesis is rejected", () =>
    rejected(
      withLayout({ genesisHash: `0x${"ab".repeat(32)}` as AtomicRollbackProof["genesisHash"] }),
      v3Hex,
      /genesisHash .* is not this chain/,
    ));
  it("a different spec version is rejected", () =>
    rejected(withLayout({ specVersion: 3001 }), v3Hex, /specVersion 3001 is not this runtime's/));
  it("a different spec name is rejected", () =>
    rejected(
      withLayout({ specName: "portaldot" }),
      v3Hex,
      /specName portaldot is not this runtime's/,
    ));
  it("no spec name on the layout path is rejected", () =>
    rejected(withLayout({ specName: undefined }), v3Hex, /specName is required/));
  it("a composition missing a kind of the plan is rejected", () =>
    rejected(
      withLayout({ composition: ["assets.transfer", "assets.mint"] }),
      v3Hex,
      /this plan also uses nfts\.mint/,
    ));
  it("no layout hash in the proof: strict raw-hash binding", () =>
    rejected(
      withLayout({ metadataLayoutHash: undefined }),
      v3Hex,
      /rollback proof is rejected: metadataHash/,
    ));
  it("matching layout hash on a different genesis is rejected", () =>
    rejected(
      withLayout({ genesisHash: `0x${"cd".repeat(32)}` as AtomicRollbackProof["genesisHash"] }),
      v3Hex,
      /genesisHash .* is not this chain/,
    ));
  it("matching layout hash on a different spec is rejected", () =>
    rejected(withLayout({ specVersion: 3003 }), v3Hex, /specVersion 3003 is not this runtime's/));
  it("a mismatched transactionVersion is rejected", () =>
    rejected(
      withLayout({ transactionVersion: 3 }),
      v3Hex,
      /transactionVersion 3 is not this runtime's/,
    ));
  it("a missing transactionVersion is rejected", () =>
    rejected(
      withLayout({ transactionVersion: undefined }),
      v3Hex,
      /transactionVersion is required/,
    ));
  it("a mismatched ss58Prefix is rejected", () =>
    rejected(withLayout({ ss58Prefix: 0 }), v3Hex, /ss58Prefix 0 is not this runtime's/));
  it("a missing ss58Prefix is rejected", () =>
    rejected(withLayout({ ss58Prefix: undefined }), v3Hex, /ss58Prefix is required/));
  it("mismatched batch_all indices are rejected", () =>
    rejected(
      withLayout({
        batchAll: { palletIndex: batchCap.palletIndex, callIndex: batchCap.callIndex + 1 },
      }),
      v3Hex,
      /Utility\.batch_all indices .* are not this runtime's/,
    ));
  it("missing batch_all indices are rejected", () =>
    rejected(withLayout({ batchAll: undefined }), v3Hex, /batchAll \{ palletIndex, callIndex \}/));
  it("undecodable metadata never gives atomic", () => {
    const f = facts(withLayout());
    const bad = { ...f, source: { ...f.source, metadataHex: "0x6d657461ff" } } as RuntimeFacts;
    let mode: string | undefined;
    try {
      mode = compile(manifest, bad).mode;
    } catch (e) {
      expect(e).toBeInstanceOf(SeamCompileError);
    }
    expect(mode).not.toBe("atomic_verified");
  });
  it("a single-step plan never records a proof basis", () => {
    const one = { ...manifest, actions: manifest.actions.slice(0, 1) };
    const p = compile(one, facts(withLayout()));
    expect(p.mode).toBe("sequential");
    expect("rollbackProofBasis" in p).toBe(false);
  });
});
