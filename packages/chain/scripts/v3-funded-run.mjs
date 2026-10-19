#!/usr/bin/env node
// Funded Portaldot V3 testnet run (spec 3002). Every transaction goes through SEAM's signing path
// (signing request -> signer closure -> assembleSignedExtrinsic, which verifies the signature), then a free signed
// dry run (system_dryRun) and payment_queryInfo, then a spending-cap check, and only then submitAndWatch, which waits
// for finality. Setup calls (map_account, Nfts.create, Assets.create, ...) are NOT manifest plan steps: the compiler
// has no action kind for them, so they are outside the Manifest/Policy trust boundary. The SEAM-plan steps
// (--step plans) run compile -> preflight -> policy -> approve -> sign -> gate -> submit -> receipt.
//
//   SEAM_SIGNER=<keystore path> SEAM_SIGNER_PASSWORD=... node scripts/v3-funded-run.mjs --step STEP [--submit]
//   STEP: map | nfts | assets | plans | revive | balance
//   Without --submit, every transaction is signed and dry-run only (nothing is sent).
// Options: --rpc URL (default wss://test-node-v3.portaldot.dev)  --out DIR (default evidence/testnet-v3)
//   --cap-tpot N (default 10: total spend incl. fees and deposits, measured as the drop in free balance since the
//   first recorded baseline in DIR/budget.json)
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, keccak256AsU8a, mnemonicGenerate } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import { TypeRegistry, Metadata } from "@polkadot/types";
import {
  discover,
  decodeRuntime,
  storageKey,
  withClient,
  readSigningCheckpoint,
  signingRequestsForCalls,
  assembleSignedExtrinsic,
  submitAndWatch,
  extrinsicHash,
  createPortaldotAdapter,
  lookupExtrinsic,
  readInclusion,
} from "../dist/index.js";
import {
  assertNotMainnetUrl,
  assertNotMainnetFacts,
  loadSigner,
  payloadSigner,
  makeGuard,
  makeSaver,
  runAllFlows,
} from "./seam-run.mjs";
import { runFlow, devPolicy } from "./devnode/flow.mjs";
import { compile } from "@seam/compiler";
import { evaluatePolicy } from "@seam/policy";
import { buildReceipt, checkReceipt, verifyNftsMintOutcome } from "@seam/sdk";
import { encodeCall, rollbackProofFromEvidence } from "./devnode/lib.mjs";
import { httpRpcClient } from "./http-rpc-client.mjs";

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n) => argv.includes(n);
const RPC_URL = flag("--rpc") ?? "wss://test-node-v3.portaldot.dev";
// Same node over JSON-RPC HTTP (default): the WebSocket drops too often for multi-minute runs. --ws keeps the WebSocket.
const HTTP_URL = flag("--http") ?? RPC_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
const RPC = has("--ws") ? RPC_URL : httpRpcClient(HTTP_URL);
const OUT =
  flag("--out") ?? fileURLToPath(new URL("../../../evidence/testnet-v3", import.meta.url));
const STEP = flag("--step");
const SUBMIT = has("--submit");
const DECIMALS = 14n;
const UNIT = 10n ** DECIMALS;
const CAP = BigInt(Math.round(Number(flag("--cap-tpot") ?? 10) * 1e6)) * (UNIT / 1_000_000n);
const EXPLORER = "https://node-console.portaldot.dev";
assertNotMainnetUrl(RPC_URL);
assertNotMainnetUrl(HTTP_URL);
if (!STEP) {
  console.error("--step map|nfts|assets|plans|revive|balance is required");
  process.exit(2);
}

