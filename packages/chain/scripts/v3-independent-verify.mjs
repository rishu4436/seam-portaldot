#!/usr/bin/env node
// Independent, read-only verification of every V3 testnet transaction in evidence/testnet-v3.
// It does NOT trust SEAM's records: for each tx it re-reads the chain over HTTPS (packages/chain httpRpcClient),
// finds the extrinsic by blake2-256 of its full bytes, decodes call + signer with the block's own metadata, reads
// System.Events at that block, and only then compares with what the evidence committed.
// No wallet, no keystore, no signer, no submission. Usage (after `npm run build -w @seam/chain`):
//   node packages/chain/scripts/v3-independent-verify.mjs [--endpoint https://test-node-v3.portaldot.dev] [--out <file>]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Metadata, TypeRegistry } from "@polkadot/types";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { blake2AsHex, decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { httpRpcClient } from "../dist/index.js";
import { classify, compareEvents, parseEventString } from "./v3-independent-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const evDir = join(root, "evidence/testnet-v3");
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const ENDPOINT = opt("--endpoint", "https://test-node-v3.portaldot.dev");
const OUT = opt("--out", join(evDir, "independent-verification.json"));
const EXPECTED_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
if (/mainnet|wss?:\/\/(?!test)/i.test(ENDPOINT) && !ENDPOINT.includes("test"))
  throw new Error("refusing a non-test endpoint");
const SYSTEM_EVENTS = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";

const rec = (f) => JSON.parse(readFileSync(join(evDir, "runs", f), "utf8"));

/** The 18 sent transactions, with what each record committed (expected side). */
function expectations() {
  const list = [];
  const simple = (row, f) => {
    const d = rec(f);
    list.push({
      row,
      record: `runs/${f}`,
      label: d.label,
      txHash: d.txHash,
      blockNumber: d.block.number,
      blockHash: d.block.hash,
      extrinsicIndex: d.extrinsicIndex ?? null,
      signer: d.signer,
      callHex: d.callHex ?? null,
      callNote: d.callHex
        ? undefined
        : `no call bytes recorded; record has call text "${d.callFromChain ?? d.call}"`,
      events: d.events.map((e) => ({ pallet: e.pallet, name: e.name, args: e.args })),
    });
  };
  const planSteps = (rowBase, f) => {
    const d = rec(f);
    d.run.receipt.steps.forEach((s) => {
      const step = d.plan.steps.find((p) => p.actionId === s.actionId);
      list.push({
        row: `${rowBase}${d.run.receipt.steps.length > 1 ? `/${s.actionId}` : ""}`,
        record: `runs/${f}`,
        label: `SEAM plan ${d.plan.mode} [${s.actionId}] ${step?.kind}`,
        txHash: s.txHash,
        blockNumber: s.block.number,
        blockHash: s.block.hash,
        extrinsicIndex: null,
        signer: d.plan.signer.value,
        callHex: step?.encodedCall ?? null,
        events: s.events.map(parseEventString),
        plan: { contract: step?.decodedArgs?.contract },
      });
    });
  };
  const batchPlan = (row, f) => {
    const d = rec(f);
    const s = d.run.receipt.steps[0];
    list.push({
      row,
      record: `runs/${f}`,
      label: `SEAM plan ${d.plan.mode} [${d.plan.steps.map((p) => p.actionId).join(",")}] Utility.batch_all`,
      txHash: s.txHash,
      blockNumber: s.block.number,
      blockHash: s.block.hash,
      extrinsicIndex: null,
      signer: d.plan.signer.value,
      innerCalls: d.plan.steps.map((p) => p.encodedCall),
      events: s.events.map(parseEventString),
    });
  };
  simple("1", "map-account-1792408724499.json");
  simple("2", "nfts-create-1792408936565.json");
  simple("3", "nfts-mint-1792409706466.json");
  simple("4", "assets-create-1792409775476.json");
  simple("5", "fund-recipient-1792410012136.json");
  simple("6", "fund-recipient-1792410042910.json");
  simple("7", "assets-mint-1792410268239.json");
  simple("8", "assets-transfer-1792410479921.json");
  simple("9", "plan-sequential-attempt1-1792411101481.json");
  simple("10", "plan-sequential-attempt1-1792411122983.json");
  simple("11", "plan-sequential-attempt2-pay-1792411204466.json");
  planSteps("12-13", "plan-sequential-1792411270138.json");
  {
    const f = "plan-rollback-1792411297498.json";
    const d = rec(f);
    const ds = d.directSubmit;
    list.push({
      row: "14",
      record: `runs/${f}`,
      label: "rollback probe Utility.batch_all (test-only direct send)",
      txHash: ds.txHash,
      blockNumber: ds.block.number,
      blockHash: ds.block.hash,
      extrinsicIndex: null,
      signer: d.plan.signer.value,
      innerCalls: d.plan.steps.map((p) => p.encodedCall),
      events: ds.decodedEvents.map((e) => ({ pallet: e.pallet, name: e.name, args: e.args })),
      expectFailure: true,
      expectedError: "assets.BalanceLow",
    });
  }
  batchPlan("15", "plan-atomic-1792411355057.json");
  simple("R1", "revive-deploy-1792412368928.json");
  planSteps("R2", "plan-revive-call-1792412445848.json");
  planSteps("R3", "plan-revive-terminate-1792412498767.json");
  return list;
}

