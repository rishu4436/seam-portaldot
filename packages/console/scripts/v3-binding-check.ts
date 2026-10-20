// Read-only check of the REAL console host (createLiveHost over @seam/chain/browser) against live V3.
// No signing, no wallet, no keystore: it re-reads an extrinsic that is already on chain, checks it against the recorded
// signing request, checks negatives, and asks payment_queryInfo for the demo call's fee. Run: npx vite-node scripts/v3-binding-check.ts
import fs from "node:fs";
import * as chain from "@seam/chain/browser";
import { blake2AsHex } from "@polkadot/util-crypto";
import { createLiveHost, hasChainFacts } from "../src/lib/host";
import {
  httpTransport,
  readSigningContext,
  createBrowserChainClient,
} from "../src/lib/chainclient";
import { discoverV3LiveFacts, type FactsBuilder } from "../src/lib/v3facts";
import { walletDemoPlan } from "../src/lib/walletdemo";

const URL_ = process.env.V3_RPC ?? "https://test-node-v3.portaldot.dev";
const root = new URL("../../../", import.meta.url);
const RUN = "evidence/testnet-v3/runs/plan-atomic-1792411355057.json";
const run = JSON.parse(fs.readFileSync(new URL(RUN, root), "utf8"));
const rpc = httpTransport(URL_, undefined, 30000);
const out: Record<string, unknown> = {
  kind: "v3-binding-check",
  readOnly: true,
  endpoint: URL_,
  ranAt: new Date().toISOString(),
};

const lf = await discoverV3LiveFacts(rpc, chain.factsFromChainInputs as unknown as FactsBuilder, {
  endpoint: URL_,
});
if (!lf.ok) throw new Error("live facts failed: " + lf.message);
out.liveFacts = { ...lf.report, hasChainFacts: hasChainFacts(lf.facts) };
const host = createLiveHost(chain, lf.facts, (h) => blake2AsHex(h, 256));

// 1. Positive: the real signed extrinsic of the recorded atomic run, re-read from its finalized block.
const inc = run.lastSubmit.inclusion;
const blk = (await rpc("chain_getBlock", [inc.hash])) as { block: { extrinsics: string[] } };
const signed = blk.block.extrinsics[inc.extrinsicIndex];
// The recorded file keeps only payload + signBytesHex, so the full request is rebuilt with the real host builder from the
// recorded payload fields (call, nonce, checkpoint, 64-block era) and its sign bytes are compared with the recorded ones.
const rp = run.signingRequests[0].payload;
const rebuilt = await host.buildRequest({
  signer: rp.address,
  callHex: rp.method,
  actionIds: run.plan.steps.map((s: { actionId: string }) => s.actionId),
  context: {
    genesisHash: rp.genesisHash,
    specVersion: Number(rp.specVersion),
    transactionVersion: Number(rp.transactionVersion),
    nonce: Number(rp.nonce),
    checkpointHash: rp.blockHash,
    checkpointNumber: Number(rp.blockNumber),
    mortalityBlocks: 64,
  },
});
if (!rebuilt.ok) throw new Error(rebuilt.message);
const req = rebuilt.value as { signBytesHex: string; payload: Record<string, unknown> };
out.rebuiltRequestSignBytesMatchRecorded = req.signBytesHex === run.signingRequests[0].signBytesHex;
const hashOk = blake2AsHex(signed, 256) === run.lastSubmit.txHash;
const pos = await host.verifyBinding(signed, req);
out.recordedExtrinsic = {
  source: RUN,
  block: inc,
  txHash: run.lastSubmit.txHash,
  rehashMatches: hashOk,
  verifyBinding: pos,
};

// 2. Negative: one flipped byte in the signature region of the same bytes.
const i = 2 + 2 * 40;
const flipped =
  signed.slice(0, i) +
  (parseInt(signed.slice(i, i + 2), 16) ^ 0xff).toString(16).padStart(2, "0") +
  signed.slice(i + 2);
out.tamperedSignature = await host.verifyBinding(flipped, req);

// 3. Negative: the same signed bytes against a request for a different call (the demo transfer).
const demoCall = walletDemoPlan().steps[0].encodedCall;
const other = { ...req, callHex: demoCall, payload: { ...req.payload, method: demoCall } };
out.wrongRequest = await host.verifyBinding(signed, other);

// 4. Fee estimate for the demo call, built fresh against the live chain (fee only, filler signature, never submitted).
const plan = walletDemoPlan();
const ctx = await readSigningContext(rpc, plan.signer);
if (!ctx.ok) throw new Error(ctx.message);
const built = await host.buildRequest({
  signer: plan.signer,
  callHex: plan.steps[0].encodedCall!,
  actionIds: ["pay"],
  context: ctx.value,
});
if (!built.ok) throw new Error(built.message);
const client = createBrowserChainClient(rpc, {
  feeExtrinsic: host.feeEstimateExtrinsic,
  extrinsicHash: host.extrinsicHash,
});
const fee = await client.preflight(built.value);
const fillerTx = await host.feeEstimateExtrinsic!(built.value);
out.demoFeeEstimate = {
  signer: plan.signer,
  nonce: ctx.value.nonce,
  checkpoint: ctx.value.checkpointNumber,
  result: fee,
};
// 5. Negative: the filler-signed fee extrinsic must never pass the binding check.
out.fillerSignedFeeExtrinsic = await host.verifyBinding(fillerTx, built.value);

const strip = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const verdict = {
  recordedPasses: pos.ok,
  rebuiltSignBytesMatch: out.rebuiltRequestSignBytesMatchRecorded,
  tamperedBlocked: !(out.tamperedSignature as { ok: boolean }).ok,
  wrongRequestBlocked: !(out.wrongRequest as { ok: boolean }).ok,
  fillerBlocked: !(out.fillerSignedFeeExtrinsic as { ok: boolean }).ok,
  feeEstimated: fee.ok,
};
out.verdict = verdict;
const dest = new URL("evidence/testnet-v3/v3-binding-check.json", root);
fs.writeFileSync(dest, JSON.stringify(strip(out), null, 1) + "\n");
console.log(
  JSON.stringify(verdict),
  JSON.stringify(
    strip({
      pos,
      fee,
      t: out.tamperedSignature,
      w: out.wrongRequest,
      f: out.fillerSignedFeeExtrinsic,
    }),
  ).slice(0, 2500),
);
