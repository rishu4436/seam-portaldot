// REAL metadata: the portaldot-v3 spec 3002 metadata read (read-only) from wss://test-node-v3.portaldot.dev on 2026-10-18,
// committed under evidence/v3-discovery. Preflight here runs OFFLINE against a FakeNode that serves that metadata; the node's
// fee/dry-run answers are the FakeNode's, so nothing below says a call would succeed on the real chain.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, type Manifest } from "@seam/compiler";
import {
  chainInputsFromSnapshot,
  decodeRuntime,
  factsFromChainInputs,
  preflight,
  type SnapshotJson,
} from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { ALICE } from "./helpers.js";

const ev = (n: string) =>
  fileURLToPath(new URL(`../../../evidence/v3-discovery/${n}`, import.meta.url));
const snap = JSON.parse(
  readFileSync(ev("portaldot-v3-spec3002-snapshot.json"), "utf8"),
) as SnapshotJson;
const hex = readFileSync(ev("portaldot-v3-spec3002-metadata.hex"), "utf8").trim();
const layouts = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/v3-testnet-spec3002-layouts.json", import.meta.url)),
    "utf8",
  ),
);
const inputs = chainInputsFromSnapshot(snap, hex);
const facts = factsFromChainInputs(inputs);
const manifest = (actions: Manifest["actions"]): Manifest => ({
  version: 1,
  signer: { type: "ss58", value: ALICE },
  actions,
});
const revive = {
  id: "rv",
  kind: "revive.call" as const,
  args: {
    contract: "0x1111111111111111111111111111111111111111",
    value: "0",
    data: "0x1234",
    gasLimit: "5000000000",
    proofSize: "1000000",
    storageDepositLimit: "100",
  },
};
const nft = {
  id: "nft",
  kind: "nfts.mint" as const,
  args: { collection: "1", item: "7", recipient: ALICE },
};

describe("REAL V3 testnet metadata (spec 3002)", () => {
  it("system properties recorded in the snapshot are what the node reported", () => {
    expect(snap.properties).toEqual({ ss58Format: 42, tokenDecimals: 14, tokenSymbol: "tPOT" });
    expect(snap.runtime.specVersion).toBe(3002);
  });
  it("committed layout fixture matches the live metadata", () => {
    expect(layouts.metadataVersion).toBe(14);
    expect(layouts.calls["Revive.call"].fields.map((f: { name: string }) => f.name)).toEqual([
      "dest",
      "value",
      "weight_limit",
      "storage_deposit_limit",
      "data",
    ]);
    expect(layouts.calls["Revive.call"].fields[0].type.path).toBe("primitive_types::H160");
    expect(layouts.calls["Nfts.mint"].fields.map((f: { name: string }) => f.name)).toEqual([
      "collection",
      "item",
      "mint_to",
      "witness_data",
    ]);
    const dec = decodeRuntime(facts).decorated().tx as unknown as Record<
      string,
      Record<string, { meta: { args: { name: { toString(): string } }[] } }>
    >;
    expect(dec.revive!.call!.meta.args.map((a) => a.name.toString())).toEqual([
      "dest",
      "value",
      "weightLimit",
      "storageDepositLimit",
      "data",
    ]);
  });
  it("revive.call: compiler refuses with V3_ARG_SHAPE_MISMATCH purely on the argument NAME weightLimit vs gasLimit; preflight passes it through", async () => {
    const plan = compile(manifest([revive]), facts);
    expect(plan.steps[0]).toMatchObject({
      status: "unavailable",
      reasonCode: "V3_ARG_SHAPE_MISMATCH",
    });
    expect(plan.steps[0]!.reason).toContain(
      'argument 2 should be "gasLimit" (weight), metadata has "weightLimit"',
    );
    const node = new FakeNode({ inputs, facts });
    const r = await preflight(node, plan, facts, { nonce: 0 });
    expect(r.coverage.steps[0]).toEqual({
      actionId: "rv",
      basis: "unobserved",
      proves: "nothing",
      reasonCode: "V3_ARG_SHAPE_MISMATCH",
    });
    expect(r.coverage.wholePlan).toBe("none");
    expect(r.v3!.steps[0]).toMatchObject({
      compiler: "unavailable",
      simulation: { attempted: false, via: [] },
    });
    // map_account exists in the real metadata, but nothing proves the signer is mapped.
    expect(r.v3!.accountMapping).toMatchObject({ status: "unknown", mapAccountInMetadata: true });
  });
  it("nfts.mint: the compiler encodes it, but preflight still says unobserved / proves nothing", async () => {
    const plan = compile(manifest([nft]), facts);
    expect(plan.steps[0]!.status).toBe("ok");
    const r = await preflight(new FakeNode({ inputs, facts }), plan, facts, { nonce: 0 });
    expect(r.coverage.steps[0]).toMatchObject({
      actionId: "nft",
      basis: "unobserved",
      proves: "nothing",
    });
    expect(r.coverage.wholePlan).toBe("none");
    expect(r.v3!.accountMapping).toBeUndefined();
  });
});