const rpc = httpRpcClient(ENDPOINT, { readAttempts: 6, requestTimeoutMs: 90_000 });
const call = (m, p = []) => rpc.send(m, p);
const registries = new Map(); // raw metadata hash -> registry

async function registryAt(blockHash) {
  const meta = await call("state_getMetadata", [blockHash]);
  const key = blake2AsHex(hexToU8a(meta), 256);
  let reg = registries.get(key);
  if (!reg) {
    reg = new TypeRegistry();
    const m = new Metadata(reg, meta);
    reg.setMetadata(m);
    registries.set(key, reg);
  }
  return { reg, metadataHash: key };
}

function prim(c) {
  const v = c.toPrimitive();
  return typeof v === "object" && v !== null ? JSON.stringify(v) : v;
}

function decodeEvents(reg, hex, index) {
  const recs = reg.createType("Vec<FrameSystemEventRecord>", hex);
  return recs
    .filter((r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === index)
    .map((r) => {
      const ev = r.event;
      return {
        pallet: ev.section.charAt(0).toUpperCase() + ev.section.slice(1),
        name: ev.method,
        args: ev.data.map((a) => {
          const t = a.toRawType();
          if (t === "AccountId32" || t === "AccountId") return u8aToHex(a.toU8a());
          if (t === "Bytes" || t === "Vec<u8>") return a.toHex(); // empty Bytes is "0x", not ""
          return prim(a);
        }),
        raw: ev,
      };
    });
}

function dispatchOf(reg, evs) {
  const s = evs.find((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess");
  if (s) return { ok: true };
  const f = evs.find((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
  if (!f) return undefined;
  const err = f.raw.data[0];
  if (err.isModule) {
    const meta = reg.findMetaError(err.asModule);
    return { ok: false, error: `${meta.section}.${meta.name}`, docs: meta.docs.join(" ") };
  }
  return { ok: false, error: err.type };
}

function readable(e) {
  return `${e.pallet}.${e.name}(${e.args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(", ")})`;
}

async function verifyOne(x, finalizedNumber) {
  const base = {
    row: x.row,
    label: x.label,
    record: x.record,
    txHash: x.txHash,
    blockNumber: x.blockNumber,
    recordedBlockHash: x.blockHash,
  };
  let canonicalHash;
  try {
    canonicalHash = await call("chain_getBlockHash", [x.blockNumber]);
  } catch (e) {
    const c = classify({ readError: `chain_getBlockHash failed: ${e.message}` });
    return { ...base, ...c };
  }
  const out = {
    ...base,
    canonicalHash,
    canonical: canonicalHash?.toLowerCase() === x.blockHash.toLowerCase(),
    finalized: x.blockNumber <= finalizedNumber,
  };
  let block;
  let reg;
  let metadataHash;
  let eventsHex;
  try {
    block = await call("chain_getBlock", [x.blockHash]);
    if (!block) throw new Error("block not found");
    ({ reg, metadataHash } = await registryAt(x.blockHash));
    eventsHex = await call("state_getStorage", [SYSTEM_EVENTS, x.blockHash]);
    if (!eventsHex) throw new Error("System.Events empty or pruned at this block");
  } catch (e) {
    return {
      ...out,
      ...classify({ readError: `state not readable at ${x.blockHash}: ${e.message}` }),
    };
  }
  const exts = block.block.extrinsics;
  const idx = exts.findIndex(
    (h) => blake2AsHex(hexToU8a(h), 256).toLowerCase() === x.txHash.toLowerCase(),
  );
  out.metadataHashAtBlock = metadataHash;
  out.extrinsicIndex = idx < 0 ? null : idx;
  let callMatch = null;
  let signerMatch = null;
  let events = null;
  let dispatch;
  if (idx >= 0) {
    const xt = reg.createType("Extrinsic", exts[idx]);
    const c = xt.method;
    out.call = `${c.section}.${c.method}`;
    out.callHex = c.toHex();
    out.signer = xt.isSigned ? encodeAddress(xt.signer.toU8a().slice(-32), 42) : null;
    if (xt.isSigned) out.signer = encodeAddress(decodeAddress(xt.signer.toString()), 42);
    out.args = Object.fromEntries(
      c.meta.args.map((a, i) => [
        a.name.toString(),
        c.section === "utility" ? undefined : c.args[i].toJSON(),
      ]),
    );
    signerMatch = out.signer === x.signer;
    if (x.callHex) {
      callMatch = out.callHex.toLowerCase() === x.callHex.toLowerCase();
      out.callComparedWith = "recorded call bytes";
    } else if (x.innerCalls) {
      const inner = c.args[0].map((ic) => ic.toHex().toLowerCase());
      out.innerCalls = c.args[0].map((ic) => `${ic.section}.${ic.method}`);
      callMatch =
        c.section === "utility" &&
        c.method === "batchAll" &&
        inner.length === x.innerCalls.length &&
        inner.every((h, i) => h === x.innerCalls[i].toLowerCase());
      out.callComparedWith = "plan step encodedCalls inside Utility.batch_all";
    } else {
      out.callComparedWith = x.callNote ?? "nothing to compare";
    }
    if (x.plan?.contract) {
      const dest = c.args[0].toHex().toLowerCase();
      out.dest = dest;
      if (dest !== x.plan.contract.toLowerCase()) callMatch = false;
    }
    const obsEvents = decodeEvents(reg, eventsHex, idx);
    dispatch = dispatchOf(reg, obsEvents);
    events = compareEvents(x.events, obsEvents);
    out.expectedEvents = x.events.map(readable);
    out.observedEvents = obsEvents.map(readable);
  }
  out.dispatch = dispatch ?? null;
  const c = classify(
    {
      canonicalHash,
      recordedBlockHash: x.blockHash,
      blockNumber: x.blockNumber,
      finalizedNumber,
      extrinsicIndex: out.extrinsicIndex,
      recordedIndex: x.extrinsicIndex,
      callMatch,
      signerMatch,
      dispatch,
      events,
    },
    { expectFailure: x.expectFailure, expectedError: x.expectedError },
  );
  if (callMatch === null && out.extrinsicIndex !== null)
    c.reasons.push(
      `call bytes not compared: ${out.callComparedWith}; the record was itself rebuilt from chain, so only signer, events and dispatch are independent checks`,
    );
  return { ...out, callMatch, signerMatch, eventsMatch: events?.match ?? null, ...c };
}

async function main() {
  const genesis = await call("chain_getBlockHash", [0]);
  if (genesis.toLowerCase() !== EXPECTED_GENESIS)
    throw new Error(`unexpected genesis ${genesis}; refusing`);
  const rv = await call("state_getRuntimeVersion", []);
  const finHash = await call("chain_getFinalizedHead", []);
  const finHeader = await call("chain_getHeader", [finHash]);
  const finalizedNumber = parseInt(finHeader.number, 16);
  const txs = expectations();
  const results = [];
  for (const x of txs) {
    const r = await verifyOne(x, finalizedNumber);
    console.log(
      `${r.row.padEnd(8)} ${r.txHash.slice(0, 10)}… #${r.blockNumber} ${r.outcome}${r.reasons?.length ? " — " + r.reasons.join("; ") : ""}`,
    );
    results.push(r);
  }
  const counts = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  const doc = {
    kind: "seam-v3-independent-verification",
    version: 1,
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    transport: "@seam/chain httpRpcClient (HTTPS JSON-RPC, read methods only)",
    genesis,
    spec: {
      specName: rv.specName,
      specVersion: rv.specVersion,
      transactionVersion: rv.transactionVersion,
    },
    finalizedHead: { number: finalizedNumber, hash: finHash },
    method:
      "For each tx: chain_getBlockHash(recorded number) vs recorded hash; number <= finalized head; chain_getBlock and blake2-256 of every full extrinsic to find the tx; decode call and signer with state_getMetadata(at block); System.Events at the block filtered by ApplyExtrinsic(index); dispatch result from ExtrinsicSuccess/ExtrinsicFailed (module error decoded); then compare with the committed evidence.",
    rpcRequests: rpc.stats,
    counts,
    transactions: results,
  };
  rpc.close();
  writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
  console.log(JSON.stringify(counts), "->", OUT);
}

main().catch((e) => {
  console.error(e);
  rpc.close();
  process.exit(1);
});
