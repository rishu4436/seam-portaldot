#!/usr/bin/env node
// READ-ONLY dry run of the P1-02 SeamEscrow deploy on the V3 test node. Nothing is signed, submitted or deployed.
// - ReviveApi_instantiate / ReviveApi_upload_code via state_call (no signature needed) for the PolkaVM blob and, for
//   comparison, the EVM init code, as seam-demo (the intended deployer) and as the funded budget account.
// - TransactionPaymentApi_query_info on FAKE-signed extrinsics (signFake: a dummy signature, never submittable) for
//   Revive.instantiate_with_code, Revive.upload_code and Revive.map_account.
// - Revive.OriginalAccount (mapping) and System.Account balances.
// Every raw state_call (method, input hex, output hex) is recorded. Only read methods may reach the node.
// Writes evidence/testnet-v3/escrow-dryrun-<ts>.{json,md}.
//   npm run build -w @seam/chain && node packages/chain/scripts/v3-escrow-dryrun.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiPromise, HttpProvider } from "@polkadot/api";
import { httpRpcClient, reviveCodeHash, isPolkaVmBlob, deployBudgetFit } from "../dist/index.js";
import { formatBalance as _fb } from "@polkadot/util";

const URL_ = "https://test-node-v3.portaldot.dev";
const V3_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const SEAM_DEMO = "5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE";
const BUDGET_ACCOUNT = "5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1";
const DEC = 14;
const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const fmt = (v) => {
  const n = BigInt(v);
  const u = 10n ** BigInt(DEC);
  const f = (n % u).toString().padStart(DEC, "0").replace(/0+$/, "");
  return `${n / u}${f ? `.${f}` : ""} tPOT`;
};
void _fb;

const READ =
  /^(chain_getBlockHash|chain_getHeader|chain_getFinalizedHead|state_call|state_getRuntimeVersion|state_getStorage|system_chain)$/;
const c = httpRpcClient(URL_, { requestTimeoutMs: 90_000 });
const calls = [];
const send = async (method, params) => {
  if (!READ.test(method)) throw new Error(`refusing non-read method ${method}`);
  const result = await c.send(method, params);
  calls.push({ method, params, result });
  return result;
};

