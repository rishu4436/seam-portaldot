/* eslint-disable @typescript-eslint/no-explicit-any -- tests edit decoded metadata JSON */
/**
 * liveCapabilities: per SEAM action, supported or not on a runtime, from that runtime's own metadata (P0-01).
 * Offline on the real V3 spec 3002 and mainnet spec 1002 fixtures; verdicts are cross-checked against the compiler.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, readPinnedTypes, type Manifest } from "@seam/compiler";
import { V3_SHAPES } from "../../compiler/src/v3-bindings.js";
import { KIND_TO_CAPABILITY } from "../../compiler/src/compile.js";
import * as browser from "../src/browser.js";
import {
  ACTION_CAPABILITY,
  ACTION_SHAPES,
  SEAM_ACTION_KINDS,
  chainInputsFromSnapshot,
  factsFromChainInputs,
  fingerprintFromChainInputs,
  liveCapabilities,
  readLiveCapabilities,
  type ChainInputs,
  type SnapshotJson,
} from "../src/index.js";
import { ALICE, snapshotInputs } from "./helpers.js";
import { callTypeId, lookupDef, mutateV14 } from "./metadataMutate.js";

const ev = (n: string) =>
  fileURLToPath(new URL(`../../../evidence/v3-discovery/${n}`, import.meta.url));
const v3Snap = JSON.parse(
  readFileSync(ev("portaldot-v3-spec3002-snapshot.json"), "utf8"),
) as SnapshotJson;
const v3Hex = readFileSync(
  ev("portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim() as `0x${string}`;
const v3Inputs = (): ChainInputs => chainInputsFromSnapshot(v3Snap, v3Hex);
const withMeta = (m: `0x${string}`): ChainInputs => ({ ...v3Inputs(), metadataHex: m });

const PROBE: Record<string, Record<string, unknown>> = {
  "assets.transfer": { assetId: "1", amount: "1", recipient: ALICE },
  "assets.mint": { assetId: "1", amount: "1", recipient: ALICE },
  "nfts.mint": { collection: "0", item: "1", recipient: ALICE },
  "revive.call": {
    contract: "0x" + "11".repeat(20),
    value: "0",
    gasLimit: "1000",
    proofSize: "1000",
    storageDepositLimit: "0",
    data: "0x",
  },
  "revive.instantiate_with_code": {
    value: "0",
    gasLimit: "1000",
    proofSize: "1000",
    storageDepositLimit: "0",
    code: "0x00",
    data: "0x",
  },
  "revive.map_account": {},
  "contracts.call": {
    contract: ALICE,
    value: "0",
    gasLimit: "1000",
    proofSize: "1000",
    storageDepositLimit: "0",
    data: "0x00",
  },
};

/** The compiler's own verdict for one kind on these facts: "ok" or the step's reason code / reason. */
function compilerVerdict(facts: any, kind: string): string {
  return compilerStep(facts, kind).verdict;
}
function compilerStep(facts: any, kind: string): { verdict: string; code?: string } {
  const m: Manifest = {
    version: 1,
    signer: { type: "ss58", value: ALICE },
    actions: [{ id: "a", kind: kind as any, args: PROBE[kind] as any }],
  };
  try {
    const step = compile(m, facts).steps[0]!;
    return step.status === "ok"
      ? { verdict: "ok" }
      : { verdict: step.reason ?? "unavailable", code: step.reasonCode };
  } catch (e) {
    return { verdict: `error: ${(e as Error).message}` };
  }
}

