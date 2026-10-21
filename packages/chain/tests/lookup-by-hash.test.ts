/* eslint-disable @typescript-eslint/no-explicit-any -- FakeNode internals */
/** lookupTxByHash (@seam/chain/browser): reconcile by tx hash after an uncertain submit. Offline FakeNode, fail closed. */
import { describe, expect, it } from "vitest";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import * as browser from "../src/browser.js";
import { assembleSignedExtrinsic, buildSigningRequests, extrinsicHash } from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { ALICE, CHECKPOINT, demoPlan, devKeys, snapshotFacts, snapshotInputs } from "./helpers.js";

const facts = snapshotFacts();
const head = snapshotInputs().head.number;

async function setup(o: Partial<ConstructorParameters<typeof FakeNode>[0]> = {}) {
  const keys = await devKeys();
  const q = buildSigningRequests(demoPlan(), facts, {
    signer: ALICE,
    nonce: 0,
    mortalityBlocks: 64,
    checkpoint: CHECKPOINT,
    expiresAt: "x",
  })[0]!;
  const x = assembleSignedExtrinsic(
    q.payload,
    u8aToHex(keys.alice.sign(hexToU8a(q.signBytesHex), { withType: true })),
    facts,
  );
  const n = new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: ["1", "2"], ...o });
  n.advance(2);
  const block = (n as any).include(x);
  n.advance(2);
  return { n, x, hash: extrinsicHash(x), block };
}

describe("lookupTxByHash", () => {
  it("found: block, index, success and events", async () => {
    const { n, hash, block } = await setup();
    const r = await browser.lookupTxByHash(n, { txHash: hash, fromBlock: head + 1, facts });
    expect(r).toMatchObject({
      status: "found",
      blockNumber: block.number,
      blockHash: block.hash,
      success: true,
    });
    if (r.status !== "found") throw new Error();
    expect(r.extrinsicIndex).toBe(
      block.extrinsics.indexOf(block.extrinsics.find((e: string) => extrinsicHash(e) === hash)),
    );
    expect(r.events.some((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess")).toBe(true);
  });

  it("found and failed: success false with the decoded dispatch error", async () => {
    const { n, hash } = await setup({ failCall: () => ({ index: 50, error: 0 }) });
    const r = await browser.lookupTxByHash(n, { txHash: hash, fromBlock: head + 1, facts });
    expect(r).toMatchObject({ status: "found", success: false });
    expect((r as any).dispatchError).toBeTruthy();
  });

  it("not_found reports exactly the range it read", async () => {
    const { n, hash, block } = await setup();
    const r = await browser.lookupTxByHash(n, { txHash: hash, fromBlock: block.number + 1, facts });
    expect(r).toEqual({ status: "not_found", scannedFrom: block.number + 1, scannedTo: head + 5 });
  });

  it("maxBlocks caps the scan and scannedTo says so", async () => {
    const { n, hash } = await setup();
    const r = await browser.lookupTxByHash(n, {
      txHash: hash,
      fromBlock: head + 1,
      toBlock: head + 5,
      maxBlocks: 1,
      facts,
    });
    expect(r).toEqual({ status: "not_found", scannedFrom: head + 1, scannedTo: head + 1 });
  });

  it("an unreadable block or node is unknown, never not_found", async () => {
    const { n, hash } = await setup();
    n.breakRpc("chain_getBlock");
    const r = await browser.lookupTxByHash(n, { txHash: hash, fromBlock: head + 1, facts });
    expect(r.status).toBe("unknown");
    expect((r as any).reason).toMatch(/could not read the node/);
  });

  it("found but events unreadable is unknown", async () => {
    const { n, hash, block } = await setup();
    block.events = null;
    const r = await browser.lookupTxByHash(n, { txHash: hash, fromBlock: head + 1, facts });
    expect(r).toMatchObject({ status: "unknown" });
  });

  it("bad inputs are unknown", async () => {
    const { n } = await setup();
    expect((await browser.lookupTxByHash(n, { txHash: "0x12" as any, fromBlock: 1 })).status).toBe(
      "unknown",
    );
    expect(
      (
        await browser.lookupTxByHash(n, {
          txHash: `0x${"ab".repeat(32)}`,
          fromBlock: 10,
          toBlock: 5,
        })
      ).status,
    ).toBe("unknown");
  });

  it("works over a plain send and only reads", async () => {
    const { n, hash } = await setup();
    const r = await browser.lookupTxByHash((m, p) => n.send(m, p), {
      txHash: hash,
      fromBlock: head + 1,
      facts,
    });
    expect(r.status).toBe("found");
    expect(n.log.map((l) => l.method).filter((m) => !/^(chain_get|state_get)/.test(m))).toEqual([]);
  });
});
