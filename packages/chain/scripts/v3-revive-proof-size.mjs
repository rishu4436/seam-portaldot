#!/usr/bin/env node
// READ-ONLY investigation: where does Revive's proof_size = 0 come from on V3 (spec 3002), and is there a
// MEASURED proof-size bound for an instantiate? Nothing is signed, submitted or deployed, and no extrinsic with
// any signature (real or dummy) is built. Only read RPC methods can reach the node (allow-list below).
//   npm run build -w @seam/chain && node packages/chain/scripts/v3-revive-proof-size.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiPromise, HttpProvider } from "@polkadot/api";
import { httpRpcClient, decodeWeightV2Prefix, reviveWeightBound } from "../dist/index.js";

const URL_ = "https://test-node-v3.portaldot.dev";
const V3_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const SEAM_DEMO = "5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE";
const BUDGET_ACCOUNT = "5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1";
const DEPLOY_BLOCK = "0x0123735173c22926d06327d9e746459a4ab7ee5f38b6b6cae3f93443a6983ef1"; // #102843 (checkpoint #102840)
const DEPLOY_EXTRINSIC_INDEX = 1;
const ESCROW_VALUE = 10n ** 12n;
const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const READ =
  /^(chain_getBlockHash|chain_getHeader|chain_getFinalizedHead|chain_getBlock|state_call|state_getRuntimeVersion|state_getStorage|rpc_methods|eth_chainId|eth_estimateGas|eth_call|eth_gasPrice|eth_blockNumber)$/;
const short = (p) =>
  typeof p === "string" && p.length > 600
    ? `${p.slice(0, 80)}…<${(p.length - 2) / 2} bytes, sha256 ${createHash("sha256").update(p).digest("hex")}>`
    : p;
const calls = [];
const clients = {};
const send = async (method, params, url = URL_) => {
  if (!READ.test(method)) throw new Error(`refusing non-read method ${method}`);
  clients[url] ??= httpRpcClient(url, { requestTimeoutMs: 90_000 });
  let result, error;
  try {
    result = await clients[url].send(method, params);
  } catch (e) {
    error = String(e?.message ?? e);
  }
  calls.push({
    url,
    method,
    params: JSON.parse(JSON.stringify(params, (_, v) => short(v))),
    result: short(typeof result === "string" ? result : undefined) ?? result,
    error,
  });
  if (error) throw new Error(error);
  return result;
};
const trySend = (m, p, u) =>
  send(m, p, u).then(
    (r) => ({ ok: true, result: r }),
    (e) => ({ ok: false, error: e.message }),
  );

