#!/usr/bin/env node
// READ-ONLY dry run of the trimmed P1-02 escrow variants (contracts/escrow/EscrowMin.sol, artifacts/min) on V3.
// Nothing is signed, submitted or deployed, and NO extrinsic is built with any signature (not even a fake one):
// fees come from TransactionPaymentCallApi_query_call_info(call, len), len = call bytes + the signed-envelope overhead
// measured in escrow-dryrun-1792555095045 (106 bytes). Only read RPC methods can reach the node.
// For each variant: ReviveApi_instantiate (limits None), ReviveApi_upload_code, then ReviveApi_instantiate again with
// EXPLICIT weight (2x refTime, proof from the run, floor 0 kept as "unknown") and deposit limit (charge + 5%).
//   npm run build -w @seam/chain && node packages/chain/scripts/v3-escrow-min-dryrun.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiPromise, HttpProvider } from "@polkadot/api";
import { httpRpcClient, deployBudgetFit } from "../dist/index.js";

const URL_ = "https://test-node-v3.portaldot.dev";
const V3_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const SEAM_DEMO = "5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE";
const BUDGET_ACCOUNT = "5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1";
const SIGNED_OVERHEAD = 106; // extrinsicBytes - callBytes, measured in escrow-dryrun-1792555095045
const ESCROW_VALUE = 10n ** 12n; // 0.01 tPOT, only so SeamEscrowOne's constructor (needs msg.value) can run in the dry run
const DEC = 14;
const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const fmt = (v) => {
  const n = BigInt(v);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const u = 10n ** BigInt(DEC);
  const f = (a % u).toString().padStart(DEC, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / u}${f ? `.${f}` : ""} tPOT`;
};
const READ =
  /^(chain_getBlockHash|chain_getHeader|chain_getFinalizedHead|state_call|state_getRuntimeVersion|state_getStorage)$/;
const c = httpRpcClient(URL_, { requestTimeoutMs: 90_000 });
const calls = [];
const send = async (method, params) => {
  if (!READ.test(method)) throw new Error(`refusing non-read method ${method}`);
  const result = await c.send(method, params);
  calls.push({
    method,
    params: params.map((p) =>
      typeof p === "string" && p.length > 600
        ? `${p.slice(0, 80)}…<${(p.length - 2) / 2} bytes, sha256 ${createHash("sha256").update(p).digest("hex")}>`
        : p,
    ),
    // Full raw RPC result, never truncated, so the decoded figures can be re-checked from it.
    result,
  });
  return result;
};

const api = await ApiPromise.create({ provider: new HttpProvider(URL_), noInitWarn: true });
try {
  const genesis = await send("chain_getBlockHash", [0]);
  if (genesis !== V3_GENESIS) throw new Error(`not the V3 test node (genesis ${genesis})`);
  const atHash = await send("chain_getFinalizedHead", []);
  const at = await send("chain_getHeader", [atHash]);
  const blockNumber = parseInt(at.number, 16);
  const rv = await send("state_getRuntimeVersion", [atHash]);
  if (rv.specVersion !== 3002) throw new Error(`expected spec 3002, got ${rv.specVersion}`);
  const apiAt = await api.at(atHash);
  const reg = api.registry;
  const md = api.runtimeMetadata.asLatest;
  const method = (apiName, m) => {
    const a = md.apis.find((x) => x.name.toString() === apiName);
    if (!a) throw new Error(`runtime api ${apiName} not in metadata`);
    const mm = a.methods.find((x) => x.name.toString() === m);
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
    const out = await send("state_call", [mm.name, mm.enc(vals), atHash]);
    const d = mm.dec(out);
    return { decoded: d.toJSON(), human: d.toHuman() };
  };

  const k = apiAt.consts.revive;
  const constants = {
    depositPerByte: k.depositPerByte.toString(),
    depositPerItem: k.depositPerItem.toString(),
    codeHashLockupDepositPercent: k.codeHashLockupDepositPercent.toString(),
    allowEVMBytecode: k.allowEVMBytecode.toJSON(),
    existentialDeposit: apiAt.consts.balances.existentialDeposit.toString(),
  };
  const acct = await apiAt.query.system.account(BUDGET_ACCOUNT);
  const demoH160 = (await rawCall("ReviveApi", "address", [SEAM_DEMO])).decoded;
  const budgetFree = acct.data.free.toString();

  const info = JSON.parse(
    readFileSync(root("contracts/escrow/artifacts/min/build-info.json"), "utf8"),
  );
  const ctorArgs = (id) =>
    id.startsWith("SeamEscrowOne")
      ? "0x" +
        demoH160.replace(/^0x/, "").padStart(64, "0") +
        BigInt(blockNumber + 1000)
          .toString(16)
          .padStart(64, "0")
      : "0x";

  const budget = JSON.parse(readFileSync(root("evidence/testnet-v3/budget.json"), "utf8"));
  const left = BigInt(budget.spent.leftUnderCapPlanck);
  const TARGET = 450000000000000n; // ~4.5 tPOT (Anchor)
  const results = [];
  for (const v of info.variants) {
    const file = v.id === "Floor-stop" ? "Floor.init" : `${v.id}.init`;
    // pallet-revive EVM constructors take no `data` (EvmConstructorNonEmptyData): args are appended to the init code.
    const code =
      "0x" +
      readFileSync(root(`contracts/escrow/artifacts/min/${file}`)).toString("hex") +
      ctorArgs(v.id).replace(/^0x/, "");
    const data = "0x";
    const value = v.id.startsWith("SeamEscrowOne") ? ESCROW_VALUE : 0n;
    const inst = await rawCall("ReviveApi", "instantiate", [
      BUDGET_ACCOUNT,
      value,
      null,
      null,
      { Upload: code },
      data,
      null,
    ]);
    const up = await rawCall("ReviveApi", "upload_code", [BUDGET_ACCOUNT, code, null]);
    const d = inst.decoded;
    if (!d.result?.ok) {
      results.push({ variant: v, error: inst.human.result, uploadCode: up.decoded });
      continue;
    }
    if (d.result.ok.result?.data && d.result.ok.result.data.length > 200)
      d.result.ok.result.data = `<${(d.result.ok.result.data.length - 2) / 2} bytes>`;
    const charge = BigInt(d.storageDeposit.charge);
    const codeDep = up.decoded?.ok ? BigInt(up.decoded.ok.deposit) : null;
    const wr = d.weightRequired;
    // Explicit limits per Sentinel: 2x refTime; proof from the run (0 recorded as unknown, a floor of 0 is NOT a pass)
    const proofKnown = BigInt(wr.proofSize) > 0n;
    const limW = {
      refTime: BigInt(wr.refTime) * 2n,
      proofSize: proofKnown ? BigInt(wr.proofSize) * 2n : 0n,
    };
    const limD = charge + charge / 20n;
    const inst2 = await rawCall("ReviveApi", "instantiate", [
      BUDGET_ACCOUNT,
      value,
      limW,
      limD,
      { Upload: code },
      data,
      null,
    ]);
    const d2 = inst2.decoded;
    if (d2.result?.ok?.result?.data && d2.result.ok.result.data.length > 200)
      d2.result.ok.result.data = `<${(d2.result.ok.result.data.length - 2) / 2} bytes>`;
    // Fee: the deploy call with the explicit limits, no signature anywhere.
    const tx = api.tx.revive.instantiateWithCode(value, limW, limD, code, data, null);
    const callHex = tx.method.toHex();
    const callBytes = (callHex.length - 2) / 2;
    const len = callBytes + SIGNED_OVERHEAD;
    const qm = method("TransactionPaymentCallApi", "query_call_info");
    const fee = await send("state_call", [qm.name, qm.enc([tx.method, len]), atHash]).then((o) =>
      qm.dec(o).toJSON(),
    );
    const partialFee = BigInt(fee.partialFee);
    const fit = deployBudgetFit(
      { fee: partialFee, storageDeposit: charge },
      left,
      BigInt(budgetFree),
      BigInt(constants.existentialDeposit),
    );
    results.push({
      variant: v,
      value: value.toString(),
      ctorArgsAppendedToCode: ctorArgs(v.id),
      deployCodeBytes: (code.length - 2) / 2,
      dryRunNoLimits: d,
      uploadCode: up.decoded,
      storageDeposit: {
        charge: charge.toString(),
        chargeFmt: fmt(charge),
        codeUploadPart: codeDep?.toString() ?? null,
        codeUploadPartFmt: codeDep === null ? null : fmt(codeDep),
        contractPart: codeDep === null ? null : (charge - codeDep).toString(),
        contractPartFmt: codeDep === null ? null : fmt(charge - codeDep),
      },
      weightRequired: wr,
      proofSize: proofKnown ? wr.proofSize : "UNKNOWN (dry run reported 0; not a passed limit)",
      explicitLimits: {
        weight: { refTime: limW.refTime.toString(), proofSize: limW.proofSize.toString() },
        storageDepositLimit: limD.toString(),
        storageDepositLimitFmt: fmt(limD),
      },
      dryRunExplicit: {
        ok: !!d2.result?.ok,
        result: d2.result?.ok ? "ok" : inst2.human.result,
        weightRequired: d2.weightRequired,
        storageDepositCharge:
          d2.storageDeposit?.charge != null ? BigInt(d2.storageDeposit.charge).toString() : null,
      },
      fee: {
        callBytes,
        assumedExtrinsicBytes: len,
        queryCallInfo: fee,
        partialFee: partialFee.toString(),
        partialFeeFmt: fmt(partialFee),
      },
      total: fit.total.toString(),
      totalFmt: fmt(fit.total),
      fitsTarget4_5: fit.total <= TARGET,
      fitsBudgetLeft: fit.fits,
      marginVsBudgetLeftFmt: fmt(fit.margin),
    });
  }

  const ts = Date.now();
  const rec = {
    kind: "escrow-min-deploy-dryrun",
    label:
      "DRY RUN ONLY: nothing was signed, submitted or deployed. No extrinsic was signed, not even with a fake signature; fees via TransactionPaymentCallApi_query_call_info.",
    at: new Date(ts).toISOString(),
    rpc: URL_,
    genesis,
    block: { number: blockNumber, hash: atHash },
    specVersion: rv.specVersion,
    constants,
    budgetAccount: { address: BUDGET_ACCOUNT, free: budgetFree, freeFmt: fmt(budgetFree) },
    budget: { leftUnderCapPlanck: left.toString(), left: fmt(left), target: fmt(TARGET) },
    build: info,
    results,
    rawCalls: calls,
  };
  const base = root(`evidence/testnet-v3/escrow-min-dryrun-${ts}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(rec, null, 2)}\n`);
  console.log(base);
  console.log(
    JSON.stringify(
      {
        block: blockNumber,
        constants,
        left: fmt(left),
        results: results.map((r) => ({
          id: r.variant.id,
          init: r.variant.initBytes,
          rt: r.variant.runtimeBytes,
          err: r.error,
          dep: r.storageDeposit,
          w: r.weightRequired,
          exp: r.dryRunExplicit,
          fee: r.fee?.partialFeeFmt,
          total: r.totalFmt,
          fit: r.fitsTarget4_5,
        })),
      },
      null,
      1,
    ),
  );
} finally {
  await api.disconnect();
}
