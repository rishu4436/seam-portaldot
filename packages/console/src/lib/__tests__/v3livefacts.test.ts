// LIVE facts step with the REAL browser builder (@seam/chain/browser factsFromChainInputs) over the committed V3 spec-3002
// metadata, served by a mocked read-only RPC. No layout-hash values are hard-coded (that hash is still being narrowed).
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { factsFromChainInputs } from "@seam/chain/browser";
import { factsFromMetadata, computeFingerprintDigest } from "@seam/compiler";
import { discoverV3LiveFacts, type FactsBuilder, type FactsSnapshot } from "../v3facts";
import { hasChainFacts } from "../host";

const root = new URL("../../../../../", import.meta.url);
const META = fs
  .readFileSync(new URL("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex", root), "utf8")
  .trim();
const PROPS = JSON.parse(
  fs.readFileSync(new URL("evidence/v3-discovery/v3-properties.json", root), "utf8"),
);
const GEN = PROPS.genesisHash as string;
const RV = { specName: "portaldot-v3", specVersion: 3002, transactionVersion: 2 };
const HEAD = "0x" + "11".repeat(32);
const build = factsFromChainInputs as unknown as FactsBuilder;

const rpcWith =
  (over: Record<string, unknown> = {}, fail?: string) =>
  async (method: string): Promise<unknown> => {
    if (method === fail) throw new Error("socket hang up");
    if (method in over) return over[method];
    return (
      {
        chain_getBlockHash: GEN,
        state_getRuntimeVersion: RV,
        state_getMetadata: META,
        system_properties: PROPS.system_properties,
        chain_getFinalizedHead: HEAD,
        chain_getHeader: { number: "0x1f400" },
      } as Record<string, unknown>
    )[method];
  };

describe("discoverV3LiveFacts (live factsFromChainInputs)", () => {
  it("builds chain-shaped facts from the live reads, matching the Node-side compiler path", async () => {
    const r = await discoverV3LiveFacts(rpcWith(), build);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(hasChainFacts(r.facts)).toBe(true); // so loadLiveHost installs from real facts
    expect(r.report.provenance).toBe("live_chain_inputs");
    expect(r.report).toMatchObject({
      genesisHash: GEN,
      specVersion: 3002,
      finalizedBlock: 0x1f400,
    });
    const node = factsFromMetadata({
      metadataHex: META,
      genesisHash: GEN,
      tokenSymbol: "tPOT",
      tokenDecimals: 14,
      ss58Prefix: 42,
    });
    expect(r.facts.fingerprint.metadataHash).toBe(node.fingerprint.metadataHash);
    expect(r.facts.fingerprintDigest).toBe(computeFingerprintDigest(r.facts.fingerprint as never));
    expect(r.report.liveFingerprintDigest).toBe(r.facts.fingerprintDigest);
  });

  it("compares with the snapshot for display only", async () => {
    const snap = {
      label: "s",
      recordedFrom: "evidence/x",
      recordedAtBlock: 1,
      facts: {
        fingerprint: {
          genesisHash: GEN,
          specName: "portaldot-v3",
          specVersion: 3002,
          transactionVersion: 2,
          metadataHash: "0x00",
        },
        fingerprintDigest: "0x01",
        source: { metadataHex: "0x" },
      },
    } as FactsSnapshot;
    const r = await discoverV3LiveFacts(rpcWith(), build, { snapshot: snap });
    expect(r.ok && r.report).toMatchObject({
      snapshotFrom: "evidence/x",
      digestMatchesSnapshot: false,
    });
    expect(r.ok && r.facts.fingerprintDigest).not.toBe("0x01"); // the live digest is never replaced by the snapshot's
  });

  it("fails closed when the builder throws (e.g. node spec disagrees with its own metadata)", async () => {
    const r = await discoverV3LiveFacts(
      rpcWith({ state_getRuntimeVersion: { ...RV, specVersion: 9999 } }),
      build,
    );
    expect(r).toMatchObject({ ok: false, reason: "build_failed" });
  });

  it("fails closed on missing properties, bad metadata or an RPC error", async () => {
    expect(await discoverV3LiveFacts(rpcWith({ system_properties: null }), build)).toMatchObject({
      ok: false,
    });
    expect(await discoverV3LiveFacts(rpcWith({ state_getMetadata: "0x" }), build)).toMatchObject({
      ok: false,
    });
    expect(await discoverV3LiveFacts(rpcWith({}, "state_getMetadata"), build)).toMatchObject({
      ok: false,
      reason: "rpc_error",
    });
    const boom: FactsBuilder = () => {
      throw new Error("nope");
    };
    expect(await discoverV3LiveFacts(rpcWith(), boom)).toMatchObject({
      ok: false,
      reason: "build_failed",
    });
  });
});