const api = await ApiPromise.create({ provider: new HttpProvider(URL_), noInitWarn: true });
const out = {
  kind: "DRY RUN ONLY — nothing signed, submitted or deployed; no signature bytes built",
};
try {
  if ((await send("chain_getBlockHash", [0])) !== V3_GENESIS) throw new Error("not V3");
  const atHash = await send("chain_getFinalizedHead", []);
  const at = await send("chain_getHeader", [atHash]);
  const rv = await send("state_getRuntimeVersion", [atHash]);
  if (rv.specVersion !== 3002) throw new Error(`spec ${rv.specVersion}`);
  out.at = { block: parseInt(at.number, 16), hash: atHash, specVersion: rv.specVersion };
  const apiAt = await api.at(atHash);
  const reg = api.registry;
  const md = api.runtimeMetadata.asLatest;
  const tdef = (id) => reg.lookup.getTypeDef(id).type;
  const method = (apiName, m) => {
    const mm = md.apis
      .find((x) => x.name.toString() === apiName)
      .methods.find((x) => x.name.toString() === m);
    return {
      name: `${apiName}_${m}`,
      enc: (vals) =>
        "0x" +
        mm.inputs
          .map((i, k) =>
            Buffer.from(
              reg.createTypeUnsafe(reg.createLookupType(i.type), [vals[k]]).toU8a(),
            ).toString("hex"),
          )
          .join(""),
      dec: (hex) => reg.createTypeUnsafe(reg.createLookupType(mm.output), [hex]),
    };
  };
  const rawCall = async (apiName, m, vals) => {
    const mm = method(apiName, m);
    const raw = await send("state_call", [mm.name, mm.enc(vals), atHash]);
    const d = mm.dec(raw);
    return { raw, decoded: d.toJSON(), human: d.toHuman() };
  };

  // 1. signatures from metadata
  const rapi = md.apis.find((x) => x.name.toString() === "ReviveApi");
  out.signatures = Object.fromEntries(
    rapi.methods
      .filter((m) =>
        [
          "instantiate",
          "call",
          "upload_code",
          "eth_transact",
          "eth_estimate_gas",
          "eth_pre_dispatch_weight",
          "block_gas_limit",
          "max_extrinsic_weight_in_gas",
          "gas_price",
        ].includes(m.name.toString()),
      )
      .map((m) => [
        m.name.toString(),
        { inputs: m.inputs.map((i) => `${i.name}: ${tdef(i.type)}`), output: tdef(m.output) },
      ]),
  );
  const outId = rapi.methods.find((m) => m.name.toString() === "instantiate").output.toNumber();
  out.contractResultLayout = reg.lookup
    .getSiType(outId)
    .def.asComposite.fields.map((f) => ({ name: f.name.toString(), type: tdef(f.type) }));
  out.weightV2Layout =
    "Weight { ref_time: Compact<u64>, proof_size: Compact<u64> } (SCALE compact, not fixed u64)";
  const k = apiAt.consts;
  out.constants = {
    blockWeights: k.system.blockWeights.toJSON(),
    reviveGasScale: k.revive.gasScale.toJSON(),
    reviveNativeToEthRatio: k.revive.nativeToEthRatio.toJSON(),
    reviveMaxEthExtrinsicWeight: k.revive.maxEthExtrinsicWeight.toString(),
  };
  const maxExt = k.system.blockWeights.perClass.normal.maxExtrinsic.unwrap();
  const MAXW = { refTime: maxExt.refTime.toBigInt(), proofSize: maxExt.proofSize.toBigInt() };

  const demoH160 = (await rawCall("ReviveApi", "address", [SEAM_DEMO])).decoded;
  const info = JSON.parse(
    readFileSync(root("contracts/escrow/artifacts/min/build-info.json"), "utf8"),
  );
  const pick = (id) => info.variants.find((v) => v.id === id);
  const variants = [
    {
      v: pick("SeamEscrowOne-r1"),
      file: "SeamEscrowOne-r1.init",
      value: ESCROW_VALUE,
      args:
        "0x" +
        demoH160.replace(/^0x/, "").padStart(64, "0") +
        BigInt(out.at.block + 1000)
          .toString(16)
          .padStart(64, "0"),
    },
    { v: pick("Floor-stop"), file: "Floor.init", value: 0n, args: "0x" },
  ];

  const inst = (code, value, gas) =>
    rawCall("ReviveApi", "instantiate", [
      BUDGET_ACCOUNT,
      value,
      gas,
      null,
      { Upload: code },
      "0x",
      null,
    ]);
  const summarize = (r) => {
    const d = r.decoded;
    const ok = !!d.result?.ok;
    return {
      ok,
      error: ok ? null : r.human.result,
      weightConsumed: d.weightConsumed,
      weightRequired: d.weightRequired,
      gasConsumed: d.gasConsumed?.toString?.() ?? d.gasConsumed,
      storageDeposit: d.storageDeposit,
      maxStorageDeposit: d.maxStorageDeposit,
      // Independent hand decode of the first two compact Weights in the raw SCALE bytes (cross-check of the decoder).
      rawPrefixHandDecoded: decodeWeightV2Prefix(r.raw),
      raw: short(r.raw),
    };
  };
  out.variants = [];
  for (const { v, file, value, args } of variants) {
    const code =
      "0x" +
      readFileSync(root(`contracts/escrow/artifacts/min/${file}`)).toString("hex") +
      args.replace(/^0x/, "");
    const row = {
      id: v.id,
      codeBytes: (code.length - 2) / 2,
      codeSha256: createHash("sha256").update(code).digest("hex"),
    };
    const none = summarize(await inst(code, value, null));
    const max = summarize(await inst(code, value, MAXW));
    const rt = BigInt(none.weightRequired.refTime);
    const tightRefOnly = summarize(await inst(code, value, { refTime: rt, proofSize: 0n }));
    const tightBoth = summarize(await inst(code, value, { refTime: rt - rt / 10n, proofSize: 0n }));
    row.dryRuns = {
      gasLimitNone: none,
      gasLimitBlockMaxExtrinsic: {
        limit: { refTime: MAXW.refTime.toString(), proofSize: MAXW.proofSize.toString() },
        ...max,
      },
      tightRefTimeExactProofZero: {
        limit: { refTime: rt.toString(), proofSize: "0" },
        ...tightRefOnly,
      },
      refTimeMinus10pctProofZero: {
        limit: { refTime: (rt - rt / 10n).toString(), proofSize: "0" },
        ...tightBoth,
      },
    };
    // Binary search on refTime (proofSize limit 0) for the smallest ref_time that passes.
    let lo = 0n,
      hi = rt;
    while (hi - lo > 1000n) {
      const mid = (lo + hi) / 2n;
      if ((await inst(code, value, { refTime: mid, proofSize: 0n })).decoded.result?.ok) hi = mid;
      else lo = mid;
    }
    row.minRefTimePassingWithProofZero = hi.toString();
    row.proofSizeSearch = tightRefOnly.ok
      ? "not needed: a proof_size LIMIT of 0 already passes, so proof size is not metered by this runtime's instantiate path"
      : "proof_size 0 failed; see dryRuns";
    row.bound = reviveWeightBound(none, 0.2);
    // Fee/weight of the call with explicit limits — call-only API, no extrinsic, no signature.
    // Fee/weight of the call with explicit limits — call-only API (TransactionPaymentCallApi), no extrinsic, no
    // signature. TransactionPaymentApi_query_info needs a signed extrinsic, so it is NOT used here.
    const qm = method("TransactionPaymentCallApi", "query_call_info");
    row.queryCallInfo = [];
    for (const proofSize of [0n, 1_000_000n, MAXW.proofSize]) {
      const lim = { refTime: rt + rt / 5n, proofSize };
      const tx = api.tx.revive.instantiateWithCode(
        value,
        lim,
        BigInt(none.storageDeposit.charge ?? 0) * 2n,
        code,
        "0x",
        null,
      );
      const len = (tx.method.toHex().length - 2) / 2 + 106;
      const qi = await send("state_call", [qm.name, qm.enc([tx.method, len]), atHash]);
      const dj = qm.dec(qi).toJSON();
      row.queryCallInfo.push({
        limitUsed: { refTime: lim.refTime.toString(), proofSize: lim.proofSize.toString() },
        len,
        decoded: dj,
        preDispatchProofSize: BigInt(dj.weight.proofSize).toString(),
        staticProofOverhead: (BigInt(dj.weight.proofSize) - proofSize).toString(),
      });
    }
    // Eth side via runtime API (no signature needed: an unsigned GenericTransaction).
    const from = (await rawCall("ReviveApi", "address", [BUDGET_ACCOUNT])).decoded;
    const gtx = {
      from,
      input: { input: code, data: null },
      value: value * 10000n,
      authorizationList: [],
      blobVersionedHashes: [],
      blobs: [],
    };
    try {
      const eg = await rawCall("ReviveApi", "eth_estimate_gas", [gtx, {}]);
      row.ethEstimateGasRuntimeApi = eg.human;
    } catch (e) {
      row.ethEstimateGasRuntimeApi = { error: String(e.message) };
    }
    try {
      const et = await rawCall("ReviveApi", "eth_transact", [gtx]);
      row.ethTransactRuntimeApi = et.decoded?.ok ? { ...et.decoded.ok, data: undefined } : et.human;
    } catch (e) {
      row.ethTransactRuntimeApi = { error: String(e.message) };
    }
    row.ethJsonRpc = {};
    for (const u of [URL_, `${URL_}/eth`]) {
      row.ethJsonRpc[u] = {
        eth_chainId: await trySend("eth_chainId", [], u),
        eth_estimateGas: await trySend(
          "eth_estimateGas",
          [{ from, data: code, value: "0x" + (value * 10000n).toString(16) }],
          u,
        ),
      };
    }
    out.variants.push(row);
  }
  out.rpcMethods = (await send("rpc_methods", [])).methods.filter((m) => /^eth_|revive/i.test(m));
  out.blockGasLimit = (await rawCall("ReviveApi", "block_gas_limit", [])).human;
  out.maxExtrinsicWeightInGas = (
    await rawCall("ReviveApi", "max_extrinsic_weight_in_gas", [])
  ).human;

  // 4. the real 13-byte deploy: ExtrinsicSuccess dispatch_info at #102843 ext 1
  const evAt = await api.at(DEPLOY_BLOCK);
  const events = await evAt.query.system.events();
  out.onChainDeploy = {
    block: 102843,
    blockHash: DEPLOY_BLOCK,
    extrinsicIndex: DEPLOY_EXTRINSIC_INDEX,
    events: events
      .filter(
        (e) =>
          e.phase.isApplyExtrinsic &&
          e.phase.asApplyExtrinsic.toNumber() === DEPLOY_EXTRINSIC_INDEX,
      )
      .map((e) => ({
        section: e.event.section,
        method: e.event.method,
        data: e.event.data.toJSON(),
      })),
  };
  writeFileSync(
    "/tmp/ps/out.json",
    JSON.stringify(
      { ...out, rawRpc: calls },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
  console.log("ok");
} finally {
  await api.disconnect();
}
