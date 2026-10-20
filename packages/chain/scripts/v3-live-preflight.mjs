#!/usr/bin/env node
// READ-ONLY: browser preflight (@seam/chain/browser `preflightReport`) of Pixel's V3 demo plan
// (packages/console/src/demo/v3-demo-transfer.json) against the V3 test node, plus Sentinel's gate verdict on it with
// the sequential demo policy. No wallet, no keystore, no signer: fees come from payment_queryInfo on a FAKE-signed
// extrinsic (never submittable), and no system_dryRun is attempted (it needs a real signature), so dryRun stays unknown.
// Writes evidence/testnet-v3/preflight-<timestamp>.json.
//   node packages/chain/scripts/v3-live-preflight.mjs [https://test-node-v3.portaldot.dev]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { httpRpcClient } from "../dist/index.js";
import { preflightReport, readLiveCapabilities } from "../dist/browser.js";
import { gatePolicy } from "@seam/policy/browser";

const URL_ =
  process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ?? "https://test-node-v3.portaldot.dev";
if (/mainnet/i.test(URL_)) throw new Error("refusing: this script is for the V3 test node");
const V3_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const json = (p) => JSON.parse(readFileSync(root(p), "utf8"));
const demo = json("packages/console/src/demo/v3-demo-transfer.json");
const seq = json("packages/console/src/demo/v3-demo-transfer-policy-sequential.json");

// Only these methods may reach the node.
const READ =
  /^(chain_get|state_get|state_call$|system_properties$|system_accountNextIndex$|payment_query)/;
const c = httpRpcClient(URL_, { requestTimeoutMs: 90_000 });
const sent = [];
const send = (m, p) => {
  if (!READ.test(m)) throw new Error(`refusing non-read method ${m}`);
  sent.push(m);
  return c.send(m, p);
};
try {
  // The demo plan was compiled against the committed spec 3002 metadata. The live bytes differ per block only in
  // allow-listed storage defaults (Revive.EthBlockBuilderIR); pinMetadata uses the committed bytes only then and
  // otherwise keeps the live ones (and the digest check below fails closed).
  const pinnedMetadataHex = readFileSync(
    root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
    "utf8",
  ).trim();
  const live = await readLiveCapabilities(send, { endpoint: URL_, pinnedMetadataHex });
  if (live.fingerprint.genesisHash.toLowerCase() !== V3_GENESIS)
    throw new Error("not the V3 test node");
  const facts = live.facts;
  if (facts.fingerprintDigest !== demo.plan.fingerprintDigest)
    throw new Error(
      `the demo plan was compiled for ${demo.plan.fingerprintDigest}, the node is at ${facts.fingerprintDigest}; recompile it`,
    );
  const report = await preflightReport(send, demo.plan, facts, { at: live.atBlock.hash });
  const gate = gatePolicy(
    {
      policy: seq.policy,
      plan: demo.plan,
      facts,
      preflight: report.result,
      manifest: demo.manifest,
    },
    { acknowledgedDowngrade: true },
  );
  const out = {
    kind: "seam-live-preflight",
    generatedAt: new Date().toISOString(),
    endpoint: URL_,
    readOnly:
      "fake-signed extrinsic for payment_queryInfo only; no signature, no system_dryRun, nothing submitted",
    planSource: "packages/console/src/demo/v3-demo-transfer.json",
    planDigest: demo.plan.planDigest,
    signer: demo.plan.signer.value,
    fingerprint: facts.fingerprint,
    fingerprintDigest: facts.fingerprintDigest,
    metadataLayoutHash: live.metadataLayoutHash,
    metadataPinned: "evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex",
    rpcMethods: [...new Set(sent)],
    rpcRequests: c.stats,
    result: report.result,
    report: { ...report, result: undefined },
    gate: {
      policy: "packages/console/src/demo/v3-demo-transfer-policy-sequential.json",
      options: { acknowledgedDowngrade: true },
      allowed: gate.allowed,
      blockedBy: gate.blockedBy,
      explanations: gate.explanations,
    },
  };
  const file = root(`evidence/testnet-v3/preflight-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  for (const s of report.result.steps)
    console.log(
      `${s.actionId}: weight ${s.weight.value ?? "unknown"} fee ${s.fee.value ?? "unknown"} proofSize ${s.proofSize?.value ?? "unknown"} storageDeposit ${s.storageDeposit.value ?? "unknown"} dryRun ${s.dryRun}`,
    );
  console.log(
    `totalFee ${report.result.totalFee.value ?? "unknown"}; nonce ${report.nonce} (${report.nonceSource}) at #${report.atBlock.number}; gate ${gate.allowed ? "allowed" : `blocked: ${gate.blockedBy.map((b) => b.code).join(", ")}`} -> ${file}`,
  );
} finally {
  c.close();
}
