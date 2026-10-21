/* eslint-disable @typescript-eslint/no-explicit-any -- raw JSON-RPC answers and polkadot.js codecs */
// Read-only replay + independent verification of a recorded V3 transaction (Demo D). Never signs or submits.
// Re-reads the chain; trusts nothing from SEAM's records except the tx hash and block to look in.
// Usage: npx vite-node packages/chain/scripts/v3-recorded-replay.ts -- <block> <txHash> <out.json> [assetId]
import { writeFileSync } from "node:fs";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import {
  clientFromSend,
  factsFromChainInputs,
  lookupTxByHash,
  signedExtrinsicDecoder,
} from "../src/browser.js";
import { decodeRuntime, storageKey } from "../src/runtime.js";
import { decodeBlockEvents } from "../src/events.js";

const R = process.env.V3_RPC ?? "https://test-node-v3.portaldot.dev";
const raw: { method: string; params: unknown[] }[] = [];
const send = async (method: string, params: unknown[]) => {
  raw.push({
    method,
    params: params.map((p) => (typeof p === "string" && p.length > 140 ? `${p.slice(0, 18)}…` : p)),
  });
  const r = await fetch(R, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};
const [bn, txHash, out, assetId = "806707"] = process.argv.slice(2).filter((a) => a !== "--");
const n = Number(bn);
const H = await send("chain_getBlockHash", [n]);
const header = await send("chain_getHeader", [H]);
const P = header.parentHash;
const fin = await send("chain_getHeader", [await send("chain_getFinalizedHead", [])]);
const facts = factsFromChainInputs({
  metadataHex: await send("state_getMetadata", [P]),
  genesisHash: await send("chain_getBlockHash", [0]),
  runtimeVersion: await send("state_getRuntimeVersion", [P]),
  properties: await send("system_properties", []),
  head: { number: n - 1, hash: P },
} as never);
const look = await lookupTxByHash(clientFromSend(send), {
  txHash: txHash as never,
  fromBlock: n,
  toBlock: n,
  facts,
});
if (look.status !== "found") throw new Error(`lookup: ${JSON.stringify(look)}`);
const ext = (await send("chain_getBlock", [H])).block.extrinsics[look.extrinsicIndex];
// Signature: rebuild the signed payload from the extrinsic's own era (birth block = largest b <= n with b % period == phase).
const pre = signedExtrinsicDecoder(facts)(ext)!;
let birth: number | undefined, birthHash: string | undefined;
if (pre.era?.mortal) {
  birth = n - ((((n - pre.era.phase) % pre.era.period) + pre.era.period) % pre.era.period);
  birthHash = await send("chain_getBlockHash", [birth]);
}
const dec = signedExtrinsicDecoder(facts, {
  checkpoint: { hash: (birthHash ?? facts.fingerprint.genesisHash) as string },
})(ext)!;
const { registry } = decodeRuntime(facts);
const call: any = registry.createType("Call", dec.call);
const callJson: any = call.toHuman();
const inner = (callJson.args?.calls ?? []).map((c: any) => `${c.section}.${c.method}`);
// State at the parent vs the block: native balance of the signer, asset supply, asset accounts of every account in the call.
const q: any = decodeRuntime(facts).decorated().query;
const read = async (entry: any, args: unknown[], at: string) => {
  const v = await send("state_getStorage", [storageKey(entry, ...args), at]);
  if (v === null) return null;
  const t = entry.meta.type.isMap ? entry.meta.type.asMap.value : entry.meta.type.asPlain;
  const reg: any = registry;
  const c = reg.createTypeUnsafe(reg.createLookupType(t), [v]);
  return c.isSome === undefined ? c.toJSON() : c.isSome ? c.unwrap().toJSON() : null;
};
const accounts = new Set<string>([dec.signer]);
for (const m of JSON.stringify(callJson).matchAll(
  /"(5[1-9A-HJ-NP-Za-km-z]{46,47})"|"(0x[0-9a-f]{64})"/g,
)) {
  try {
    accounts.add(encodeAddress(decodeAddress(m[1] ?? m[2]!), facts.fingerprint.ss58Prefix));
  } catch {
    /* not an account */
  }
}
const state: any = { native: {}, assetSupply: {}, assetAccounts: {} };
for (const [label, at] of [
  ["parent", P],
  ["block", H],
] as const) {
  state.native[label] = (await read(q.system.account, [dec.signer], at))?.data ?? null;
  state.assetSupply[label] = (await read(q.assets.asset, [assetId], at))?.supply ?? null;
  for (const a of accounts)
    (state.assetAccounts[a] ??= {})[label] =
      (await read(q.assets.account, [assetId, a], at))?.balance ?? null;
}
const fee = look.events.find(
  (e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid",
);
const allEvents = decodeBlockEvents(
  await send("state_getStorage", [
    "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7",
    H,
  ]),
  facts,
).filter((e) => e.extrinsicIndex === look.extrinsicIndex);
const res = {
  label: "recorded run, replayed read-only",
  endpoint: R,
  readAt: new Date().toISOString(),
  txHash,
  block: {
    number: n,
    hash: H,
    parentHash: P,
    finalized: Number(fin.number) >= n,
    finalizedHead: Number(fin.number),
  },
  runtime: {
    specVersion: facts.fingerprint.specVersion,
    transactionVersion: facts.fingerprint.transactionVersion,
    metadataReadAt: "parent block",
    metadataHash: facts.fingerprint.metadataHash,
  },
  extrinsicIndex: look.extrinsicIndex,
  signer: dec.signer,
  nonce: dec.nonce,
  tip: dec.tip,
  era: pre.era,
  eraBirthBlock: birth,
  eraBirthHash: birthHash,
  metadataHashMode: dec.metadataHashMode,
  signatureValid: dec.signatureValid,
  signatureGenesis: dec.genesisHash,
  call: {
    hex: dec.call,
    name: `${callJson.section}.${callJson.method}`,
    innerCalls: inner,
    decoded: callJson,
  },
  success: look.success,
  dispatchError: look.dispatchError ?? null,
  feePaid: fee ? { who: fee.args[0], actualFee: fee.args[1], tip: fee.args[2] } : null,
  events: allEvents.map((e) => ({
    eventIndex: e.eventIndex,
    pallet: e.pallet,
    name: e.name,
    args: e.args,
  })),
  state,
  rpcReads: raw.length,
};
writeFileSync(out!, JSON.stringify(res, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      ...res,
      call: { name: res.call.name, innerCalls: inner },
      events: res.events.map((e) => `${e.pallet}.${e.name}`),
      state,
    },
    null,
    1,
  ),
);
