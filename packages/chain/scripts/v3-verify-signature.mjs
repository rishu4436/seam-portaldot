#!/usr/bin/env node
// READ-ONLY: verify the signature of one finalized V3 signed extrinsic with SEAM's own decoder (signedExtrinsicDecoder),
// using the real context: genesis, spec and tx version from the node's runtime version at the block, and the hash of the
// mortal era's birth block (the checkpoint the signer signed against). Reads only; signs and sends nothing.
//   node packages/chain/scripts/v3-verify-signature.mjs --block <n> --hash 0x<tx hash>
import { readFileSync } from "node:fs";
import { blake2AsHex } from "@polkadot/util-crypto";
import { extractSignedCall, httpRpcClient, signedExtrinsicDecoder } from "../dist/index.js";
import { readLiveCapabilities } from "../dist/browser.js";

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const BLOCK = Number(opt("--block"));
const HASH = String(opt("--hash")).toLowerCase();
const c = httpRpcClient("https://test-node-v3.portaldot.dev", { requestTimeoutMs: 90_000 });
const send = (m, p) => {
  if (!/^(chain_get|state_get|system_properties$)/.test(m)) throw new Error(`refusing ${m}`);
  return c.send(m, p);
};
try {
  const pinnedMetadataHex = readFileSync(
    new URL("../../../evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex", import.meta.url),
    "utf8",
  ).trim();
  const facts = (await readLiveCapabilities(send, { pinnedMetadataHex })).facts;
  const bh = await send("chain_getBlockHash", [BLOCK]);
  const rv = await send("state_getRuntimeVersion", [bh]);
  if (rv.specVersion !== facts.fingerprint.specVersion)
    throw new Error("spec changed since the block");
  const b = await send("chain_getBlock", [bh]);
  const xt = b.block.extrinsics.find((x) => blake2AsHex(x, 256) === HASH);
  if (!xt) throw new Error("tx not in block");
  const s = extractSignedCall(xt, facts);
  const birth = s.era.mortal
    ? Math.floor((BLOCK - s.era.phase) / s.era.period) * s.era.period + s.era.phase
    : 0;
  const birthHash = await send("chain_getBlockHash", [birth]);
  const withCtx = signedExtrinsicDecoder(facts, { checkpoint: { hash: birthHash } })(xt);
  const noCtx = signedExtrinsicDecoder(facts)(xt);
  const wrong = signedExtrinsicDecoder(facts, { checkpoint: { hash: "0x" + "11".repeat(32) } })(xt);
  console.log(
    JSON.stringify(
      {
        block: { number: BLOCK, hash: bh },
        txHash: HASH,
        specVersion: rv.specVersion,
        transactionVersion: rv.transactionVersion,
        genesisHash: facts.fingerprint.genesisHash,
        signer: s.signer.ss58,
        nonce: s.nonce,
        tip: s.tip,
        era: s.era,
        eraBirth: { number: birth, hash: birthHash },
        signatureValid: withCtx?.signatureValid ?? null,
        controlNoContext: noCtx?.signatureValid ?? null,
        controlWrongCheckpoint: wrong?.signatureValid ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  c.close();
}
