#!/usr/bin/env node
// Generates packages/compiler/fixtures/v3-fresh-transfer.json: a FRESH offline compile (not a recorded run) of the
// V3 wallet demo manifest against the committed spec 3002 metadata, with plain factsFromMetadata facts (no injected
// rollback proof). Deterministic: no clock, no network, no keys. Needs `npm run build -w @seam/compiler` first.
//
// usage: node packages/compiler/scripts/gen-fresh-fixture.mjs [--check]
//   --check  exit 1 if the committed fixture differs from a fresh compile (nothing is written).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile, factsFromMetadata, metadataLayoutHash, verifyPlan } from "../dist/index.js";

const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const METADATA = "evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex";
const MANIFEST_SOURCE = "packages/console/src/demo/v3-demo-transfer.json";
const OUT = "packages/compiler/fixtures/v3-fresh-transfer.json";
// The main commit the generator was written on. Static so --check does not drift on every commit.
const COMPILER_BASE = "74235fc";

export function buildFixture() {
  const metadataHex = readFileSync(root(METADATA), "utf8").trim();
  const demo = JSON.parse(readFileSync(root(MANIFEST_SOURCE), "utf8"));
  const manifest = demo.manifest;
  const fp = demo.fingerprint;
  const facts = factsFromMetadata({
    metadataHex,
    genesisHash: fp.genesisHash,
    tokenSymbol: fp.tokenSymbol,
    tokenDecimals: fp.tokenDecimals,
  });
  const plan = compile(manifest, facts);
  const v = verifyPlan(manifest, plan, facts);
  if (!v.ok || v.fingerprintDiffers)
    throw new Error(`fresh plan fails verifyPlan: ${JSON.stringify(v)}`);
  const callsToSign =
    plan.mode === "atomic_verified" || plan.mode === "atomic_unverified"
      ? [plan.outerCall?.encodedCall ?? null]
      : plan.steps.map((s) => s.encodedCall);
  return {
    label: "fresh compile, not a recorded run",
    note:
      "Offline compile of the V3 wallet demo manifest on the committed spec 3002 metadata with factsFromMetadata " +
      "(no rollback proof injected). Nothing was signed or sent. Regenerate with " +
      "`node packages/compiler/scripts/gen-fresh-fixture.mjs`; rebuild facts with factsFromMetadata(factsInput).",
    sources: {
      metadata: METADATA,
      metadataSha256: "0x" + createHash("sha256").update(metadataHex).digest("hex"),
      metadataHash: facts.fingerprint.metadataHash,
      metadataLayoutHash: metadataLayoutHash(metadataHex),
      manifest: `${MANIFEST_SOURCE}#manifest`,
      compilerBase: COMPILER_BASE,
    },
    factsInput: {
      genesisHash: fp.genesisHash,
      tokenSymbol: fp.tokenSymbol,
      tokenDecimals: fp.tokenDecimals,
    },
    manifest,
    fingerprint: facts.fingerprint,
    fingerprintDigest: facts.fingerprintDigest,
    plan,
    planDigest: plan.planDigest,
    callsToSign,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const text = JSON.stringify(buildFixture(), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    let cur = "";
    try {
      cur = readFileSync(root(OUT), "utf8");
    } catch {
      /* missing */
    }
    if (cur !== text) {
      console.error(`${OUT} is stale: run node packages/compiler/scripts/gen-fresh-fixture.mjs`);
      process.exit(1);
    }
    console.log(`${OUT} is up to date`);
  } else {
    writeFileSync(root(OUT), text);
    console.log(`wrote ${OUT}`);
  }
}
