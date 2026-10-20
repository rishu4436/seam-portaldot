#!/usr/bin/env node
// READ-ONLY: find a tx on the V3 test node by scanning finalized blocks backwards for blake2-256(extrinsic) == hash,
// then verify it independently (same method as v3-independent-verify.mjs: canonical + finalized, signer and call decoded
// with the block's own metadata, System.Events filtered to the extrinsic, dispatch result, fee from TransactionFeePaid).
//   node packages/chain/scripts/v3-find-tx.mjs --hash 0x… [--signer ss58] [--max-blocks 3000] [--out file]
import { writeFileSync } from "node:fs";
import { Metadata, TypeRegistry } from "@polkadot/types";
import { compactStripLength, hexToU8a, u8aToHex } from "@polkadot/util";
import { blake2AsHex, decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { httpRpcClient } from "../dist/index.js";
import { readFileSync } from "node:fs";
import { computePlanDigest } from "@seam/compiler";
import { classify, deltaMatches, planCallMatch } from "./v3-independent-lib.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const ENDPOINT = opt("--endpoint", "https://test-node-v3.portaldot.dev");
const HASH = opt("--hash", "").toLowerCase();
const SIGNER = opt("--signer");
const MAX = Number(opt("--max-blocks", "3000"));
const OUT = opt("--out");
// Optional: --plan <file with a SEAM plan or {plan}> compares call bytes and plan digest; --asset <id> reads the signer's
// and every Assets.Transferred party's balance of that asset (and the signer's free tPOT) at block-1 and block.
const PLAN_FILE = opt("--plan");
const ASSET = opt("--asset");
const GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const SYSTEM_EVENTS = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
if (!/^0x[0-9a-f]{64}$/.test(HASH)) throw new Error("--hash 0x<64 hex> required");

const rpc = httpRpcClient(ENDPOINT, { readAttempts: 6, requestTimeoutMs: 90_000 });
const call = (m, p = []) => rpc.send(m, p);
// decorated storage fns return the key SCALE-encoded as Vec<u8>; strip the length prefix
const skey = (fn, ...args) => u8aToHex(compactStripLength(fn(...args))[1]);
const ss58 = (u8a) => encodeAddress(u8a, 42);
function prim(a) {
  const t = a.toRawType();
  if (t === "AccountId32" || t === "AccountId") return u8aToHex(a.toU8a());
  if (t === "Bytes" || t === "Vec<u8>") return a.toHex();
  const v = a.toPrimitive();
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

try {
  if ((await call("chain_getBlockHash", [0])).toLowerCase() !== GENESIS)
    throw new Error("not the V3 test node");
  const finHash = await call("chain_getFinalizedHead");
  const finNum = parseInt((await call("chain_getHeader", [finHash])).number, 16);
  let found;
  for (let n = finNum; n > finNum - MAX && n > 0; n--) {
    const bh = await call("chain_getBlockHash", [n]);
    const b = await call("chain_getBlock", [bh]);
    const idx = b.block.extrinsics.findIndex((x) => blake2AsHex(hexToU8a(x), 256) === HASH);
    if (idx >= 0) {
      found = { n, bh, idx, xt: b.block.extrinsics[idx] };
      break;
    }
  }
  if (!found) {
    const out = { hash: HASH, outcome: "not_found", scanned: `#${finNum - MAX + 1}..#${finNum}` };
    console.log(JSON.stringify(out, null, 2));
    if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
    process.exitCode = 2;
  } else {
    const meta = await call("state_getMetadata", [found.bh]);
    const reg = new TypeRegistry();
    const md = new Metadata(reg, meta);
    reg.setMetadata(md);
    reg.query = (await import("@polkadot/types")).expandMetadata(reg, md).query;
    const xt = reg.createType("Extrinsic", found.xt);
    const signer = ss58(decodeAddress(xt.signer.toString()));
    const c = xt.method;
    const describe = (ic) => ({
      call: `${ic.section}.${ic.method}`,
      args: Object.fromEntries(
        ic.meta.args.map((a, i) => [a.name.toString(), ic.args[i].toJSON()]),
      ),
    });
    const calls = c.section === "utility" ? c.args[0].map(describe) : [describe(c)];
    const recs = reg.createType(
      "Vec<FrameSystemEventRecord>",
      await call("state_getStorage", [SYSTEM_EVENTS, found.bh]),
    );
    const evs = recs
      .filter((r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === found.idx)
      .map((r) => ({
        pallet: r.event.section.charAt(0).toUpperCase() + r.event.section.slice(1),
        name: r.event.method,
        args: r.event.data.map(prim),
        raw: r.event,
      }));
    let dispatch;
    if (evs.some((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess"))
      dispatch = { ok: true };
    const failed = evs.find((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
    if (failed) {
      const err = failed.raw.data[0];
      dispatch = err.isModule
        ? {
            ok: false,
            error: (({ section, name }) => `${section}.${name}`)(reg.findMetaError(err.asModule)),
          }
        : { ok: false, error: err.type };
    }
    const fee = evs
      .filter((e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid")
      .reduce((s, e) => s + BigInt(e.args[1]), 0n);
    const callHex = c.toHex();
    const innerCallHexes = c.section === "utility" ? c.args[0].map((ic) => ic.toHex()) : undefined;
    let plan;
    if (PLAN_FILE) {
      const pf = JSON.parse(readFileSync(PLAN_FILE, "utf8"));
      const p = pf.plan ?? pf;
      let recomputed;
      try {
        recomputed = computePlanDigest(p);
      } catch (e) {
        recomputed = `not computable: ${e.message}`;
      }
      const m = planCallMatch(p, { callHex, innerCallHexes });
      plan = {
        file: PLAN_FILE,
        planDigest: p.planDigest,
        recomputedPlanDigest: recomputed,
        planDigestMatches: recomputed === p.planDigest,
        signerMatches: p.signer?.value === signer,
        callMatch: m.match,
        callReason: m.reason,
        planCalls: p.steps.map((s) => s.encodedCall),
      };
    }
    let balances;
    if (ASSET) {
      const parentHash = await call("chain_getBlockHash", [found.n - 1]);
      const accounts = new Set([u8aToHex(decodeAddress(signer))]);
      for (const e of evs)
        if (e.pallet === "Assets" && e.name === "Transferred" && e.args[0] === String(ASSET)) {
          accounts.add(e.args[1]);
          accounts.add(e.args[2]);
        }
      const q = async (key, at) => call("state_getStorage", [key, at]);
      const assetBal = async (who, at) => {
        const raw = await q(skey(reg.query.assets.account, ASSET, who), at);
        return raw ? reg.createType("PalletAssetsAssetAccount", raw).balance.toString() : "0";
      };
      const free = async (who, at) => {
        const raw = await q(skey(reg.query.system.account, who), at);
        return raw ? reg.createType("FrameSystemAccountInfo", raw).data.free.toString() : "0";
      };
      balances = { asset: String(ASSET), before: found.n - 1, after: found.n, accounts: {} };
      for (const a of accounts) {
        const b0 = await assetBal(a, parentHash);
        const b1 = await assetBal(a, found.bh);
        balances.accounts[ss58(hexToU8a(a))] = {
          assetBefore: b0,
          assetAfter: b1,
          assetDelta: (BigInt(b1) - BigInt(b0)).toString(),
        };
      }
      const f0 = await free(signer, parentHash);
      const f1 = await free(signer, found.bh);
      balances.signerFree = {
        before: f0,
        after: f1,
        drop: (BigInt(f0) - BigInt(f1)).toString(),
        dropEqualsFee: deltaMatches(f1, f0, fee),
      };
    }
    const canonical = await call("chain_getBlockHash", [found.n]);
    const c2 = classify({
      canonicalHash: canonical,
      recordedBlockHash: found.bh,
      blockNumber: found.n,
      finalizedNumber: finNum,
      extrinsicIndex: found.idx,
      recordedIndex: found.idx,
      callMatch: PLAN_FILE
        ? planCallMatch(
            JSON.parse(readFileSync(PLAN_FILE, "utf8")).plan ??
              JSON.parse(readFileSync(PLAN_FILE, "utf8")),
            { callHex, innerCallHexes },
          ).match
        : null,
      signerMatch: SIGNER ? signer === SIGNER : null,
      dispatch,
      events: null,
    });
    const out = {
      kind: "seam-v3-tx-verification",
      generatedAt: new Date().toISOString(),
      endpoint: ENDPOINT,
      genesis: GENESIS,
      finalizedHead: { number: finNum, hash: finHash },
      hash: HASH,
      block: { number: found.n, hash: found.bh },
      canonical: canonical.toLowerCase() === found.bh.toLowerCase(),
      finalized: found.n <= finNum,
      extrinsicIndex: found.idx,
      signer,
      signerMatch: SIGNER ? signer === SIGNER : null,
      call: `${c.section}.${c.method}`,
      callHex,
      calls,
      ...(plan ? { plan } : {}),
      ...(balances ? { balances } : {}),
      dispatch,
      fee: fee.toString(),
      events: evs.map(({ pallet, name, args }) => ({ pallet, name, args })),
      outcome: c2.outcome,
      reasons: c2.reasons,
    };
    console.log(JSON.stringify(out, null, 2));
    if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  }
} finally {
  rpc.close();
}
