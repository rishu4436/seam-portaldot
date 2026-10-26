// P1-04 action templates against the REAL committed V3 spec 3002 metadata blob (evidence/v3-discovery), offline.
// These tests prove manifest validity, encoding and digest stability only; nothing here was sent to any chain.
// The policy-gate tests live in packages/sdk/tests/templates-policy.test.ts (policy depends on the compiler).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "../src/browser.js";
import * as node from "../src/index.js";
import {
  compile,
  computeManifestDigest,
  factsFromMetadata,
  instantiateTemplate,
  listTemplates,
  parseManifest,
  serializeManifest,
  templateSkeleton,
  verifyPlan,
  type RuntimeFacts,
  type TemplateId,
} from "../src/index.js";
import { ALICE, BOB, H160 } from "./helpers.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const v3Hex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const demo = JSON.parse(
  readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
);
const v3 = (): RuntimeFacts =>
  factsFromMetadata({
    metadataHex: v3Hex,
    genesisHash: demo.manifest.chain.genesisHash,
    tokenSymbol: "tPOT",
    tokenDecimals: 14,
  });
const CHARLIE = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";
const CODE = "0x50564d00deadbeef";

/** Test-only params (well-known dev accounts). Never live defaults. */
export const TEST_PARAMS: Record<TemplateId, Record<string, string>> = {
  "asset-transfer": { signer: ALICE, recipient: BOB, assetId: "806707", amount: "1000" },
  "nft-mint": { signer: ALICE, recipient: BOB, collection: "1", item: "7" },
  "asset-mint": { signer: ALICE, recipient: BOB, assetId: "806707", amount: "500" },
  "sequential-transfers": {
    signer: ALICE,
    assetId: "806707",
    recipient1: BOB,
    amount1: "10",
    recipient2: CHARLIE,
    amount2: "20",
  },
  "atomic-batch": {
    signer: ALICE,
    assetId: "806707",
    recipient1: BOB,
    amount1: "10",
    recipient2: CHARLIE,
    amount2: "20",
  },
  "revive-call": {
    signer: ALICE,
    contract: H160,
    data: "0x12345678",
    value: "0",
    gasLimit: "5000000000",
    proofSize: "1000000",
    storageDepositLimit: "100",
  },
  "restricted-deploy": {
    signer: ALICE,
    code: CODE,
    data: "0x",
    gasLimit: "5000000000",
    proofSize: "200000",
    storageDepositLimit: "10000000000000",
  },
};
const IDS = Object.keys(TEST_PARAMS) as TemplateId[];
const opts = (id: TemplateId) => (id === "atomic-batch" ? { allowAtomicUnverified: true } : {});

describe("listTemplates", () => {
  it("lists the seven templates with kinds and mode, shared by node and browser entries", () => {
    expect(listTemplates().map((t) => t.id)).toEqual(IDS);
    expect(browser.instantiateTemplate).toBe(node.instantiateTemplate);
    expect(browser.listTemplates).toBe(node.listTemplates);
    const byId = Object.fromEntries(listTemplates().map((t) => [t.id, t]));
    expect(byId["atomic-batch"]!.mode).toBe("atomic");
    expect(byId["atomic-batch"]!.note).toMatch(/atomic_unverified/);
    expect(byId["sequential-transfers"]!.mode).toBe("sequential");
    expect(byId["restricted-deploy"]!.kinds).toEqual(["revive.instantiate_with_code"]);
  });
  it("no template carries a default address or value", () => {
    for (const t of listTemplates())
      for (const prm of t.params) expect(prm).not.toHaveProperty("default");
  });
});