describe("liveCapabilities on real V3 spec 3002 metadata", () => {
  const caps = liveCapabilities(v3Inputs());

  it("fingerprint, digest and layout hash are the discovery path's", () => {
    const fp = fingerprintFromChainInputs(v3Inputs());
    expect(caps.fingerprint).toEqual(fp.fingerprint);
    expect(caps.fingerprintDigest).toBe(fp.fingerprintDigest);
    expect(caps.metadataLayoutHash).toBe(fp.metadataLayoutHash);
    expect(caps.fingerprint.specVersion).toBe(3002);
  });

  it("Assets, Revive, Nfts and (pallet-contracts, present on V3) Contracts supported, indices from the metadata", () => {
    const a = caps.actions;
    for (const k of [
      "assets.transfer",
      "assets.mint",
      "revive.call",
      "revive.instantiate_with_code",
      "revive.map_account",
    ] as const)
      expect(a[k]).toMatchObject({ supported: true, presence: "observed" });
    expect(a["revive.instantiate_with_code"]).toMatchObject({ palletIndex: 80, callIndex: 3 });
    expect(a["revive.map_account"]).toMatchObject({ palletIndex: 80, callIndex: 7, args: [] });
    expect(a["assets.transfer"]).toMatchObject({ palletIndex: 39, callIndex: 9 });
    // spec 3002 does ship pallet-contracts (index 21), with storage_deposit_limit and Weight v2.
    expect(a["contracts.call"]).toMatchObject({ supported: true, palletIndex: 21, callIndex: 6 });
    expect(a["nfts.mint"]).toMatchObject({ supported: true, palletIndex: 47, callIndex: 3 });
    expect(a["revive.call"].args.map((x) => x.name)).toEqual([
      "dest",
      "value",
      "weightLimit",
      "storageDepositLimit",
      "data",
    ]);
  });

  it("every verdict agrees with the compiler on the same facts", () => {
    const facts = factsFromChainInputs(v3Inputs());
    for (const k of SEAM_ACTION_KINDS)
      expect([k, compilerVerdict(facts, k) === "ok"]).toEqual([k, caps.actions[k].supported]);
  });

  it("browser entry gives the same result", () => {
    expect(browser.liveCapabilities(v3Inputs())).toEqual(caps);
  });
});

describe("liveCapabilities on mainnet spec 1002 (metadata V13)", () => {
  it("needs the pinned types file (fails closed without it)", () => {
    expect(() => liveCapabilities(snapshotInputs())).toThrow(/pinned types|typesBundle/);
  });
  it("Revive and Nfts absent; each verdict agrees with the compiler", () => {
    const typesBundle = readPinnedTypes();
    const caps = liveCapabilities(snapshotInputs(), { typesBundle });
    expect(caps.fingerprint.specVersion).toBe(1002);
    for (const k of ["revive.call", "nfts.mint"] as const)
      expect(caps.actions[k]).toMatchObject({
        presence: "pallet_missing",
        supported: false,
        reasonCode: "NO_OBSERVED_V3_METADATA",
      });
    const facts = factsFromChainInputs(snapshotInputs(), { typesBundle });
    for (const k of SEAM_ACTION_KINDS)
      expect([k, compilerVerdict(facts, k) === "ok"]).toEqual([k, caps.actions[k].supported]);
  });
});

describe("reason codes equal the compiler's on the same facts", () => {
  const cases: [string, ChainInputs, any][] = [
    ["V3 3002", v3Inputs(), {}],
    [
      "V3 3002 without Revive",
      withMeta(
        mutateV14(v3Hex, (j) => (j.pallets = j.pallets.filter((p: any) => p.name !== "Revive"))),
      ),
      {},
    ],
    [
      "V3 3002 with nfts.mint retyped",
      withMeta(
        mutateV14(v3Hex, (j) => {
          const def = lookupDef(j, callTypeId(j, "Nfts"));
          const v = def.variant.variants.find((x: any) => x.name === "mint");
          v.fields.find((f: any) => f.name === "item").type = j.lookup.types.find(
            (t: any) => t.type.def.primitive === "Bool",
          ).id;
        }),
      ),
      {},
    ],
  ];
  for (const [label, inputs, opts] of cases)
    it(label, () => {
      const caps = liveCapabilities(inputs, opts);
      expect(caps.facts).toEqual(factsFromChainInputs(inputs, opts));
      for (const k of SEAM_ACTION_KINDS) {
        const c = compilerStep(caps.facts, k);
        expect([k, caps.actions[k].supported, caps.actions[k].reasonCode]).toEqual([
          k,
          c.verdict === "ok",
          c.code,
        ]);
      }
    });
});