const signer = await loadSigner();
if (!signer && STEP !== "balance") {
  console.error("SEAM_SIGNER is not set");
  process.exit(2);
}
const guard = makeGuard(signer?.secrets ?? []);
const save = makeSaver(OUT, guard);
const fmt = (p) => {
  const n = BigInt(p);
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? "-" : ""}${a / UNIT}.${(a % UNIT).toString().padStart(14, "0").replace(/0+$/, "") || "0"}`;
};

// rpc.js can reject a connect timer after the attempt already failed another way; that stray rejection is not
// attached to any pending call, so it is logged instead of killing the run mid-flight.
process.on("unhandledRejection", (e) => {
  if (e?.code === "CONNECT_FAILED" || e?.code === "RPC_FAILED")
    console.warn(`(ignored stray ${e.code})`);
  else {
    console.error(e);
    process.exit(1);
  }
});

/** The V3 node drops WebSocket connections often (1006): read-only calls are retried. */
async function retry(fn, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (
        e?.code === "RUNTIME_CHANGED" ||
        /refusing|not in block|beyond storage fallbacks/.test(String(e?.message))
      )
        throw e;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw last;
}
const facts = await retry(() => discover(RPC));
assertNotMainnetFacts(facts);
const ss58 = facts.fingerprint.ss58Prefix;
const ADDRESS = signer ? signer.addressFor(ss58) : flag("--address");
const dec = decodeRuntime(facts);
const q = dec.decorated().query;

/** pallet-revive AccountId32Mapper: eth-derived (12 trailing 0xEE bytes) -> first 20 bytes, else keccak256(id)[12..]. */
export function h160Of(publicKey) {
  const pk = typeof publicKey === "string" ? hexToU8a(publicKey) : publicKey;
  if (pk.slice(20).every((b) => b === 0xee)) return u8aToHex(pk.slice(0, 20));
  return u8aToHex(keccak256AsU8a(pk).slice(12));
}

async function readStorage(entry, ...keys) {
  return retry(() =>
    withClient(RPC, async (c) => {
      const v = await c.send("state_getStorage", [storageKey(entry, ...keys)]);
      if (!v) return null;
      const t = dec.registry.lookup.getTypeDef(
        entry.meta.type.isMap ? entry.meta.type.asMap.value : entry.meta.type.asPlain,
      ).type;
      return dec.registry.createType(t, hexToU8a(v)).toJSON();
    }),
  );
}
async function accountOf(addr) {
  const a = await readStorage(q.system.account, addr);
  return {
    free: BigInt(a?.data?.free ?? 0),
    reserved: BigInt(a?.data?.reserved ?? 0),
    nonce: a?.nonce ?? 0,
  };
}
async function head() {
  return retry(() =>
    withClient(RPC, async (c) => {
      const h = await c.send("chain_getHeader", []);
      const f = await c.send("chain_getFinalizedHead", []);
      const fh = await c.send("chain_getHeader", [f]);
      return { best: parseInt(h.number, 16), finalized: parseInt(fh.number, 16), finalizedHash: f };
    }),
  );
}

// Budget: baseline = free balance recorded the first time this runs against DIR; spend = baseline free - free now.
const budgetFile = `${OUT}/budget.json`;
async function budget() {
  const acct = await accountOf(ADDRESS);
  let b;
  if (existsSync(budgetFile)) b = JSON.parse(readFileSync(budgetFile, "utf8"));
  else {
    b = {
      kind: "spending-budget",
      account: ADDRESS,
      capPlanck: CAP.toString(),
      cap: `${fmt(CAP)} tPOT`,
      baselineFree: acct.free.toString(),
      baselineReserved: acct.reserved.toString(),
      baselineAt: new Date().toISOString(),
      baselineBlock: (await head()).best,
      note: "spend = baselineFree - free now (fees + held deposits + transfers out). Hard stop before a tx would pass the cap.",
    };
    save("budget.json", b);
  }
  const spent = BigInt(b.baselineFree) - acct.free;
  return { ...b, acct, spent, left: BigInt(b.capPlanck) - spent };
}

async function nextNonce(addr) {
  return retry(() => withClient(RPC, (c) => c.send("system_accountNextIndex", [addr])));
}

/**
 * V3 finding: the raw state_getMetadata bytes of spec 3002 drift between blocks with no runtime upgrade, because the
 * storage fallback (default value) of Revive.EthBlockBuilderIR is state-dependent. SEAM pins the raw metadata hash, so
 * readEvents refuses (RUNTIME_CHANGED) when the inclusion block's bytes differ from the pinned ones. This fallback
 * only applies when the two metadata blobs are identical once every storage fallback is blanked; then it decodes the
 * block's events with that block's own metadata. Anything else stays refused.
 */
function blankFallbacks(hex) {
  const r = new TypeRegistry();
  const m = new Metadata(r, hex);
  r.setMetadata(m);
  const j = m.toJSON();
  const latest = Object.values(j.metadata)[0];
  for (const p of latest.pallets) for (const it of p.storage?.items ?? []) it.fallback = "0x";
  return { json: JSON.stringify(latest), registry: r, metadata: m };
}
async function eventsWithBlockMetadata(blockHash, txHash) {
  return retry(() =>
    withClient(RPC, async (c) => {
      const [mdHex, block, header, evHex] = await Promise.all([
        c.send("state_getMetadata", [blockHash]),
        c.send("chain_getBlock", [blockHash]),
        c.send("chain_getHeader", [blockHash]),
        c.send("state_getStorage", [
          "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7",
          blockHash,
        ]),
      ]);
      const pinned = blankFallbacks(facts.source.metadataHex);
      const here = blankFallbacks(mdHex);
      if (pinned.json !== here.json)
        throw new Error(
          "inclusion block metadata differs from the pinned runtime beyond storage fallbacks: refusing to decode",
        );
      const idx = block.block.extrinsics.findIndex(
        (x) => extrinsicHash(x) === txHash.toLowerCase(),
      );
      if (idx < 0) throw new Error(`tx ${txHash} not in block ${blockHash}`);
      const records = here.registry.createType("Vec<FrameSystemEventRecord>", evHex);
      const mine = records.filter(
        (r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === idx,
      );
      const events = mine.map((r) => ({
        pallet: r.event.section.charAt(0).toUpperCase() + r.event.section.slice(1),
        name: r.event.method,
        // Same text shapes as SEAM's own event decoder: account ids as 0x hex, numbers as plain decimals.
        args: r.event.data.map((d) =>
          /^(AccountId32|AccountId)$/.test(d.toRawType())
            ? d.toHex()
            : typeof d.toJSON() === "object"
              ? JSON.stringify(d.toJSON())
              : String(d.toJSON()),
        ),
      }));
      const failed = mine.find(
        (r) => r.event.section === "system" && r.event.method === "ExtrinsicFailed",
      );
      let dispatchError = null;
      if (failed) {
        const de = failed.event.data[0];
        dispatchError = de.isModule
          ? (() => {
              const m = here.registry.findMetaError(de.asModule);
              return { module: `${m.section}.${m.name}`, docs: m.docs.join(" ") };
            })()
          : de.toJSON();
      }
      return {
        number: parseInt(header.number, 16),
        hash: blockHash,
        extrinsicIndex: idx,
        success: !failed && mine.some((r) => r.event.method === "ExtrinsicSuccess"),
        dispatchError,
        events,
        decodedWith: "block's own metadata (differs from pinned only in storage fallbacks)",
      };
    }),
  );
}

/** After an uncertain send: find the tx (lookupExtrinsic), wait until its block is finalized, read its events. */
async function recoverInclusion(txHash, fromBlock) {
  for (let i = 0; i < 40; i++) {
    const l = await retry(() => lookupExtrinsic(RPC, txHash, { fromBlock, maxScan: 400 }));
    if (l.state === "found_finalized") {
      try {
        const inclusion = await retry(() => readInclusion(RPC, l.block.hash, txHash, facts));
        return {
          how: "lookupExtrinsic + readInclusion after the watch ended early",
          status: "finalized",
          inclusion,
        };
      } catch (e) {
        if (e.code !== "RUNTIME_CHANGED") throw e;
        const inclusion = await eventsWithBlockMetadata(l.block.hash, txHash);
        return {
          how: `lookupExtrinsic; readInclusion refused (${e.message.slice(0, 160)}); decoded with the block's own metadata after checking it differs only in storage fallbacks`,
          status: "finalized",
          inclusion,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 6000));
  }
  return { how: "lookupExtrinsic: not found finalized within ~4 minutes" };
}