describe.each(IDS)("template %s on real V3 spec 3002 facts", (id) => {
  const facts = v3();
  const r = instantiateTemplate(id, TEST_PARAMS[id], facts, opts(id));
  it("instantiates through serializeManifest -> parseManifest with a clean live check", () => {
    expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
    if (!r.ok) return;
    expect(r.manifestText).toBe(serializeManifest(r.manifest));
    expect(parseManifest(r.manifestText, facts, opts(id)).ok).toBe(true);
    expect(r.check!.issues).toEqual([]);
    expect(r.check!.unavailable).toEqual([]);
  });
  it("compiles with every step ok and an encoded call", () => {
    if (!r.ok) throw new Error("not ok");
    const plan = compile(r.manifest, facts, opts(id));
    expect(plan.steps.length).toBe(r.manifest.actions.length);
    for (const s of plan.steps) {
      expect(s.status).toBe("ok");
      expect(s.encodedCall).toMatch(/^0x[0-9a-f]+$/);
    }
    if (id === "atomic-batch") {
      expect(plan.mode).toBe("atomic_unverified");
      expect(plan.outerCall?.encodedCall).toMatch(/^0x/);
    } else expect(plan.mode).toBe("sequential");
    if (id === "restricted-deploy") {
      expect(plan.steps[0]!.decodedArgs.codeHash).toBe(r.codeHash);
      expect(plan.steps[0]!.decodedArgs.value).toBe("0");
    }
  });
  it("verifyPlan(manifest, plan, v3Facts) is ok for the compiled plan", () => {
    if (!r.ok) throw new Error("not ok");
    const plan = compile(r.manifest, facts, opts(id));
    const v = verifyPlan(r.manifest, plan, facts, opts(id));
    expect(v.ok, JSON.stringify(!v.ok && v.issues)).toBe(true);
  });
  it("round-trips digest-stable", () => {
    if (!r.ok) throw new Error("not ok");
    const again = parseManifest(serializeManifest(r.manifest));
    if (!again.ok) throw new Error("re-parse failed");
    expect(serializeManifest(again.manifest)).toBe(r.manifestText);
    expect(computeManifestDigest(again.manifest)).toBe(computeManifestDigest(r.manifest));
    expect(compile(again.manifest, facts, opts(id)).planDigest).toBe(
      compile(r.manifest, facts, opts(id)).planDigest,
    );
  });
  it("an unfilled placeholder is rejected (skeleton by parseManifest+facts and compile; params by instantiate)", () => {
    const sk = templateSkeleton(id);
    expect(sk).toMatch(/\{\{signer\}\}/);
    expect(parseManifest(sk, facts, opts(id)).ok).toBe(false);
    expect(() => compile(JSON.parse(sk), facts, opts(id))).toThrow();
    const firstKey = Object.keys(TEST_PARAMS[id]).find((k) => k !== "signer")!;
    for (const bad of [
      { [firstKey]: `{{${firstKey}}}` },
      { [firstKey]: "" },
      { [firstKey]: undefined },
    ]) {
      const x = instantiateTemplate(id, { ...TEST_PARAMS[id], ...bad }, facts, opts(id));
      expect(x.ok).toBe(false);
      if (!x.ok) expect(x.issues[0]!.path).toBe(`params.${firstKey}`);
    }
  });
});

describe("template guards", () => {
  it("unknown template and unknown parameter are rejected", () => {
    expect(instantiateTemplate("nope", {}).ok).toBe(false);
    const x = instantiateTemplate("asset-transfer", {
      ...TEST_PARAMS["asset-transfer"],
      extra: "1",
    });
    expect(x.ok).toBe(false);
  });
  it("a bad value is rejected by the live compile check, with a path", () => {
    const x = instantiateTemplate(
      "asset-transfer",
      { ...TEST_PARAMS["asset-transfer"], amount: "1.5" },
      v3(),
    );
    expect(x.ok).toBe(false);
    if (!x.ok) expect(x.issues.some((i) => i.path?.includes("amount"))).toBe(true);
  });
  it("atomic-batch without allowAtomicUnverified is not silently downgraded: mode unavailable", () => {
    const x = instantiateTemplate("atomic-batch", TEST_PARAMS["atomic-batch"], v3());
    expect(x.ok).toBe(true);
    if (x.ok) {
      expect(x.manifest.atomicRequired).toBe(true);
      expect(compile(x.manifest, v3()).mode).toBe("unavailable");
    }
  });
  it("restricted-deploy fixes value at 0 (a value param is unknown)", () => {
    expect(
      instantiateTemplate("restricted-deploy", { ...TEST_PARAMS["restricted-deploy"], value: "5" })
        .ok,
    ).toBe(false);
  });
});
