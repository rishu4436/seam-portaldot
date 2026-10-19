// LOCAL DEV CHAIN ONLY (lib.mjs refuses non-localhost endpoints; //Alice is a public dev seed).
// A fresh instant-seal dev node sits at its genesis block until the first transaction. There, no signed dry run can
// pass: system_dryRun does not initialize a new block, so System.BlockHash(0) is still frame_system's placeholder
// (0x4545…45) and every signed extrinsic reports BadProof. SEAM's setup path dry-runs before it sends, so this
// builds block 1 first with one System.remark from //Alice, sent directly (test setup, no SEAM plan involved).
// Prints the head number afterwards. Does nothing when the chain is already past genesis.
import { withClient } from "../../dist/index.js";
import { ENDPOINT, devFacts, devKeys, encodeCall, sendSigned } from "./lib.mjs";

const head = async () =>
  parseInt((await withClient(ENDPOINT, (c) => c.send("chain_getHeader", []))).number, 16);
if ((await head()) === 0) {
  const facts = await devFacts();
  const { alice } = await devKeys();
  const r = await sendSigned(facts, alice, encodeCall(facts, "System", "remark", ["0x7365616d"]));
  if (r.inclusion?.success !== true)
    throw new Error(`could not build block 1: ${r.status} ${r.error ?? ""}`);
}
console.log(await head());
process.exit(0);