const api = await ApiPromise.create({ provider: new HttpProvider(URL_), noInitWarn: true });
try {
  const genesis = await send("chain_getBlockHash", [0]);
  if (genesis !== V3_GENESIS) throw new Error(`not the V3 test node (genesis ${genesis})`);
  const atHash = await send("chain_getFinalizedHead", []);
  const at = await send("chain_getHeader", [atHash]);
  const rv = await send("state_getRuntimeVersion", [atHash]);
  if (rv.specVersion !== 3002) throw new Error(`expected spec 3002, got ${rv.specVersion}`);
  const apiAt = await api.at(atHash);
  const reg = api.registry;
  const md = api.runtimeMetadata.asLatest;
  const method = (apiName, m) => {
    const a = md.apis.find((x) => x.name.toString() === apiName);
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
    return { decoded: mm.dec(out).toJSON(), human: mm.dec(out).toHuman() };
  };

  const consts = apiAt.consts.revive;
  const constants = {
    depositPerByte: consts.depositPerByte.toString(),
    depositPerItem: consts.depositPerItem.toString(),
    codeHashLockupDepositPercent: consts.codeHashLockupDepositPercent.toString(),
    allowEVMBytecode: consts.allowEVMBytecode.toJSON(),
    autoMap: consts.autoMap?.toJSON?.() ?? null,
    existentialDeposit: apiAt.consts.balances.existentialDeposit.toString(),
  };

  const art = (f) => readFileSync(root(`contracts/escrow/artifacts/${f}`));
  const buildInfo = JSON.parse(art("build-info.json").toString("utf8"));
  const pvm = art("SeamEscrow.pvm");
  const evm = art("SeamEscrow.evm");
  if (!isPolkaVmBlob(pvm)) throw new Error("SeamEscrow.pvm is not a PolkaVM blob");
  if (reviveCodeHash(pvm) !== buildInfo.pvm.codeHash)
    throw new Error("pvm hash differs from build-info");
  const codes = { pvm: "0x" + pvm.toString("hex"), evm: "0x" + evm.toString("hex") };

  const accounts = {};
  for (const [label, addr] of [
    ["seamDemo", SEAM_DEMO],
    ["budgetAccount", BUDGET_ACCOUNT],
  ]) {
    const acct = await apiAt.query.system.account(addr);
    const h160 = (await rawCall("ReviveApi", "address", [addr])).decoded;
    const orig = await apiAt.query.revive.originalAccount(h160);
    accounts[label] = {
      address: addr,
      nonce: acct.nonce.toNumber(),
      free: acct.data.free.toString(),
      freeFmt: fmt(acct.data.free.toString()),
      reserved: acct.data.reserved.toString(),
      h160,
      originalAccount: orig.isSome ? orig.unwrap().toString() : null,
      mapped: orig.isSome && orig.unwrap().toString() === addr,
    };
  }

  const dry = {};
  for (const [label, addr] of [
    ["seamDemo", SEAM_DEMO],
    ["budgetAccount", BUDGET_ACCOUNT],
  ]) {
    dry[label] = {};
    for (const kind of ["pvm", "evm"]) {
      const inst = await rawCall("ReviveApi", "instantiate", [
        addr,
        0,
        null,
        null,
        { Upload: codes[kind] },
        "0x",
        null,
      ]);
      const up = await rawCall("ReviveApi", "upload_code", [addr, codes[kind], null]);
      const d = inst.decoded;
      if (d.result?.ok?.result?.data)
        d.result.ok.result.data = `<${(d.result.ok.result.data.length - 2) / 2} bytes of returned runtime code>`;
      dry[label][kind] = {
        instantiate: d,
        instantiateHuman: inst.human.result,
        uploadCode: up.decoded,
      };
    }
  }

  // Fees: FAKE signatures, so the bytes can never be submitted; query_info only needs the length and the call.
  const fakeSigned = async (tx, addr) => {
    const nonce = accounts[addr === SEAM_DEMO ? "seamDemo" : "budgetAccount"].nonce;
    tx.signFake(addr, {
      nonce,
      blockHash: atHash,
      genesisHash: genesis,
      runtimeVersion: api.runtimeVersion,
    });
    return tx.toHex();
  };
  const fees = {};
  for (const [label, addr] of [
    ["seamDemo", SEAM_DEMO],
    ["budgetAccount", BUDGET_ACCOUNT],
  ]) {
    const pv = dry.budgetAccount.pvm.instantiate; // the funded dry run has the real weight and deposit
    const ev = dry.budgetAccount.evm.instantiate;
    const w = (x) => ({
      refTime: BigInt(x.weightRequired.refTime) * 2n,
      proofSize: BigInt(x.weightRequired.proofSize) * 2n + 100_000n,
    });
    const lim = (x) => BigInt(x.storageDeposit.charge);
    const txs = {
      instantiateWithCodePvm: api.tx.revive.instantiateWithCode(
        0,
        w(pv),
        lim(pv),
        codes.pvm,
        "0x",
        null,
      ),
      instantiateWithCodeEvm: api.tx.revive.instantiateWithCode(
        0,
        w(ev),
        lim(ev),
        codes.evm,
        "0x",
        null,
      ),
      uploadCodePvm: api.tx.revive.uploadCode(codes.pvm, lim(pv)),
      mapAccount: api.tx.revive.mapAccount(),
    };
    fees[label] = {};
    for (const [k, tx] of Object.entries(txs)) {
      const callHex = tx.method.toHex();
      const uxt = await fakeSigned(tx, addr);
      const len = (uxt.length - 2) / 2;
      // The uxt is already a length-prefixed opaque extrinsic, so it goes in as-is (no second Bytes prefix), then u32 len.
      const mm = method("TransactionPaymentApi", "query_info");
      const lenLe = Buffer.alloc(4);
      lenLe.writeUInt32LE(len);
      const out = await send("state_call", [
        "TransactionPaymentApi_query_info",
        uxt + lenLe.toString("hex"),
        atHash,
      ]);
      // Keep no signature bytes in evidence, not even the fake one: record a note instead of the extrinsic.
      calls[calls.length - 1].params[1] =
        `<fake-signed extrinsic redacted: dummy signature, ${len} bytes + u32 len; call ${callHex.slice(0, 18)}…>`;
      const r = { decoded: mm.dec(out).toJSON() };
      fees[label][k] = {
        callBytes: (callHex.length - 2) / 2,
        extrinsicBytes: len,
        weightLimit: k.startsWith("instantiate")
          ? {
              refTime: w(k.endsWith("Pvm") ? pv : ev).refTime.toString(),
              proofSize: w(k.endsWith("Pvm") ? pv : ev).proofSize.toString(),
            }
          : undefined,
        queryInfo: r.decoded,
        partialFee: BigInt(r.decoded.partialFee).toString(),
        partialFeeFmt: fmt(BigInt(r.decoded.partialFee)),
      };
    }
  }

  const budget = JSON.parse(readFileSync(root("evidence/testnet-v3/budget.json"), "utf8"));
  const left = BigInt(budget.spent.leftUnderCapPlanck);
  const ed = BigInt(constants.existentialDeposit);
  const fit = {};
  for (const [label, kind, feeKey] of [
    ["budgetAccount", "pvm", "instantiateWithCodePvm"],
    ["budgetAccount", "evm", "instantiateWithCodeEvm"],
    ["seamDemo", "pvm", "instantiateWithCodePvm"],
  ]) {
    const dep = BigInt(dry.budgetAccount[kind].instantiate.storageDeposit.charge);
    const f = deployBudgetFit(
      {
        fee: BigInt(fees[label][feeKey].partialFee),
        storageDeposit: dep,
        ...(accounts[label].mapped
          ? {}
          : {
              mappingFee: BigInt(fees[label].mapAccount.partialFee),
              mappingDeposit:
                BigInt(constants.depositPerItem) + BigInt(constants.depositPerByte) * 68n,
            }),
      },
      left,
      BigInt(accounts[label].free),
      ed,
    );
    fit[`${label}.${kind}`] = Object.fromEntries(
      Object.entries(f).map(([k, v]) => [
        k,
        typeof v === "bigint"
          ? { planck: v.toString(), tPOT: fmt(v < 0n ? -v : v).replace(/^/, v < 0n ? "-" : "") }
          : v,
      ]),
    );
  }

  const ts = Date.now();
  const rec = {
    kind: "escrow-deploy-dryrun",
    label:
      "DRY RUN ONLY: nothing was signed, submitted or deployed. Fees come from FAKE-signed extrinsics (never submittable).",
    at: new Date(ts).toISOString(),
    rpc: URL_,
    genesis,
    block: { number: parseInt(at.number, 16), hash: atHash },
    specVersion: rv.specVersion,
    contract: buildInfo,
    constants,
    accounts,
    dryRuns: dry,
    fees,
    budget: {
      capPlanck: budget.capPlanck,
      leftUnderCapPlanck: budget.spent.leftUnderCapPlanck,
      left: fmt(left),
      account: budget.account,
      fit,
    },
    rawCalls: calls,
  };
  const base = root(`evidence/testnet-v3/escrow-dryrun-${ts}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(rec, null, 2)}\n`);
  console.log(base);
  console.log(
    JSON.stringify(
      {
        accounts,
        fit,
        fees: Object.fromEntries(
          Object.entries(fees).map(([k, v]) => [
            k,
            Object.fromEntries(Object.entries(v).map(([a, b]) => [a, b.partialFeeFmt])),
          ]),
        ),
        dep: Object.fromEntries(
          ["pvm", "evm"].map((k) => [
            k,
            {
              inst: dry.budgetAccount[k].instantiate.storageDeposit,
              w: dry.budgetAccount[k].instantiate.weightRequired,
              up: dry.budgetAccount[k].uploadCode,
              demo: dry.seamDemo[k].instantiateHuman,
            },
          ]),
        ),
      },
      null,
      1,
    ),
  );
} finally {
  await api.disconnect();
}
