import { describe, expect, it } from "vitest";
import snapshotJson from "../../../public/v3/facts-snapshot.json";
import {
  discoverV3Facts,
  isFactsSnapshot,
  loadFactsSnapshot,
  type FactsSnapshot,
} from "../v3facts";
import { hasChainFacts } from "../host";

// Synthetic transport: values shaped like V3's answers. No network, no wallet.
const snap = snapshotJson as unknown as FactsSnapshot;
const fp = snap.facts.fingerprint;
const META = "0x6d657461" + "00".repeat(16);
const blake = (h: string) => "0x" + (h === META ? "ab" : "cd").repeat(32);
function rpc(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    chain_getBlockHash: fp.genesisHash,
    state_getRuntimeVersion: {
      specName: fp.specName,
      specVersion: fp.specVersion,
      transactionVersion: fp.transactionVersion,
    },
    state_getMetadata: META,
    chain_getFinalizedHead: "0x" + "11".repeat(32),
    chain_getHeader: { number: "0x191c1" },
    ...over,
  };
  const t = async (m: string) => {
    calls.push(m);
    if (answers[m] instanceof Error) throw answers[m];
    return answers[m];
  };
  return { t, calls };
}

describe("V3 facts snapshot", () => {
  it("is the recorded V3 spec 3002 snapshot, labelled, without metadata bytes", () => {
    expect(isFactsSnapshot(snap)).toBe(true);
    expect(snap.label).toMatch(/RECORDED SNAPSHOT/);
    expect(snap.recordedFrom).toMatch(/^evidence\/testnet-v3\/runs\//);
    expect(fp.specVersion).toBe(3002);
    expect(fp.specName).toBe("portaldot-v3");
    expect(fp.ss58Prefix).toBe(42);
    expect(fp.tokenSymbol).toBe("tPOT");
    expect(fp.tokenDecimals).toBe(14);
    // On its own it cannot install the live host: LIVE fails closed until metadata is read.
    expect(hasChainFacts(snap.facts)).toBe(false);
  });
  it("loader rejects a malformed or missing asset", async () => {
    const bad = (async () => new Response("{}")) as unknown as typeof fetch;
    expect(await loadFactsSnapshot(bad, "/x")).toBeUndefined();
    const down = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await loadFactsSnapshot(down, "/x")).toBeUndefined();
    const good = (async () => new Response(JSON.stringify(snap))) as unknown as typeof fetch;
    expect(await loadFactsSnapshot(good, "/x")).toBeTruthy();
  });
});

describe("discoverV3Facts", () => {
  it("binds live metadata to the snapshot and yields chain-shaped facts", async () => {
    const { t, calls } = rpc();
    const r = await discoverV3Facts(t, snap, blake);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(hasChainFacts(r.facts)).toBe(true);
    expect(r.facts.source.metadataHex).toBe(META);
    expect(r.facts.fingerprintDigest).toBe(snap.facts.fingerprintDigest);
    expect(r.report.provenance).toBe("snapshot_fingerprint_live_metadata");
    expect(r.report.finalizedBlock).toBe(0x191c1);
    expect(r.report.metadataHashMatchesSnapshot).toBe(false);
    // Read-only methods only.
    expect(calls.every((m) => /^(chain_get|state_get)/.test(m))).toBe(true);
  });
  it("does not mutate the snapshot", async () => {
    await discoverV3Facts(rpc().t, snap, blake);
    expect(snap.facts.source.metadataHex).toBe("0x");
  });
  it.each([
    ["genesis", { chain_getBlockHash: "0x" + "00".repeat(32) }, /genesis/],
    [
      "spec",
      {
        state_getRuntimeVersion: {
          specName: fp.specName,
          specVersion: 3003,
          transactionVersion: 2,
        },
      },
      /spec 3003/,
    ],
    [
      "tx version",
      {
        state_getRuntimeVersion: {
          specName: fp.specName,
          specVersion: 3002,
          transactionVersion: 3,
        },
      },
      /tx version/,
    ],
    ["no metadata", { state_getMetadata: "0x" }, /no metadata/],
  ])("fails closed on %s mismatch", async (_n, over, msg) => {
    const r = await discoverV3Facts(rpc(over).t, snap, blake);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("mismatch");
      expect(r.message).toMatch(msg);
    }
  });
  it("reports rpc errors without facts", async () => {
    const r = await discoverV3Facts(
      rpc({ state_getMetadata: new Error("HTTP 502") }).t,
      snap,
      blake,
    );
    expect(r).toMatchObject({ ok: false, reason: "rpc_error", message: "HTTP 502" });
  });
  it("refuses without a snapshot", async () => {
    const r = await discoverV3Facts(rpc().t, undefined, blake);
    expect(r).toMatchObject({ ok: false, reason: "bad_snapshot" });
  });
});
