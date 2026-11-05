import { beforeAll, expect, it } from "vitest";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, decodeAddress } from "@polkadot/util-crypto";
import { u8aConcat, u8aToHex } from "@polkadot/util";
import {
  assembleSignedExtrinsic,
  discoverNativePools,
  nativeSwapCall,
  nativeSwapSigningRequest,
  parseNativeSwapPlan,
  quoteNativeSwap,
  readNativeSwapContext,
  recheckNativeSwap,
  verifyNativeSwap,
  verifyNativeSwapEvents,
  verifySignedAgainstRequest,
  type NativeSwapPlan,
} from "../src/index.js";
import { nativeFacts, nativeSwapNode } from "./nativeSwapNode.js";
import { ALICE } from "./helpers.js";
beforeAll(async () => {
  await cryptoWaitReady();
});
export const nativeInput = {
  signer: ALICE,
  assetId: 8801000,
  reverse: false,
  amountIn: "1000000000000",
  slippageBps: 50,
  feeLimit: "5000000000000",
};
it("reads real V3 metadata, liquid pool reserves and little-endian runtime quotes without any submission", async () => {
  const { send, log } = nativeSwapNode(),
    ctx = await readNativeSwapContext(send),
    pools = await discoverNativePools(send, ctx),
    result = await quoteNativeSwap(send, nativeInput);
  expect(pools).toMatchObject([
    { assetId: 8801000, decimals: 10, nativeReserve: "2000000000000000" },
  ]);
  expect(result.plan).toMatchObject({
    quotedOut: "99650324313",
    minOut: "99152072691",
    estimatedFee: "1810737180385",
  });
  const call = log.find(
    (e) =>
      e.method === "state_call" &&
      e.params[0] === "AssetConversionApi_quote_price_exact_tokens_for_tokens",
  );
  expect(call?.params[1]).toBe("0x0001e84a86000010a5d4e8000000000000000000000001");
  expect(log.some((e) => e.method.startsWith("author_"))).toBe(false);
});
it("binds the native minimum, self recipient, keep-alive, nonce, mortal era and real signature", async () => {
  const { send, rt } = nativeSwapNode(),
    { ctx, plan } = await quoteNativeSwap(send, nativeInput),
    req = nativeSwapSigningRequest(ctx, plan),
    pair = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
  const signed = assembleSignedExtrinsic(
    req.payload,
    u8aToHex(pair.sign(req.signBytesHex, { withType: true })),
    ctx.facts,
  );
  expect(req.era.period).toBe(32);
  expect(verifySignedAgainstRequest(signed, req, { facts: ctx.facts }).ok).toBe(true);
  const call = rt.registry.createType("Call", nativeSwapCall(ctx.facts, plan));
  expect(call.args[2].toString()).toBe(plan.minOut);
  expect(call.args[4].toString()).toBe("true");
  expect(
    verifySignedAgainstRequest(
      signed,
      { ...req, callHex: nativeSwapCall(ctx.facts, { ...plan, amountIn: "2" }) },
      { facts: ctx.facts },
    ).ok,
  ).toBe(false);
});
it.each([
  { amountIn: "0" },
  { amountIn: "1e14" },
  { amountIn: "100000000000001" },
  { slippageBps: 0 },
  { slippageBps: 501 },
  { feeLimit: "10000000000001" },
])("refuses unsafe native swap input %j", async (change) => {
  const { send } = nativeSwapNode();
  await expect(quoteNativeSwap(send, { ...nativeInput, ...change })).rejects.toThrow();
});
it("rejects unknown network, unreviewed runtime and missing balances", async () => {
  const { send } = nativeSwapNode();
  await expect(
    readNativeSwapContext(async (m, p) =>
      m === "chain_getBlockHash" ? `0x${"ab".repeat(32)}` : send(m, p),
    ),
  ).rejects.toThrow(/reviewed/);
  await expect(
    readNativeSwapContext(async (m, p) =>
      m === "state_getRuntimeVersion"
        ? { specName: "portaldot-v3", specVersion: 3003, transactionVersion: 2 }
        : send(m, p),
    ),
  ).rejects.toThrow(/3003|reviewed/);
  await expect(quoteNativeSwap(nativeSwapNode({ free: 100n }).send, nativeInput)).rejects.toThrow(
    /enough tPOT/,
  );
  await expect(
    quoteNativeSwap(
      nativeSwapNode({ free: 10000000000000000n, frozen: 9999999999999999n }).send,
      nativeInput,
    ),
  ).rejects.toThrow(/enough tPOT/);
});
it("refuses excessive fees and reverse swaps without tokens", async () => {
  await expect(
    quoteNativeSwap(nativeSwapNode({ fee: 6000000000000n }).send, nativeInput),
  ).rejects.toThrow(/fee estimate/);
  await expect(
    quoteNativeSwap(nativeSwapNode({ assetBalance: 0n }).send, {
      ...nativeInput,
      reverse: true,
      amountIn: "10000000000",
    }),
  ).rejects.toThrow(/asset balance/);
});
it("reverse swaps preserve the asset minimum instead of quoting a full balance that cannot be withdrawn", async () => {
  const { send } = nativeSwapNode({ assetBalance: 100000000000n });
  await expect(
    quoteNativeSwap(send, { ...nativeInput, reverse: true, amountIn: "100000000000" }),
  ).rejects.toThrow(/asset account minimum/);
  const result = await quoteNativeSwap(send, {
    ...nativeInput,
    reverse: true,
    amountIn: "99999999999",
  });
  expect(result.plan.amountIn).toBe("99999999999");
});
it("invalidates stale nonce, expired quote, changed checkpoint and moved price before signing", async () => {
  const { send, node } = nativeSwapNode(),
    { plan } = await quoteNativeSwap(send, nativeInput);
  await expect(recheckNativeSwap(send, plan, plan.expiresAt)).rejects.toThrow(/expired/);
  node.setNonce(ALICE, 1);
  await expect(recheckNativeSwap(send, plan)).rejects.toThrow(/nonce/);
  node.setNonce(ALICE, 0);
  await expect(recheckNativeSwap(nativeSwapNode({ quote: 1n }).send, plan)).rejects.toThrow(
    /minimum output/,
  );
  await expect(
    recheckNativeSwap(
      async (m, p) =>
        m === "chain_getBlockHash" && p[0] === plan.block.number
          ? `0x${"01".repeat(32)}`
          : send(m, p),
      plan,
    ),
  ).rejects.toThrow(/window/);
});
it("detects altered archive plan fields", async () => {
  const { plan } = await quoteNativeSwap(nativeSwapNode().send, nativeInput);
  expect(parseNativeSwapPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  for (const change of [
    { amountIn: "1" },
    { minOut: "1" },
    { assetId: 1 },
    { reverse: true },
    { signer: "bad" },
    { privateKey: "never" },
    { block: { ...plan.block, number: 2 } },
  ])
    expect(() => parseNativeSwapPlan({ ...plan, ...change })).toThrow();
});
it("verifies only matching swap effects, including large base-unit quantities", async () => {
  const { plan } = await quoteNativeSwap(nativeSwapNode().send, nativeInput),
    who = u8aToHex(decodeAddress(ALICE));
  const event = {
    pallet: "AssetConversion",
    name: "SwapExecuted",
    args: [
      who,
      who,
      plan.amountIn,
      plan.quotedOut,
      JSON.stringify([
        [{ native: null }, plan.amountIn],
        [{ withId: plan.assetId }, plan.quotedOut],
      ]),
    ],
  };
  expect(verifyNativeSwapEvents([event], plan)).toBe(plan.quotedOut);
  for (const bad of [
    [...event.args.slice(0, 3), "1", event.args[4]],
    [who, who, plan.amountIn, plan.quotedOut, "[]"],
    [who, who, "1", plan.quotedOut, event.args[4]],
  ])
    expect(() => verifyNativeSwapEvents([{ ...event, args: bad }], plan)).toThrow();
  expect(() => verifyNativeSwapEvents([event, event], plan)).toThrow();
  const large = { ...plan, quotedOut: "10000000000000000000", minOut: "1" } as NativeSwapPlan;
  expect(
    verifyNativeSwapEvents(
      [
        {
          ...event,
          args: [
            who,
            who,
            plan.amountIn,
            large.quotedOut,
            JSON.stringify([
              [{ native: null }, plan.amountIn],
              [{ withId: plan.assetId }, "0x8ac7230489e80000"],
            ]),
          ],
        },
      ],
      large,
    ),
  ).toBe(large.quotedOut);
});
it("does not clear an uncertain send until its complete signing window is finalized and scanned", async () => {
  const { send, node } = nativeSwapNode(),
    { plan } = await quoteNativeSwap(send, nativeInput),
    hash = `0x${"ab".repeat(32)}` as const;
  expect((await verifyNativeSwap(send, plan, hash)).status).toBe("pending");
  node.advance(33);
  expect((await verifyNativeSwap(send, plan, hash)).status).toBe("expired");
  const unreadable = async (m: string, p: unknown[]) => {
    if (m === "chain_getBlock") throw Error("lost RPC");
    return send(m, p);
  };
  expect((await verifyNativeSwap(unreadable, plan, hash)).status).toBe("failed");
  expect((await verifyNativeSwap(send, plan, hash, plan.block.number + 1)).status).toBe("pending");
});
it("keeps signed call serialization compatible with the reviewed V3 runtime", () => {
  expect(
    nativeSwapCall(nativeFacts, { ...nativeInput, minOut: "99152072691" }).startsWith(
      "0x4103080001e84a8600",
    ),
  ).toBe(true);
});
it("independently proves a finalized signed swap and refuses altered effects or a non-finalized claim", async () => {
  const f = nativeSwapNode(),
    { ctx, plan } = await quoteNativeSwap(f.send, nativeInput),
    req = nativeSwapSigningRequest(ctx, plan),
    key = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
  const signed = assembleSignedExtrinsic(
    req.payload,
    u8aToHex(key.sign(req.signBytesHex, { withType: true })),
    ctx.facts,
  );
  const { blake2AsHex } = await import("@polkadot/util-crypto"),
    hash = blake2AsHex(signed, 256),
    blockNumber = plan.block.number + 1;
  f.node.advance(1);
  const blockHash = await f.send("chain_getFinalizedHead", []),
    header = await f.send("chain_getHeader", [blockHash]);
  const eventRecord = (pallet: string, name: string, values: unknown[]) => {
    const p = f.rt.metadata.asLatest.pallets.find((p) => p.name.toString() === pallet)!,
      v = f.rt.registry.lookup
        .getSiType(p.events.unwrap().type)
        .def.asVariant.variants.find((v) => v.name.toString() === name)!;
    return u8aConcat(
      new Uint8Array([0, 0, 0, 0, 0, p.index.toNumber(), v.index.toNumber()]),
      ...v.fields.map((field, i) =>
        f.rt.registry.createType(f.rt.registry.createLookupType(field.type), values[i]).toU8a(),
      ),
      new Uint8Array([0]),
    );
  };
  let output = plan.quotedOut;
  const events = () =>
    u8aToHex(
      u8aConcat(
        new Uint8Array([12]),
        eventRecord("AssetConversion", "SwapExecuted", [
          ALICE,
          ALICE,
          plan.amountIn,
          output,
          [
            [{ Native: null }, plan.amountIn],
            [{ WithId: plan.assetId }, output],
          ],
        ]),
        eventRecord("System", "ExtrinsicSuccess", [
          { weight: { refTime: 100, proofSize: 0 }, class: "Normal", paysFee: "Yes" },
        ]),
        eventRecord("TransactionPayment", "TransactionFeePaid", [ALICE, "1810737180385", 0]),
      ),
    );
  const send = async (m: string, p: unknown[]) => {
    if (m === "chain_getBlock" && p[0] === blockHash)
      return { block: { header, extrinsics: [signed] } };
    if (m === "state_getStorage" && p[1] === blockHash && String(p[0]).startsWith("0x26aa394e"))
      return events();
    return f.send(m, p);
  };
  const verdict = await verifyNativeSwap(send, plan, hash, blockNumber);
  expect(verdict.status, JSON.stringify(verdict)).toBe("verified");
  expect(verdict).toMatchObject({
    status: "verified",
    actualOut: plan.quotedOut,
    actualFee: "1810737180385",
    block: { number: blockNumber },
  });
  const forgedUnits = await quoteNativeSwap(nativeSwapNode({ decimals: 18 }).send, nativeInput);
  expect((await verifyNativeSwap(send, forgedUnits.plan, hash, blockNumber)).status).toBe("failed");
  output = "1";
  expect((await verifyNativeSwap(send, plan, hash, blockNumber)).status).toBe("failed");
  expect((await verifyNativeSwap(send, plan, hash, blockNumber + 1)).status).toBe("failed");
});