describe("liveCapabilities fails closed on metadata changes", () => {
  it("a missing pallet -> pallet_missing with no indices", () => {
    const m = mutateV14(v3Hex, (j) => {
      j.pallets = j.pallets.filter((p: any) => p.name !== "Contracts");
    });
    expect(liveCapabilities(withMeta(m)).actions["contracts.call"]).toMatchObject({
      supported: false,
      presence: "pallet_missing",
      palletIndex: null,
      callIndex: null,
    });
  });
  it("a missing call -> call_missing (pallet still there)", () => {
    const m = mutateV14(v3Hex, (j) => {
      const def = lookupDef(j, callTypeId(j, "Assets"));
      def.variant.variants = def.variant.variants.filter((v: any) => v.name !== "mint");
    });
    const c = liveCapabilities(withMeta(m)).actions;
    expect(c["assets.mint"]).toMatchObject({
      supported: false,
      presence: "call_missing",
      callIndex: null,
    });
    expect(c["assets.transfer"].supported).toBe(true);
  });
  it("a renamed argument -> V3_ARG_SHAPE_MISMATCH", () => {
    const m = mutateV14(v3Hex, (j) => {
      const def = lookupDef(j, callTypeId(j, "Assets"));
      const v = def.variant.variants.find((x: any) => x.name === "transfer_keep_alive");
      v.fields.find((f: any) => f.name === "target").name = "dest";
    });
    const c = liveCapabilities(withMeta(m)).actions["assets.transfer"];
    expect(c).toMatchObject({ supported: false, presence: "observed" });
    expect(c.reasonCode).toBeUndefined();
    expect(c.palletIndex).toBe(39);
  });
  it("a retyped argument (amount -> bool) -> V3_ARG_SHAPE_MISMATCH", () => {
    const m = mutateV14(v3Hex, (j) => {
      const def = lookupDef(j, callTypeId(j, "Nfts"));
      const v = def.variant.variants.find((x: any) => x.name === "mint");
      const b = j.lookup.types.find((t: any) => t.type.def.primitive === "Bool").id;
      v.fields.find((f: any) => f.name === "item").type = b;
    });
    expect(liveCapabilities(withMeta(m)).actions["nfts.mint"]).toMatchObject({
      supported: false,
      reasonCode: "V3_ARG_SHAPE_MISMATCH",
    });
  });
  it("an extra argument on map_account -> V3_ARG_SHAPE_MISMATCH", () => {
    const m = mutateV14(v3Hex, (j) => {
      const def = lookupDef(j, callTypeId(j, "Revive"));
      const v = def.variant.variants.find((x: any) => x.name === "map_account");
      const u32 = j.lookup.types.find((t: any) => t.type.def.primitive === "U32").id;
      v.fields.push({ name: "extra", type: u32, typeName: "u32", docs: [] });
    });
    expect(liveCapabilities(withMeta(m)).actions["revive.map_account"].reasonCode).toBe(
      "V3_ARG_SHAPE_MISMATCH",
    );
  });
});

describe("shape tables stay identical to the compiler's", () => {
  it("kind -> capability mapping", () => {
    expect(ACTION_CAPABILITY).toEqual(KIND_TO_CAPABILITY);
  });
  it("V3 kinds: names, aliases and classes equal V3_SHAPES", () => {
    for (const [kind, shape] of Object.entries(V3_SHAPES))
      expect(
        ACTION_SHAPES[kind as keyof typeof ACTION_SHAPES].map((s) => [
          s.name,
          s.class,
          s.aliases ?? [],
        ]),
      ).toEqual(shape!.map((s) => [s.name, s.class, s.aliases ?? []]));
  });
});

describe("readLiveCapabilities (read-only RPC through an injected send)", () => {
  it("reads genesis, finalized head, runtime version, metadata and properties at that head; sends nothing else", async () => {
    const i = v3Inputs();
    const calls: string[] = [];
    const send = async (m: string, p: unknown[]) => {
      calls.push(m);
      switch (m) {
        case "chain_getBlockHash":
          return i.genesisHash;
        case "chain_getFinalizedHead":
          return i.head.hash;
        case "chain_getHeader":
          return { number: "0x" + i.head.number.toString(16) };
        case "state_getRuntimeVersion":
          expect(p).toEqual([i.head.hash]);
          return i.runtimeVersion;
        case "state_getMetadata":
          expect(p).toEqual([i.head.hash]);
          return i.metadataHex;
        case "system_properties":
          return i.properties;
      }
      throw new Error(`unexpected ${m}`);
    };
    const r = await readLiveCapabilities(send);
    expect(r).toEqual(liveCapabilities(i));
    expect(calls.every((c) => /^(chain_get|state_get|system_properties)/.test(c))).toBe(true);
  });
});