/** Sign through SEAM, dry run, query fee, cap check, submit, wait for finality. Returns a full evidence record. */
async function sendTx({
  name,
  label,
  callHex,
  decoded,
  expectedDeposit = 0n,
  allowFailure = false,
}) {
  const checkpoint = await retry(() => readSigningCheckpoint(RPC));
  const nonce = await nextNonce(ADDRESS);
  const [req] = signingRequestsForCalls([callHex], facts, {
    signer: ADDRESS,
    nonce,
    mortalityBlocks: 64,
    checkpoint,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const { signature } = await payloadSigner(signer, facts)(req.payload);
  const xt = assembleSignedExtrinsic(req.payload, signature, facts);
  const adapter = createPortaldotAdapter(RPC, { facts });
  const dry = await retry(() => adapter.dryRunSigned([xt]));
  const info = await retry(() => withClient(RPC, (c) => c.send("payment_queryInfo", [xt])));
  const fee = BigInt(info.partialFee);
  const b = await budget();
  const rec = {
    kind: "v3-tx",
    label,
    call: decoded,
    callHex,
    signer: ADDRESS,
    nonce,
    checkpoint,
    signedDryRun: { result: dry[0], detail: adapter.lastDryRun },
    queryInfo: info,
    estimatedFee: fee.toString(),
    estimatedFeeTpot: fmt(fee),
    expectedDeposit: expectedDeposit.toString(),
    budgetBefore: { spent: b.spent.toString(), spentTpot: fmt(b.spent), leftTpot: fmt(b.left) },
    balanceBefore: { free: b.acct.free.toString(), reserved: b.acct.reserved.toString() },
  };
  console.log(
    `[${label}] dry run: ${dry[0]}; est fee ${fmt(fee)} tPOT; est deposit ${fmt(expectedDeposit)}; spent so far ${fmt(b.spent)} of ${b.cap}`,
  );
  if (dry[0] !== "ok" && !allowFailure) {
    rec.outcome = `not sent: signed dry run said ${dry[0]}`;
    return rec;
  }
  if (b.spent + fee * 2n + expectedDeposit > BigInt(b.capPlanck)) {
    rec.outcome = "not sent: would exceed the spending cap";
    console.error(`[${label}] STOP: would exceed the cap`);
    return rec;
  }
  if (!SUBMIT) {
    rec.outcome = "dry run only (no --submit)";
    return rec;
  }
  const statuses = [];
  rec.txHashLocal = extrinsicHash(xt);
  rec.outcome = "pending: submitted, outcome not read yet";
  rec.__path = writeRun(name, rec);
  let res;
  try {
    res = await submitAndWatch(
      RPC,
      xt,
      (u) =>
        statuses.push({ status: u.status, blockHash: u.blockHash, at: new Date().toISOString() }),
      { facts, timeoutMs: 180_000 },
    );
  } catch (e) {
    res = { txHash: rec.txHashLocal, status: "unknown", error: String(e.message ?? e) };
  }
  res.txHash ??= rec.txHashLocal;
  if (!res.inclusion) {
    // The watch ended without an inclusion (subscription dropped or timed out): SEAM-005 lookup, read-only.
    const rec2 = await recoverInclusion(res.txHash, checkpoint.number);
    rec.recoveredBy = rec2.how;
    if (rec2.inclusion) Object.assign(res, { inclusion: rec2.inclusion, status: rec2.status });
  }
  const after = await accountOf(ADDRESS);
  const ev = res.inclusion?.events ?? [];
  const feeEv = ev.find(
    (e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid",
  );
  Object.assign(rec, {
    txHash: res.txHash,
    txHashLocal: extrinsicHash(xt),
    status: res.status,
    finalized: res.status === "finalized",
    statuses,
    block: res.inclusion ? { number: res.inclusion.number, hash: res.inclusion.hash } : undefined,
    extrinsicIndex: res.inclusion?.extrinsicIndex,
    explorer: res.inclusion ? `${EXPLORER}/#/explorer/query/${res.inclusion.hash}` : undefined,
    success: res.inclusion?.success,
    dispatchError: res.inclusion?.dispatchError,
    events: ev,
    eventsBrief: ev.map((e) => `${e.pallet}.${e.name}(${e.args.join(", ")})`),
    actualFee: feeEv ? String(feeEv.args[1]).replace(/,/g, "") : undefined,
    balanceAfter: { free: after.free.toString(), reserved: after.reserved.toString() },
    freeDrop: (b.acct.free - after.free).toString(),
    freeDropTpot: fmt(b.acct.free - after.free),
    reservedIncreaseTpot: fmt(after.reserved - b.acct.reserved),
    error: res.error,
  });
  rec.outcome = res.inclusion?.success
    ? "success"
    : `failed: ${JSON.stringify(res.inclusion?.dispatchError ?? res.error ?? res.status)}`;
  console.log(
    `[${label}] ${rec.outcome}; tx ${rec.txHash} block #${rec.block?.number} ${rec.status}; free drop ${rec.freeDropTpot} tPOT`,
  );
  return rec;
}

const ts = () => Date.now();
const writeRun = (name, rec) => {
  const { __path, ...clean } = rec;
  const f = __path ?? `${OUT}/runs/${name}-${ts()}.json`;
  mkdirSync(`${OUT}/runs`, { recursive: true });
  writeFileSync(f, guard(clean));
  console.log(`  -> ${f}`);
  return f;
};
const statePath = `${OUT}/state.json`;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const saveState = () => save("state.json", { kind: "v3-run-state", ...state });

if (STEP === "recover") {
  // Fill in a record whose watch ended early. --file runs/<name>.json
  const file = `${OUT}/${flag("--file")}`;
  const rec = JSON.parse(readFileSync(file, "utf8"));
  const r = await recoverInclusion(rec.txHash, rec.checkpoint.number);
  if (!r.inclusion) {
    console.error(r.how);
    process.exit(1);
  }
  const ev = r.inclusion.events;
  const feeEv = ev.find(
    (e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid",
  );
  Object.assign(rec, {
    recoveredBy: r.how,
    status: r.status,
    finalized: true,
    block: { number: r.inclusion.number, hash: r.inclusion.hash },
    extrinsicIndex: r.inclusion.extrinsicIndex,
    explorer: `${EXPLORER}/#/explorer/query/${r.inclusion.hash}`,
    success: r.inclusion.success,
    dispatchError: r.inclusion.dispatchError,
    events: ev,
    eventsBrief: ev.map((e) => `${e.pallet}.${e.name}(${e.args.join(", ")})`),
    actualFee: feeEv ? String(feeEv.args[1]).replace(/,/g, "") : undefined,
  });
  rec.outcome = r.inclusion.success
    ? "success"
    : `failed: ${JSON.stringify(r.inclusion.dispatchError)}`;
  if (rec.label === "nfts.create") {
    const created = ev.find((e) => e.pallet === "Nfts" && e.name === "Created");
    if (created) {
      rec.collection = Number(String(created.args[0]).replace(/,/g, ""));
      state.collection = rec.collection;
      saveState();
    }
  }
  writeFileSync(file, guard(rec));
  console.log(
    `${rec.label}: ${rec.outcome} block #${rec.block.number}; ${rec.eventsBrief.join(" | ")}`,
  );
  process.exit(0);
}

if (STEP === "find") {
  // A send whose process died before the record was written: find our extrinsic by nonce, then read its outcome.
  // --nonce N --from BLOCK --label L --name NAME [--decoded TEXT]
  const want = Number(flag("--nonce"));
  const from = Number(flag("--from"));
  const best = (await head()).best;
  let found;
  for (let n = from; n <= best && !found; n++) {
    const blk = await retry(() =>
      withClient(RPC, async (c) =>
        c.send("chain_getBlock", [await c.send("chain_getBlockHash", [n])]),
      ),
    );
    for (const x of blk.block.extrinsics) {
      const e = dec.registry.createType("Extrinsic", x);
      if (e.isSigned && e.signer.toString() === ADDRESS && e.nonce.toNumber() === want) {
        found = {
          n,
          txHash: extrinsicHash(x),
          call: `${e.method.section}.${e.method.method}(${JSON.stringify(e.method.args.map((a) => a.toJSON()))})`,
        };
        break;
      }
    }
  }
  if (!found) {
    console.error(`no extrinsic with nonce ${want} from ${from} to ${best}`);
    process.exit(1);
  }
  const r = await recoverInclusion(found.txHash, found.n);
  const ev = r.inclusion?.events ?? [];
  const feeEv = ev.find(
    (e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid",
  );
  const rec = {
    kind: "v3-tx",
    label: flag("--label"),
    call: flag("--decoded") ?? found.call,
    callFromChain: found.call,
    signer: ADDRESS,
    nonce: want,
    recordNote:
      "the sending process lost its WebSocket after submission and died before writing this record; rebuilt from the chain by signer + nonce",
    recoveredBy: r.how,
    txHash: found.txHash,
    status: r.status,
    finalized: r.status === "finalized",
    block: r.inclusion ? { number: r.inclusion.number, hash: r.inclusion.hash } : undefined,
    extrinsicIndex: r.inclusion?.extrinsicIndex,
    explorer: r.inclusion ? `${EXPLORER}/#/explorer/query/${r.inclusion.hash}` : undefined,
    success: r.inclusion?.success,
    dispatchError: r.inclusion?.dispatchError,
    events: ev,
    eventsBrief: ev.map((e) => `${e.pallet}.${e.name}(${e.args.join(", ")})`),
    actualFee: feeEv ? String(feeEv.args[1]).replace(/,/g, "") : undefined,
    outcome: r.inclusion?.success
      ? "success"
      : `failed: ${JSON.stringify(r.inclusion?.dispatchError)}`,
  };
  if (rec.label === "nfts.mint") {
    rec.itemOwnerAfter = await readStorage(q.nfts.item, state.collection, 0);
    if (rec.success) state.nftItems = [...new Set([...(state.nftItems ?? []), 0])];
    saveState();
  }
  writeRun(flag("--name"), rec);
  console.log(`${rec.label}: ${rec.outcome} tx ${rec.txHash} block #${rec.block?.number}`);
  process.exit(0);
}

/** Nfts.Issued's field order, read from the pinned real V3 metadata (not assumed). */
function observedNftsIssuedShape() {
  const rt = decodeRuntime(facts);
  const pallet = rt.metadata.asLatest.pallets.find((p) => p.name.toString() === "Nfts");
  const evType = rt.registry.lookup.getSiType(pallet.events.unwrap().type);
  const v = evType.def.asVariant.variants.find((x) => x.name.toString() === "Issued");
  const names = v.fields.map((f) => f.name.unwrap().toString());
  const idx = (n) => names.indexOf(n);
  if (idx("collection") < 0 || idx("item") < 0 || idx("owner") < 0)
    throw new Error(`unexpected Nfts.Issued fields ${names}`);
  return {
    shape: {
      pallet: "Nfts",
      name: "Issued",
      args: { collection: idx("collection"), item: idx("item"), mintTo: idx("owner") },
    },
    fields: names,
    arity: names.length,
  };
}

/** Structured events of one included tx: SEAM's readInclusion, or the storage-fallback-checked decoder. */
async function inclusionOf(blockHash, txHash) {
  try {
    return await retry(() => readInclusion(RPC, blockHash, txHash, facts));
  } catch (e) {
    if (e.code !== "RUNTIME_CHANGED") throw e;
    return eventsWithBlockMetadata(blockHash, txHash);
  }
}

/** Rebuilds the run's receipt with nfts.mint verdicts (verifyNftsMintOutcome on the step's own finalized events). */
async function receiptWithNftVerdicts(plan, run) {
  if (!run?.receipt) return undefined;
  const { shape, fields } = observedNftsIssuedShape();
  const atomic = plan.mode.startsWith("atomic");
  const outcomes = [];
  const seen = new Set();
  for (const st of run.receipt.steps) {
    const id = atomic ? "batch" : st.actionId;
    if (seen.has(id)) continue;
    seen.add(id);
    const inc =
      st.txHash && st.block?.hash ? await inclusionOf(st.block.hash, st.txHash) : undefined;
    outcomes.push({
      actionId: id,
      status: inc ? (inc.success ? "finalized" : "failed") : "not_run",
      txHash: st.txHash,
      block: st.block,
      events: inc?.events ?? [],
      ...(inc?.dispatchError ? { error: JSON.stringify(inc.dispatchError) } : {}),
    });
  }
  const verdicts = {};
  for (const step of plan.steps.filter((x) => x.kind === "nfts.mint")) {
    const o = outcomes.find((x) => x.actionId === (atomic ? "batch" : step.actionId));
    verdicts[step.actionId] = verifyNftsMintOutcome(
      {
        status:
          o?.status === "finalized" ? "finalized" : o?.status === "failed" ? "failed" : "submitted",
        events: o?.events ?? [],
        observedShape: true,
        shape,
      },
      {
        collection: step.decodedArgs.collection,
        item: step.decodedArgs.item,
        mintTo: step.decodedArgs.recipientAccountId,
      },
    );
  }
  const receipt = buildReceipt({
    plan,
    outcomes,
    policyDigest: run.receipt.policyDigest ?? undefined,
    approvalHash: run.receipt.approvalHash ?? undefined,
    verdicts,
  });
  return {
    nftsIssuedFieldsFromMetadata: fields,
    verdicts,
    receipt,
    receiptIntact: checkReceipt(receipt),
    outcomesUsed: outcomes,
  };
}

if (STEP === "plans") {
  const assetId = state.assetId;
  const [rA, rB] = state.recipients;
  const signPayload = payloadSigner(signer, facts);
  // runFlow's defaults are the local dev node's (UNIT/12, dev types bundle); V3 reports its token, so declare the same.
  const env = {
    endpoint: RPC,
    blockTimeMs: 6000,
    declaredToken: {
      tokenSymbol: facts.fingerprint.tokenSymbol,
      tokenDecimals: facts.fingerprint.tokenDecimals,
    },
  };
  const gas = { gasLimit: "5000000000", proofSize: "1000000" };
  const policyFor = (extra = {}) =>
    devPolicy({
      bob: rA,
      charlie: rB,
      contract: ADDRESS,
      demo: false,
      assetId,
      overrides: { allowedRecipients: [rA, rB, ADDRESS], ...extra },
    });
  const manifestOf = (f, actions) => ({
    version: 1,
    chain: { genesisHash: f.fingerprint.genesisHash, specVersion: f.fingerprint.specVersion },
    signer: { type: "ss58", value: ADDRESS },
    actions,
  });
  void gas;
  const want = (flag("--only") ?? "sequential,rollback,atomic").split(",");
  const nextItem = () =>
    Math.max(-1, ...(state.nftItems ?? []), ...(state.reservedItems ?? [])) + 1;
  const freshFacts = (extra = {}) => retry(() => discover(RPC, extra));

  // runFlow is retried only when it threw before anything reached the chain (signer nonce unchanged).
  const runFlowSafe = async (args) => {
    for (let i = 0; i < 5; i++) {
      const n0 = await nextNonce(ADDRESS);
      try {
        return await runFlow(args);
      } catch (e) {
        const n1 = await nextNonce(ADDRESS);
        if (n1 !== n0)
          throw new Error(`runFlow threw after sending (nonce ${n0} -> ${n1}): ${e.message}`);
        console.warn(
          `runFlow attempt ${i + 1} failed before sending (${e.code ?? ""} ${String(e.message).slice(0, 160)}); retrying`,
        );
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    throw new Error("runFlow failed 5 times before sending");
  };

  // Spend guard for a whole plan: a generous fee allowance per transaction plus the NFT item deposit.
  const guardPlan = async (txs, deposits) => {
    const b = await budget();
    const need = BigInt(txs) * (UNIT / 20n) + deposits;
    console.log(`[plan] spent so far ${fmt(b.spent)}; this plan may need up to ${fmt(need)}`);
    if (b.spent + need > BigInt(b.capPlanck)) {
      console.error("STOP: plan would exceed the spending cap");
      process.exit(1);
    }
  };

  // Dry mode: compile + preflight + policy only, nothing signed.
  const dryCheck = async (f, manifest, policy, compileOptions = {}) => {
    const plan = compile(manifest, f, { ...compileOptions });
    const adapter = createPortaldotAdapter(RPC, { facts: f, blockTimeMs: 6000 });
    const { preflight, envelope } = await retry(() => adapter.preflight(plan));
    const pr = evaluatePolicy({ policy, plan, facts: f, preflight, manifest });
    return {
      mode: plan.mode,
      modeReason: plan.modeReason,
      steps: plan.steps.map((s) => s.kind),
      preflight: preflight.simulation ?? preflight,
      allowed: pr.allowed,
      reasons: pr.reasons ?? pr.violations ?? pr,
      envelopeOk: !!envelope,
    };
  };

  if (want.includes("sequential")) {
    const item = nextItem();
    const f = await freshFacts();
    const manifest = manifestOf(f, [
      {
        id: "pay",
        kind: "assets.transfer",
        args: { assetId: String(assetId), amount: "500", recipient: rA },
      },
      {
        id: "nft",
        kind: "nfts.mint",
        args: { collection: String(state.collection), item: String(item), recipient: ADDRESS },
      },
    ]);
    const policy = policyFor();
    if (!SUBMIT)
      console.log(
        "sequential dry check:",
        JSON.stringify(await dryCheck(f, manifest, policy), null, 1).slice(0, 4000),
      );
    else {
      await guardPlan(2, UNIT / 5n);
      state.reservedItems = [...(state.reservedItems ?? []), item];
      saveState();
      const r = await runFlowSafe({ facts: f, manifest, policy, signPayload, env, atomic: false });
      const rel = `runs/plan-sequential-${ts()}.json`;
      const base = {
        kind: "seam-plan-sequential",
        recordingVersion: 2,
        ranAt: new Date().toISOString(),
        ...r,
      };
      let file = save(rel, base);
      let nft;
      try {
        nft = await receiptWithNftVerdicts(r.plan, r.run);
      } catch (e) {
        nft = { error: String(e.message ?? e) };
      }
      file = save(rel, { ...base, nftVerdictReceipt: nft });
      console.log(`sequential: ${r.run?.receipt?.result ?? r.stage} -> ${file}`);
      console.log(
        JSON.stringify(
          r.run?.receipt?.steps?.map((x) => ({
            id: x.actionId,
            status: x.status,
            tx: x.txHash,
            block: x.block?.number,
            v: x.verification,
          })),
          null,
          1,
        ),
      );
      console.log("with nft verdicts:", nft?.receipt?.result, JSON.stringify(nft?.verdicts));
      if (r.run?.receipt?.steps?.some((x) => x.actionId === "nft" && x.txHash))
        state.nftItems = [...new Set([...(state.nftItems ?? []), item])];
      state.sequentialFile = file.split("/").pop();
      saveState();
    }
  }

  if (want.includes("rollback")) {
    const item = nextItem();
    const f = await freshFacts();
    const manifest = manifestOf(f, [
      {
        id: "pay",
        kind: "assets.transfer",
        args: { assetId: String(assetId), amount: "5", recipient: rA },
        preferredMode: "atomic",
      },
      {
        id: "mint",
        kind: "assets.mint",
        args: { assetId: String(assetId), amount: "3", recipient: rB },
        preferredMode: "atomic",
      },
      {
        id: "nft",
        kind: "nfts.mint",
        args: { collection: String(state.collection), item: String(item), recipient: ADDRESS },
        preferredMode: "atomic",
      },
      {
        id: "overdraw",
        kind: "assets.transfer",
        args: { assetId: String(assetId), amount: "900000000000000", recipient: rA },
        preferredMode: "atomic",
      },
    ]);
    const policy = policyFor({
      allowedModes: ["sequential", "atomic_verified", "atomic_unverified"],
      maxAmountPerAsset: { [String(assetId)]: "1000000000000000" },
    });
    if (!SUBMIT)
      console.log(
        "rollback dry check:",
        JSON.stringify(
          await dryCheck(f, manifest, policy, { allowAtomicUnverified: true }),
          null,
          1,
        ).slice(0, 4000),
      );
    else {
      await guardPlan(1, 0n);
      const snap = async () => {
        const bal = async (who) =>
          (await readStorage(q.assets.account, assetId, who))?.balance?.toString() ?? "0";
        const acct = await accountOf(ADDRESS);
        return {
          block: (await head()).best,
          signerNonce: await nextNonce(ADDRESS),
          balances: {
            signer: await bal(ADDRESS),
            recipientA: await bal(rA),
            recipientB: await bal(rB),
          },
          supply: (await readStorage(q.assets.asset, assetId))?.supply?.toString(),
          nftItem: {
            collection: state.collection,
            item,
            exists: (await readStorage(q.nfts.item, state.collection, item)) !== null,
          },
          nativeFree: acct.free.toString(),
        };
      };
      const before = await snap();
      let signed;
      const r = await runFlowSafe({
        facts: f,
        manifest,
        policy,
        signPayload,
        env,
        atomic: true,
        compileOptions: { allowAtomicUnverified: true },
        onSigned: (txs) => {
          signed = txs;
        },
      });
      const afterGate = await snap();
      if (r.run?.ok !== false || r.run.stage !== "submit_gate" || !signed) {
        save(`runs/plan-rollback-unexpected-${ts()}.json`, {
          kind: "batch_all-rollback",
          note: "the gate did not block as expected",
          ...r,
        });
        console.error(
          "expected SEAM's gate to block the failing batch:",
          JSON.stringify(r.run?.stage ?? r.stage),
          r.run?.reason,
        );
        process.exit(1);
      }
      console.log(`gate blocked the failing batch: ${r.run.reason}`);
      // TEST-ONLY bypass: the exact signed bytes the gate refused, sent directly to observe the chain's own rollback.
      const directHash = extrinsicHash(signed[0]);
      const pendingFile = `${OUT}/runs/plan-rollback-${ts()}.json`;
      writeFileSync(
        pendingFile,
        guard({ kind: "batch_all-rollback", pending: true, directTxHash: directHash }),
      );
      const statuses = [];
      let direct;
      try {
        direct = await submitAndWatch(
          RPC,
          signed[0],
          (u) =>
            statuses.push({
              status: u.status,
              txHash: u.txHash,
              blockHash: u.blockHash,
              at: new Date().toISOString(),
            }),
          { facts: f, timeoutMs: 180_000 },
        );
      } catch (e) {
        direct = { txHash: directHash, status: "unknown", error: String(e.message ?? e) };
      }
      signed = undefined;
      let recoveredBy;
      if (!direct.inclusion) {
        const rr = await recoverInclusion(directHash, before.block - 2);
        recoveredBy = rr.how;
        if (rr.inclusion) Object.assign(direct, { inclusion: rr.inclusion, status: rr.status });
      }
      const after = await snap();
      const ev = direct.inclusion?.events ?? [];
      const innerEffects = ev.filter(
        (e) =>
          (e.pallet === "Assets" && ["Transferred", "Issued"].includes(e.name)) ||
          (e.pallet === "Nfts" && e.name === "Issued") ||
          (e.pallet === "Utility" && e.name !== "BatchInterrupted"),
      );
      const sameAssets =
        JSON.stringify(after.balances) === JSON.stringify(before.balances) &&
        after.supply === before.supply;
      const rolledBack =
        direct.inclusion?.success === false &&
        innerEffects.length === 0 &&
        sameAssets &&
        after.nftItem.exists === false;
      const gate = r.gateChecks.find((g) => g.phase === "blocked");
      const rb = {
        kind: "batch_all-rollback",
        recordingVersion: 2,
        ranAt: new Date().toISOString(),
        ...r,
        planMode: r.plan.mode,
        seamGate: {
          stage: r.run.stage,
          ok: r.run.ok,
          reason: r.run.reason,
          reasons: gate?.check.reasons ?? r.run.check?.reasons,
          passed: gate?.check.passed,
          dryRun: gate?.dryRun,
          nothingSent: afterGate.signerNonce === before.signerNonce,
        },
        directSubmit: {
          note: "test-only bypass of the gate: the same signed bytes the gate refused",
          statuses,
          recoveredBy,
          decodedEvents: ev,
          txHash: direct.txHash ?? directHash,
          status: direct.status,
          block: direct.inclusion
            ? { number: direct.inclusion.number, hash: direct.inclusion.hash }
            : undefined,
          success: direct.inclusion?.success,
          dispatchError: direct.inclusion?.dispatchError,
          events: ev.map((e) => `${e.pallet}.${e.name}(${e.args.join(", ")})`),
          error: direct.error,
        },
        state: { before, afterGate, after },
        innerEffects: innerEffects.map((e) => `${e.pallet}.${e.name}`),
        batchAllRollback: rolledBack ? "verified" : "unknown",
      };
      writeFileSync(pendingFile, guard(rb));
      state.rollbackFile = pendingFile.split("/").pop();
      state.rollback = rb.batchAllRollback;
      saveState();
      console.log(
        `rollback: ${rb.batchAllRollback}; direct tx ${rb.directSubmit.txHash} block #${rb.directSubmit.block?.number}; dispatchError ${JSON.stringify(rb.directSubmit.dispatchError)}`,
      );
    }
  }

  if (want.includes("atomic")) {
    const item = nextItem();
    const base = await freshFacts();
    let f = base;
    let proofNote;
    if (state.rollback === "verified") {
      const rb = JSON.parse(readFileSync(`${OUT}/runs/${state.rollbackFile}`, "utf8"));
      const proof = rollbackProofFromEvidence(base, rb);
      f = await freshFacts({ batchAllRollback: "verified", batchAllRollbackProof: proof });
      proofNote = `rollback proof from ${state.rollbackFile} (tx ${rb.directSubmit.txHash})`;
    }
    const manifest = manifestOf(f, [
      {
        id: "mint",
        kind: "assets.mint",
        args: { assetId: String(assetId), amount: "7", recipient: rB },
        preferredMode: "atomic",
      },
      {
        id: "nft",
        kind: "nfts.mint",
        args: { collection: String(state.collection), item: String(item), recipient: ADDRESS },
        preferredMode: "atomic",
      },
    ]);
    const policy = policyFor();
    if (!SUBMIT)
      console.log(
        "atomic dry check:",
        proofNote,
        JSON.stringify(await dryCheck(f, manifest, policy), null, 1).slice(0, 4000),
      );
    else {
      await guardPlan(1, UNIT / 5n);
      state.reservedItems = [...(state.reservedItems ?? []), item];
      saveState();
      const r = await runFlowSafe({ facts: f, manifest, policy, signPayload, env, atomic: true });
      const rel = `runs/plan-atomic-${ts()}.json`;
      const base = {
        kind: "seam-plan-atomic",
        recordingVersion: 2,
        ranAt: new Date().toISOString(),
        rollbackEvidence: state.rollbackFile,
        proofNote,
        ...r,
      };
      let file = save(rel, base);
      let nft;
      try {
        nft = await receiptWithNftVerdicts(r.plan, r.run);
      } catch (e) {
        nft = { error: String(e.message ?? e) };
      }
      file = save(rel, { ...base, nftVerdictReceipt: nft });
      console.log(
        `atomic (${r.plan?.mode}): ${r.run?.receipt?.result ?? r.stage} ${r.run?.reason ?? ""} -> ${file}`,
      );
      console.log(
        JSON.stringify(
          r.run?.receipt?.steps?.map((x) => ({
            id: x.actionId,
            status: x.status,
            tx: x.txHash,
            block: x.block?.number,
            v: x.verification,
          })),
          null,
          1,
        ),
      );
      console.log("with nft verdicts:", nft?.receipt?.result, JSON.stringify(nft?.verdicts));
      if (r.run?.receipt?.steps?.some((x) => x.txHash))
        state.nftItems = [...new Set([...(state.nftItems ?? []), item])];
      state.atomicFile = file.split("/").pop();
      saveState();
    }
  }
  process.exit(0);
}

/**
 * Revive: a 13-byte EVM test contract (this runtime has allowEVMBytecode = true), called through a SEAM plan.
 * Runtime code 0x36600a5760006000a0005b33ff:
 *   CALLDATASIZE PUSH1 0x0a JUMPI          empty calldata -> fall through, else jump to 0x0a
 *   PUSH1 0 PUSH1 0 LOG0 STOP              empty call: emits one empty-topic event (Revive.ContractEmitted)
 *   JUMPDEST CALLER SELFDESTRUCT           any calldata: self-destruct, beneficiary = caller (to free the deposit)
 * Init code copies those 13 bytes and returns them.
 * --revive-action deploy | inspect | call | terminate | remove-code
 * storage_deposit_limit is a hard on-chain limit (--deposit-limit tPOT): the deploy fails rather than charge more.
 * Without --submit everything is only signed and dry-run.
 */
if (STEP === "revive") {
  const RUNTIME = "36600a5760006000a0005b33ff";
  const INIT = `0x600d600c600039600d6000f3${RUNTIME}`;
  const action = flag("--revive-action") ?? "deploy";
  const limitPlanck =
    BigInt(Math.round(Number(flag("--deposit-limit") ?? 15) * 1e6)) * (UNIT / 1_000_000n);
  const weight = { refTime: 50_000_000_000n, proofSize: 1_000_000n };
  const contractInfo = async (h160) => readStorage(q.revive.accountInfoOf, h160);
  const contractBalances = async (h160) => {
    const inf = await contractInfo(h160);
    // The contract's own AccountId32 (fallback account: h160 ++ 0xEE x 12) holds its storage deposit.
    const acct = `${h160}${"ee".repeat(12)}`;
    const a = await accountOf(acct);
    return { info: inf, accountId: acct, free: a.free.toString(), reserved: a.reserved.toString() };
  };
  const snapshot = async () => {
    const me = await accountOf(ADDRESS);
    const out = {
      block: (await head()).best,
      signer: { free: me.free.toString(), reserved: me.reserved.toString() },
    };
    if (state.reviveContract) out.contract = await contractBalances(state.reviveContract);
    if (state.reviveCodeHash)
      out.pristineCode = (await readStorage(q.revive.pristineCode, state.reviveCodeHash)) !== null;
    if (state.reviveCodeHash)
      out.codeInfo = await readStorage(q.revive.codeInfoOf, state.reviveCodeHash);
    return out;
  };

  if (action === "inspect") {
    console.log(JSON.stringify(await snapshot(), null, 1));
    process.exit(0);
  }

  if (action === "deploy") {
    if (state.reviveContract) {
      console.error(`already deployed: ${state.reviveContract}`);
      process.exit(1);
    }
    const before = await snapshot();
    const args = facts.capabilities["Revive.instantiate_with_code"].args.map((a) => {
      const by = {
        value: 0n,
        weight_limit: weight,
        gas_limit: weight,
        storage_deposit_limit: limitPlanck,
        code: INIT,
        data: "0x",
        salt: null,
      };
      if (!(a.name in by)) throw new Error(`unknown instantiate_with_code argument ${a.name}`);
      return by[a.name];
    });
    const callHex = encodeCall(facts, "Revive", "instantiate_with_code", args);
    const rec = await sendTx({
      name: "revive-deploy",
      label: "revive.instantiate_with_code",
      callHex,
      decoded: `Revive.instantiate_with_code(value=0, weight_limit={ref_time:${weight.refTime},proof_size:${weight.proofSize}}, storage_deposit_limit=${limitPlanck} (${fmt(limitPlanck)} tPOT), code=${INIT}, data=0x, salt=None)`,
      expectedDeposit: limitPlanck,
    });
    const inst = (rec.events ?? []).find((e) => e.pallet === "Revive" && e.name === "Instantiated");
    rec.contract = inst ? inst.args[1] : undefined;
    rec.evmInitCode = INIT;
    rec.evmRuntimeCode = `0x${RUNTIME}`;
    rec.stateBefore = before;
    if (rec.contract) {
      state.reviveContract = rec.contract;
      const inf = await contractInfo(rec.contract);
      const ci = inf?.accountType?.contract ?? inf?.contract ?? inf;
      state.reviveCodeHash = ci?.codeHash ?? ci?.code_hash;
      state.reviveDeployTx = rec.txHash;
      saveState();
      rec.stateAfter = await snapshot();
      rec.depositFromEvents = (rec.events ?? [])
        .filter((e) => e.pallet === "Balances" && ["Transfer", "Held", "Reserved"].includes(e.name))
        .map((e) => `${e.pallet}.${e.name}(${e.args.join(", ")})`);
    }
    writeRun("revive-deploy", rec);
    console.log(
      `deploy: ${rec.outcome}; contract ${rec.contract}; code hash ${state.reviveCodeHash}; ${rec.outcome?.startsWith("dry") || rec.outcome?.startsWith("not") ? JSON.stringify(rec.signedDryRun?.detail) : ""}`,
    );
    process.exit(rec.success || rec.outcome?.startsWith("dry run only") ? 0 : 1);
  }

  if (action === "call" || action === "terminate") {
    // revive.call compiled by SEAM -> preflight -> policy (contract + selector allow-listed) -> approve -> sign ->
    // gate (fresh fingerprint + signed dry run) -> submit -> receipt.
    const contract = state.reviveContract;
    if (!contract) throw new Error("no contract deployed");
    const data = action === "call" ? "0x" : "0x01";
    const f = await retry(() => discover(RPC));
    const manifest = {
      version: 1,
      chain: { genesisHash: f.fingerprint.genesisHash, specVersion: f.fingerprint.specVersion },
      signer: { type: "ss58", value: ADDRESS },
      actions: [
        {
          id: action,
          kind: "revive.call",
          args: {
            contract,
            value: "0",
            data,
            gasLimit: "5000000000",
            proofSize: "200000",
            storageDepositLimit: "10000000000000",
          },
        },
      ],
    };
    const policy = devPolicy({
      bob: state.recipients[0],
      charlie: state.recipients[1],
      contract,
      demo: false,
      assetId: state.assetId,
      overrides: {
        allowedContracts: [contract],
        allowedSelectors: { [contract]: [data] },
        allowedRecipients: [ADDRESS],
        maxGasLimit: "100000000000",
      },
    });
    const env = {
      endpoint: RPC,
      blockTimeMs: 6000,
      declaredToken: {
        tokenSymbol: f.fingerprint.tokenSymbol,
        tokenDecimals: f.fingerprint.tokenDecimals,
      },
    };
    const plan = compile(manifest, f, {});
    console.log(
      `revive.call plan: ${plan.mode}; ${JSON.stringify(plan.steps.map((x) => ({ kind: x.kind, args: x.decodedArgs, call: x.encodedCall })))}`,
    );
    if (!SUBMIT) {
      const adapter = createPortaldotAdapter(RPC, { facts: f, blockTimeMs: 6000 });
      const { preflight } = await retry(() => adapter.preflight(plan));
      const pr = evaluatePolicy({ policy, plan, facts: f, preflight, manifest });
      console.log(
        "policy:",
        pr.allowed,
        JSON.stringify(pr.rules.filter((r) => r.outcome !== "pass")),
        JSON.stringify(preflight.simulation ?? preflight.steps),
      );
      process.exit(0);
    }
    const b = await budget();
    if (b.spent + UNIT / 5n + 10_000_000_000_000n > BigInt(b.capPlanck)) {
      console.error("STOP: revive.call would exceed the cap");
      process.exit(1);
    }
    const before = await snapshot();
    const n0 = await nextNonce(ADDRESS);
    let r;
    for (let i = 0; i < 5 && !r; i++) {
      try {
        r = await runFlow({
          facts: f,
          manifest,
          policy,
          signPayload: payloadSigner(signer, f),
          env,
          atomic: false,
        });
      } catch (e) {
        if ((await nextNonce(ADDRESS)) !== n0) throw e;
        console.warn(
          `runFlow failed before sending (${String(e.message).slice(0, 120)}); retrying`,
        );
        await new Promise((res) => setTimeout(res, 4000));
      }
    }
    const rel = `runs/plan-revive-${action}-${ts()}.json`;
    const base = {
      kind: `seam-plan-revive-${action}`,
      recordingVersion: 2,
      ranAt: new Date().toISOString(),
      contract,
      data,
      ...r,
      stateBefore: before,
    };
    save(rel, base);
    const st = r.run?.receipt?.steps?.[0];
    let inc;
    try {
      inc = st?.txHash && st.block?.hash ? await inclusionOf(st.block.hash, st.txHash) : undefined;
    } catch (e) {
      inc = { error: String(e.message) };
    }
    const after = await snapshot();
    save(rel, { ...base, inclusionEvents: inc, stateAfter: after });
    console.log(
      `revive.${action}: stage ${r.stage ?? r.run?.stage ?? "run"} result ${r.run?.receipt?.result} ${r.run?.reason ?? ""} tx ${st?.txHash} block #${st?.block?.number} step ${st?.status}/${st?.verification}`,
    );
    console.log(
      (inc?.events ?? []).map((e) => `${e.pallet}.${e.name}(${e.args.join(", ")})`).join("\n"),
    );
    console.log("before", JSON.stringify(before), "\nafter", JSON.stringify(after));
    state[`revive_${action}File`] = rel.split("/").pop();
    saveState();
    process.exit(0);
  }

  if (action === "remove-code") {
    const codeHash = state.reviveCodeHash;
    const before = await snapshot();
    const rec = await sendTx({
      name: "revive-remove-code",
      label: "revive.remove_code",
      callHex: encodeCall(facts, "Revive", "remove_code", [codeHash]),
      decoded: `Revive.remove_code(${codeHash})`,
    });
    rec.stateBefore = before;
    rec.stateAfter = await snapshot();
    writeRun("revive-remove-code", rec);
    console.log(`remove_code: ${rec.outcome}; ${JSON.stringify(rec.signedDryRun?.detail)}`);
    process.exit(0);
  }
  throw new Error(`unknown --revive-action ${action}`);
}

if (STEP === "balance") {
  const b = await budget();
  console.log(
    JSON.stringify(
      {
        address: ADDRESS,
        free: fmt(b.acct.free),
        reserved: fmt(b.acct.reserved),
        spent: fmt(b.spent),
        left: fmt(b.left),
        head: await head(),
      },
      null,
      1,
    ),
  );
  process.exit(0);
}

if (STEP === "map") {
  const h160 = h160Of(signer.publicKey);
  const before = await readStorage(q.revive.originalAccount, h160);
  console.log(`derived H160 ${h160}; OriginalAccount before: ${JSON.stringify(before)}`);
  const callHex = encodeCall(facts, "Revive", "map_account", []);
  const rec = await sendTx({
    name: "map-account",
    label: "revive.map_account",
    callHex,
    decoded: "Revive.map_account()",
    expectedDeposit: 5n * UNIT,
  });
  rec.derivedH160 = h160;
  rec.originalAccountBefore = before;
  rec.originalAccountAfter = await readStorage(q.revive.originalAccount, h160);
  rec.mappingVerified =
    rec.originalAccountAfter != null &&
    dec.registry.createType("AccountId32", rec.originalAccountAfter).toHex() ===
      u8aToHex(signer.publicKey);
  writeRun("map-account", rec);
  if (rec.success) Object.assign(state, { h160, mapTx: rec.txHash });
  saveState();
}

if (STEP === "nfts") {
  let collection = state.collection;
  if (collection === undefined) {
    const config = {
      settings: 0,
      maxSupply: null,
      mintSettings: {
        mintType: { Issuer: null },
        price: null,
        startBlock: null,
        endBlock: null,
        defaultItemSettings: 0,
      },
    };
    const callHex = encodeCall(facts, "Nfts", "create", [{ Id: ADDRESS }, config]);
    const rec = await sendTx({
      name: "nfts-create",
      label: "nfts.create",
      callHex,
      decoded: `Nfts.create(admin=${ADDRESS}, config=${JSON.stringify(config)})`,
      expectedDeposit: 2n * UNIT,
    });
    const created = (rec.events ?? []).find((e) => e.pallet === "Nfts" && e.name === "Created");
    if (created) collection = Number(String(created.args[0]).replace(/,/g, ""));
    rec.collection = collection;
    writeRun("nfts-create", rec);
    if (!rec.success) {
      saveState();
      process.exit(1);
    }
    state.collection = collection;
    saveState();
  }
  const item = 0;
  const callHex = encodeCall(facts, "Nfts", "mint", [collection, item, { Id: ADDRESS }, null]);
  const rec = await sendTx({
    name: "nfts-mint",
    label: "nfts.mint",
    callHex,
    decoded: `Nfts.mint(collection=${collection}, item=${item}, mint_to=${ADDRESS}, witness_data=None)`,
    expectedDeposit: UNIT / 2n,
  });
  rec.itemOwnerAfter = await readStorage(q.nfts.item, collection, item);
  writeRun("nfts-mint", rec);
  if (rec.success) state.nftItems = [...(state.nftItems ?? []), item];
  saveState();
}

if (STEP === "assets") {
  await cryptoWaitReady();
  let assetId = state.assetId;
  if (assetId === undefined) {
    for (;;) {
      const id = 700000 + Math.floor(Math.random() * 200000);
      if ((await readStorage(q.assets.asset, id)) === null) {
        assetId = id;
        break;
      }
    }
    const rec = await sendTx({
      name: "assets-create",
      label: "assets.create",
      callHex: encodeCall(facts, "Assets", "create", [assetId, { Id: ADDRESS }, 1]),
      decoded: `Assets.create(id=${assetId}, admin=${ADDRESS}, min_balance=1)`,
      expectedDeposit: 2n * UNIT,
    });
    writeRun("assets-create", rec);
    if (!rec.success) process.exit(1);
    state.assetId = assetId;
    saveState();
  }
  // Two fresh recipients (public addresses only; their mnemonics are discarded). Funded with 2x ED so they exist.
  if (!state.recipients) {
    const kr = new Keyring({ type: "sr25519", ss58Format: ss58 });
    state.recipients = [
      kr.addFromMnemonic(mnemonicGenerate()).address,
      kr.addFromMnemonic(mnemonicGenerate()).address,
    ];
    state.recipientsFunded = [];
    saveState();
  }
  const ed = BigInt(dec.decorated().consts.balances.existentialDeposit.toString());
  for (const to of state.recipients) {
    if (state.recipientsFunded.includes(to)) continue;
    const rec = await sendTx({
      name: "fund-recipient",
      label: "balances.transfer_keep_alive",
      callHex: encodeCall(facts, "Balances", "transfer_keep_alive", [
        { Id: to },
        (ed * 2n).toString(),
      ]),
      decoded: `Balances.transfer_keep_alive(${to}, ${ed * 2n})`,
      expectedDeposit: ed * 2n,
    });
    writeRun("fund-recipient", rec);
    if (!rec.success) process.exit(1);
    state.recipientsFunded.push(to);
    saveState();
  }
  if (!state.assetMinted) {
    const rec = await sendTx({
      name: "assets-mint",
      label: "assets.mint",
      callHex: encodeCall(facts, "Assets", "mint", [assetId, { Id: ADDRESS }, "1000000000"]),
      decoded: `Assets.mint(id=${assetId}, beneficiary=${ADDRESS}, amount=1000000000)`,
    });
    rec.assetBalanceAfter = await readStorage(q.assets.account, assetId, ADDRESS);
    writeRun("assets-mint", rec);
    if (!rec.success) process.exit(1);
    state.assetMinted = true;
    saveState();
  }
  if (!state.assetTransferred) {
    const to = state.recipients[0];
    const rec = await sendTx({
      name: "assets-transfer",
      label: "assets.transfer_keep_alive",
      callHex: encodeCall(facts, "Assets", "transfer_keep_alive", [assetId, { Id: to }, "1000"]),
      decoded: `Assets.transfer_keep_alive(id=${assetId}, target=${to}, amount=1000)`,
    });
    rec.assetBalancesAfter = {
      signer: await readStorage(q.assets.account, assetId, ADDRESS),
      recipient: await readStorage(q.assets.account, assetId, to),
    };
    writeRun("assets-transfer", rec);
    if (!rec.success) process.exit(1);
    state.assetTransferred = true;
    saveState();
  }
}

export {
  fmt,
  sendTx,
  readStorage,
  accountOf,
  state,
  saveState,
  writeRun,
  facts,
  ADDRESS,
  RPC,
  OUT,
  save,
  SUBMIT,
  budget,
  UNIT,
  signer,
  runFlow,
  devPolicy,
  runAllFlows,
  rollbackProofFromEvidence,
  writeFileSync,
  mkdirSync,
};
