#!/usr/bin/env node
// Current-version SEAM receipts for the V3 plan runs, rebuilt from a fresh live read (read-only, HTTPS).
// For each plan run record: re-read every step's tx with the SDK's createChainReader (block, extrinsic, signer, call
// bytes, events), build a new receipt with the CURRENT buildReceipt defaults (runtime = the record's fingerprint),
// check its integrity, then verifyReceiptLive against the record's plan and runtime. Originals are not modified.
// Output: evidence/testnet-v3/receipts-v2/<run>.json. No wallet, no signer, no submission.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReceipt,
  createChainReader,
  receiptIntegrity,
  verifyReceiptLive,
} from "../../sdk/dist/index.js";
import { discover } from "../dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ev = join(root, "evidence/testnet-v3");
const ENDPOINT = process.argv.includes("--endpoint")
  ? process.argv[process.argv.indexOf("--endpoint") + 1]
  : "https://test-node-v3.portaldot.dev";
const RUNS = [
  "plan-sequential-1792411270138.json",
  "plan-atomic-1792411355057.json",
  "plan-revive-call-1792412445848.json",
  "plan-revive-terminate-1792412498767.json",
];
mkdirSync(join(ev, "receipts-v2"), { recursive: true });
// Facts (metadata) for decoding are read live, exactly as `seam verify --endpoint` does; the record's own facts
// carry no metadata blob. The runtime pin is the record's fingerprint, bound to the receipt by fingerprint digest.
const liveFacts = await discover(ENDPOINT);
const summary = [];
for (const f of RUNS) {
  const rec = JSON.parse(readFileSync(join(ev, "runs", f), "utf8"));
  const orig = rec.run.receipt;
  const reader = await createChainReader(ENDPOINT, liveFacts);
  const outcomes = [];
  for (const s of orig.steps) {
    if (!s.txHash || !s.block) continue;
    const canon = await reader.canonicalHash(s.block.number);
    if (canon?.toLowerCase() !== s.block.hash.toLowerCase())
      throw new Error(`${f}/${s.actionId}: block not canonical`);
    const tx = await reader.readTx(s.block.hash, s.txHash);
    if (!tx) throw new Error(`${f}/${s.actionId}: tx not in block`);
    const failed = tx.events.find((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
    outcomes.push({
      actionId: s.actionId,
      status: "finalized",
      txHash: s.txHash,
      block: s.block,
      events: tx.events,
      callHex: tx.callHex,
      ...(failed ? { error: "ExtrinsicFailed" } : {}),
    });
  }
  const receipt = buildReceipt({
    plan: rec.plan,
    outcomes,
    policyDigest: orig.policyDigest ?? undefined,
    approvalHash: orig.approvalHash ?? undefined,
    runtime: rec.fingerprint,
  });
  const integrity = receiptIntegrity(receipt);
  const live = await verifyReceiptLive(receipt, reader, {
    plan: rec.plan,
    runtime: rec.fingerprint,
  });
  const out = {
    kind: "seam-receipt-v2",
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    source: `runs/${f}`,
    how: "events, signer and call bytes re-read live from V3 (not copied from the record); receipt built by the current @seam/sdk buildReceipt with runtime = the record's fingerprint; then verifyReceiptLive with the record's plan and runtime",
    originalReceiptDigest: orig.receiptDigest,
    integrity,
    live: { status: live.status, problems: live.problems, notes: live.notes, steps: live.steps },
    receipt,
  };
  writeFileSync(join(ev, "receipts-v2", f), JSON.stringify(out, null, 2) + "\n");
  const row = {
    run: f,
    result: receipt.result,
    steps: receipt.steps
      .map((s) => `${s.actionId}:${s.verification}${s.code ? `(${s.code})` : ""}`)
      .join(" "),
    integrity: integrity.status,
    live: live.status,
  };
  summary.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(join(ev, "receipts-v2", "summary.json"), JSON.stringify(summary, null, 2) + "\n");
