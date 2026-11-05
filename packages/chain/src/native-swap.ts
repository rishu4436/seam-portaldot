import { StorageKey } from "@polkadot/types";
import type { Codec } from "@polkadot/types/types";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { blake2AsHex, decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import type { Hex, RuntimeFacts } from "@seam/compiler/facts";
import { factsFromChainInputs } from "./facts-core.js";
import { decodeRuntime, extrinsicHash, storageKey, SYSTEM_EVENTS_KEY } from "./runtime.js";
import { metadataLayoutHash } from "./metadata-layout.js";
import { clientFromSend, asHash, toBigInt, toSafeNumber, type RpcSend } from "./rpc-core.js";
import { readStorageValue, type StorageEntryLoose } from "./storage-read.js";
import { readAccountReadiness } from "./account-readiness.js";
import { fakeSignedExtrinsic } from "./preflight-core.js";
import { buildSigningRequest, verifySignedAgainstRequest } from "./signing.js";
import { outcomeForExtrinsic, type ChainEvent } from "./events.js";
import { V3_RPC_IDENTITY } from "./resilient-rpc.js";

export const NATIVE_SWAP_SPEC = 3002;
export const NATIVE_SWAP_LAYOUT =
  "0x221ba8f7dd81e0341fca9f0074a3e433659c97300cbbb2f874dbd5f0d998b304";
export const NATIVE_SWAP_MORTALITY = 32;
export const NATIVE_SWAP_QUOTE_MS = 120000;
export const NATIVE_SWAP_SCALE = 100000000000000n;
export type NativePool = {
  assetId: number;
  symbol: string;
  decimals: number;
  nativeReserve: string;
  assetReserve: string;
  minBalance: string;
  feePpm: number;
};
export type NativeSwapContext = { facts: RuntimeFacts; block: { number: number; hash: Hex } };
export interface NativeSwapPlan {
  version: 1;
  id: Hex;
  signer: string;
  assetId: number;
  reverse: boolean;
  assetDecimals: number;
  poolFeePpm: number;
  amountIn: string;
  quotedOut: string;
  minOut: string;
  slippageBps: number;
  estimatedFee: string;
  feeLimit: string;
  nonce: number;
  block: { number: number; hash: Hex };
  layoutHash: string;
  createdAt: number;
  expiresAt: number;
}
export type NativeSwapVerification = {
  status: "verified" | "reverted" | "pending" | "failed" | "expired";
  message: string;
  block?: { number: number; hash: Hex };
  actualOut?: string;
  actualFee?: string;
};
const requireThat: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw Error(message);
};
const uint = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(0|[1-9]\d*)$/.test(value) &&
  value.length <= 39 &&
  BigInt(value) < 2n ** 128n;
const account = (address: string) => {
  const bytes = decodeAddress(address);
  requireThat(bytes.length === 32, "Connect a native AccountId32 wallet.");
  return encodeAddress(bytes, 42);
};
const kind = (id?: number) => (id === undefined ? { Native: null } : { WithId: id });
const pair = (p: Pick<NativeSwapPlan, "assetId" | "reverse">) =>
  p.reverse ? [kind(p.assetId), kind()] : [kind(), kind(p.assetId)];
type Num = { toBigInt(): bigint };
type Text = { toUtf8(): string };
type Data = Record<string, Codec & Num & Text>;
function runtime(facts: RuntimeFacts) {
  requireThat(
    facts.fingerprint.genesisHash === V3_RPC_IDENTITY.genesisHash &&
      facts.fingerprint.specName === V3_RPC_IDENTITY.specName &&
      facts.fingerprint.specVersion === NATIVE_SWAP_SPEC &&
      facts.fingerprint.transactionVersion === 2 &&
      facts.fingerprint.tokenDecimals === 14 &&
      facts.fingerprint.tokenSymbol === "tPOT",
    "Native swaps require the reviewed V3 testnet runtime (spec 3002).",
  );
  const rt = decodeRuntime(facts);
  requireThat(
    metadataLayoutHash(facts.source.metadataHex) === NATIVE_SWAP_LAYOUT,
    "The native runtime layout differs from the reviewed V3 layout. A new review is required.",
  );
  const pallet = rt.metadata.asLatest.pallets.find((p) => p.name.toString() === "AssetConversion");
  requireThat(pallet?.calls.isSome, "Native DEX calls are unavailable.");
  const call = rt.registry.lookup
    .getSiType(pallet.calls.unwrap().type)
    .def.asVariant.variants.find((v) => v.name.toString() === "swap_exact_tokens_for_tokens");
  requireThat(
    pallet.index.toNumber() === 65 &&
      call?.index.toNumber() === 3 &&
      call.fields.map((f) => f.name.toString()).join(",") ===
        "path,amount_in,amount_out_min,send_to,keep_alive",
    "The native swap call layout changed. A new review is required.",
  );
  return rt;
}
export async function readNativeSwapContext(send: RpcSend): Promise<NativeSwapContext> {
  const [genesis, hash, properties] = await Promise.all([
    send("chain_getBlockHash", [0]),
    send("chain_getFinalizedHead", []),
    send("system_properties", []),
  ]);
  const blockHash = asHash(hash, "finalized head");
  const [version, metadata, header] = await Promise.all([
    send("state_getRuntimeVersion", [blockHash]),
    send("state_getMetadata", [blockHash]),
    send("chain_getHeader", [blockHash]),
  ]);
  const block = { number: toSafeNumber((header as { number: unknown }).number), hash: blockHash };
  const facts = factsFromChainInputs({
    genesisHash: asHash(genesis, "genesis"),
    metadataHex: asHashMetadata(metadata),
    runtimeVersion: version as never,
    properties: properties as never,
    head: block,
  });
  runtime(facts);
  return { facts, block };
}
function asHashMetadata(value: unknown): Hex {
  requireThat(
    typeof value === "string" && /^0x6d657461[0-9a-f]+$/i.test(value),
    "Runtime metadata is missing.",
  );
  return value as Hex;
}
async function storage(
  send: RpcSend,
  ctx: NativeSwapContext,
  section: string,
  name: string,
  args: unknown[],
) {
  const query = runtime(ctx.facts).decorated().query as unknown as Record<
    string,
    Record<string, StorageEntryLoose>
  >;
  const entry = query[section]?.[name];
  requireThat(entry, `Missing ${section}.${name} storage.`);
  return (await readStorageValue(
    clientFromSend(send),
    ctx.facts,
    entry,
    args,
    ctx.block.hash,
  )) as Data | null;
}
async function conversion(
  send: RpcSend,
  ctx: NativeSwapContext,
  method: string,
  assets: unknown[],
  amount?: string,
) {
  const rt = runtime(ctx.facts),
    pallet = rt.metadata.asLatest.pallets.find((p) => p.name.toString() === "AssetConversion")!;
  const call = rt.registry.lookup
    .getSiType(pallet.calls.unwrap().type)
    .def.asVariant.variants.find((v) => v.name.toString() === "create_pool")!;
  const assetType = rt.registry.createLookupType(call.fields[0]!.type);
  const input =
    "0x" +
    assets.map((a) => u8aToHex(rt.registry.createType(assetType, a).toU8a()).slice(2)).join("") +
    (amount === undefined
      ? ""
      : u8aToHex(rt.registry.createType("u128", amount).toU8a()).slice(2) + "01");
  const raw = await send("state_call", [`AssetConversionApi_${method}`, input, ctx.block.hash]);
  requireThat(
    typeof raw === "string" && /^0x[0-9a-f]+$/i.test(raw),
    "The DEX quote is unavailable.",
  );
  const codec = rt.registry.createType(
    amount === undefined ? "Option<(u128,u128)>" : "Option<u128>",
    hexToU8a(raw),
  );
  requireThat(u8aToHex(codec.toU8a()) === raw.toLowerCase(), "Invalid DEX quote encoding.");
  return codec as unknown as { isSome: boolean; unwrap(): Num & [Num, Num] };
}
export async function readNativePool(
  send: RpcSend,
  ctx: NativeSwapContext,
  assetId: number,
): Promise<NativePool> {
  requireThat(
    Number.isInteger(assetId) && assetId >= 0 && assetId <= 0xffffffff,
    "Invalid asset ID.",
  );
  const [info, meta, reserves, customFee] = await Promise.all([
    storage(send, ctx, "assets", "asset", [assetId]),
    storage(send, ctx, "assets", "metadata", [assetId]),
    conversion(send, ctx, "get_reserves", [kind(), kind(assetId)]),
    storage(send, ctx, "assetConversion", "poolFees", [[kind(), kind(assetId)]]),
  ]);
  requireThat(
    info &&
      meta &&
      info.status?.toString() === "Live" &&
      meta.isFrozen?.toString() === "false" &&
      reserves.isSome,
    "This asset has no usable native pool or is frozen.",
  );
  const [nativeReserve, assetReserve] = reserves.unwrap(),
    decimals = Number(meta.decimals!.toBigInt());
  const consts = runtime(ctx.facts).decorated().consts as unknown as {
    assetConversion: { lpFee: Num };
  };
  const feePpm = Number(
    customFee ? (customFee as unknown as Num).toBigInt() : consts.assetConversion.lpFee.toBigInt(),
  );
  requireThat(
    nativeReserve.toBigInt() > 0n &&
      assetReserve.toBigInt() > 0n &&
      decimals >= 0 &&
      decimals <= 38 &&
      feePpm >= 0 &&
      feePpm <= 20000,
    "Pool reserves, decimals or fees are unsupported.",
  );
  return {
    assetId,
    symbol: meta.symbol!.toUtf8().replace(/\p{C}/gu, "").slice(0, 24) || `Asset ${assetId}`,
    decimals,
    nativeReserve: nativeReserve.toBigInt().toString(),
    assetReserve: assetReserve.toBigInt().toString(),
    minBalance: info.minBalance!.toBigInt().toString(),
    feePpm,
  };
}
export async function discoverNativePools(
  send: RpcSend,
  ctx: NativeSwapContext,
): Promise<NativePool[]> {
  const rt = runtime(ctx.facts),
    entry = (
      rt.decorated().query as unknown as {
        assetConversion: { pools: StorageEntryLoose & { keyPrefix(): Uint8Array } };
      }
    ).assetConversion.pools;
  const prefix = u8aToHex(entry.keyPrefix()),
    keys = await send("state_getKeysPaged", [prefix, 32, null, ctx.block.hash]);
  requireThat(Array.isArray(keys) && keys.length <= 32, "Pool discovery returned invalid data.");
  const ids: number[] = [];
  for (const key of keys) {
    requireThat(
      typeof key === "string" && key.startsWith(prefix) && key.length <= 512,
      "Invalid pool storage key.",
    );
    const decoded = new StorageKey(rt.registry, key).setMeta(entry.meta as never),
      value = decoded.args[0];
    requireThat(
      value && storageKey(entry, value).toLowerCase() === key.toLowerCase(),
      "Pool key did not round-trip.",
    );
    const items = value.toJSON() as [
      { native?: null; withId?: number },
      { native?: null; withId?: number },
    ];
    if (items.length === 2 && "native" in items[0] && Number.isInteger(items[1].withId))
      ids.push(items[1].withId!);
  }
  const pools = await Promise.allSettled(
    [...new Set(ids)].map((id) => readNativePool(send, ctx, id)),
  );
  return pools
    .flatMap((p) => (p.status === "fulfilled" ? [p.value] : []))
    .sort((a, b) =>
      a.assetId === 8801000 ? -1 : b.assetId === 8801000 ? 1 : a.assetId - b.assetId,
    );
}
export function nativeSwapCall(
  facts: RuntimeFacts,
  p: Pick<NativeSwapPlan, "assetId" | "reverse" | "amountIn" | "minOut" | "signer">,
): Hex {
  const rt = runtime(facts);
  return rt.registry
    .createType("Call", {
      callIndex: new Uint8Array([65, 3]),
      args: [pair(p), p.amountIn, p.minOut, account(p.signer), true],
    })
    .toHex() as Hex;
}
function planHash(p: Omit<NativeSwapPlan, "id">) {
  return blake2AsHex(
    JSON.stringify([
      p.version,
      p.signer,
      p.assetId,
      p.reverse,
      p.assetDecimals,
      p.poolFeePpm,
      p.amountIn,
      p.quotedOut,
      p.minOut,
      p.slippageBps,
      p.estimatedFee,
      p.feeLimit,
      p.nonce,
      p.block.number,
      p.block.hash,
      p.layoutHash,
      p.createdAt,
      p.expiresAt,
    ]),
    256,
  ) as Hex;
}
export function parseNativeSwapPlan(input: unknown): NativeSwapPlan {
  const p = input as NativeSwapPlan;
  requireThat(
    p &&
      p.version === 1 &&
      typeof p.signer === "string" &&
      account(p.signer) === p.signer &&
      Number.isInteger(p.assetId) &&
      p.assetId >= 0 &&
      p.assetId <= 0xffffffff &&
      typeof p.reverse === "boolean" &&
      Number.isInteger(p.assetDecimals) &&
      p.assetDecimals >= 0 &&
      p.assetDecimals <= 38 &&
      Number.isInteger(p.poolFeePpm) &&
      p.poolFeePpm >= 0 &&
      p.poolFeePpm <= 20000 &&
      [p.amountIn, p.quotedOut, p.minOut, p.estimatedFee, p.feeLimit].every(uint) &&
      BigInt(p.amountIn) > 0n &&
      BigInt(p.quotedOut) > 0n &&
      BigInt(p.minOut) > 0n &&
      Number.isInteger(p.slippageBps) &&
      p.slippageBps >= 1 &&
      p.slippageBps <= 500 &&
      BigInt(p.minOut) === (BigInt(p.quotedOut) * BigInt(10000 - p.slippageBps)) / 10000n &&
      BigInt(p.estimatedFee) > 0n &&
      BigInt(p.estimatedFee) <= BigInt(p.feeLimit) &&
      BigInt(p.feeLimit) <= NATIVE_SWAP_SCALE / 10n &&
      Number.isSafeInteger(p.nonce) &&
      p.nonce >= 0 &&
      p.block &&
      Number.isSafeInteger(p.block.number) &&
      p.block.number >= 0 &&
      /^0x[0-9a-f]{64}$/.test(p.block.hash) &&
      /^0x[0-9a-f]{64}$/.test(p.layoutHash) &&
      Number.isSafeInteger(p.createdAt) &&
      p.createdAt > 0 &&
      p.expiresAt === p.createdAt + NATIVE_SWAP_QUOTE_MS &&
      p.id === planHash(p),
    "Invalid native swap plan.",
  );
  const keys = [
    "version",
    "id",
    "signer",
    "assetId",
    "reverse",
    "assetDecimals",
    "poolFeePpm",
    "amountIn",
    "quotedOut",
    "minOut",
    "slippageBps",
    "estimatedFee",
    "feeLimit",
    "nonce",
    "block",
    "layoutHash",
    "createdAt",
    "expiresAt",
  ];
  requireThat(
    Object.keys(p).every((k) => keys.includes(k)) &&
      Object.keys(p.block).every((k) => ["number", "hash"].includes(k)),
    "Unexpected fields in swap plan.",
  );
  return p;
}
export async function estimateNativeSwapFee(
  send: RpcSend,
  ctx: NativeSwapContext,
  plan: Pick<NativeSwapPlan, "assetId" | "reverse" | "amountIn" | "minOut" | "signer" | "nonce">,
  signed?: Hex,
) {
  const ext =
    signed ??
    fakeSignedExtrinsic(
      nativeSwapCall(ctx.facts, plan),
      ctx.facts,
      u8aToHex(decodeAddress(plan.signer)) as Hex,
      plan.nonce,
      ctx.block,
    );
  const info = (await send("payment_queryInfo", [ext, ctx.block.hash])) as { partialFee?: unknown };
  const fee = toBigInt(info?.partialFee);
  requireThat(fee > 0n, "A positive native fee estimate is required.");
  return fee.toString();
}
async function checkBalance(
  send: RpcSend,
  ctx: NativeSwapContext,
  p: Pick<NativeSwapPlan, "signer" | "assetId" | "amountIn" | "reverse" | "feeLimit">,
) {
  const balances = await readAccountReadiness(send, ctx.facts, p.signer, [String(p.assetId)], {
    at: ctx.block.hash,
  });
  requireThat(
    balances.native.known && balances.assets[0]?.balance.known,
    "Balances could not be checked. Nothing will be signed.",
  );
  const native = balances.native.value,
    asset = balances.assets[0].balance.value;
  requireThat(
    BigInt(native.free) - BigInt(native.frozen) >=
      BigInt(native.existentialDeposit) +
        BigInt(p.feeLimit) * 2n +
        (p.reverse ? 0n : BigInt(p.amountIn)),
    "Keep enough tPOT for the swap, network fees and account minimum.",
  );
  requireThat(
    asset.exists && (!p.reverse || BigInt(asset.balance) >= BigInt(p.amountIn)),
    "Insufficient asset balance.",
  );
  if (p.reverse)
    requireThat(
      BigInt(asset.balance) - BigInt(p.amountIn) >= BigInt(asset.minBalance),
      "Keep the asset account minimum when swapping back. Use the available balance rather than the entire balance.",
    );
  return balances;
}
export async function quoteNativeSwap(
  send: RpcSend,
  input: {
    signer: string;
    assetId: number;
    reverse: boolean;
    amountIn: string;
    slippageBps: number;
    feeLimit: string;
  },
  now = Date.now(),
) {
  requireThat(
    uint(input.amountIn) &&
      BigInt(input.amountIn) > 0n &&
      uint(input.feeLimit) &&
      BigInt(input.feeLimit) > 0n &&
      BigInt(input.feeLimit) <= NATIVE_SWAP_SCALE / 10n &&
      Number.isInteger(input.slippageBps) &&
      input.slippageBps >= 1 &&
      input.slippageBps <= 500,
    "Use a positive amount, slippage from 0.01% to 5% and a fee review limit up to 0.1 tPOT.",
  );
  const ctx = await readNativeSwapContext(send),
    pool = await readNativePool(send, ctx, input.assetId);
  const reserveIn = BigInt(input.reverse ? pool.assetReserve : pool.nativeReserve),
    amount = BigInt(input.amountIn);
  requireThat(
    amount * 100n <= reserveIn * 2n &&
      (input.reverse
        ? (amount * BigInt(pool.nativeReserve)) / BigInt(pool.assetReserve)
        : amount) <= NATIVE_SWAP_SCALE,
    "For testnet safety, use at most 1 tPOT of input value and 2% of the input reserve.",
  );
  const quote = await conversion(
    send,
    ctx,
    "quote_price_exact_tokens_for_tokens",
    pair(input),
    input.amountIn,
  );
  requireThat(
    quote.isSome && quote.unwrap().toBigInt() > 0n,
    "No executable quote for this amount. Try another pool or amount.",
  );
  const quotedOut = quote.unwrap().toBigInt().toString(),
    minOut = ((BigInt(quotedOut) * BigInt(10000 - input.slippageBps)) / 10000n).toString();
  requireThat(
    BigInt(minOut) > 0n && (input.reverse || BigInt(minOut) >= BigInt(pool.minBalance)),
    "Output is below the asset minimum. Increase the amount.",
  );
  const base = {
    ...input,
    signer: account(input.signer),
    minOut,
    nonce: toSafeNumber(await send("system_accountNextIndex", [input.signer])),
  };
  const estimatedFee = await estimateNativeSwapFee(send, ctx, base);
  requireThat(
    BigInt(estimatedFee) <= BigInt(input.feeLimit),
    "The fee estimate exceeds your review limit.",
  );
  const body: Omit<NativeSwapPlan, "id"> = {
    version: 1,
    ...base,
    assetDecimals: pool.decimals,
    poolFeePpm: pool.feePpm,
    quotedOut,
    estimatedFee,
    block: ctx.block,
    layoutHash: metadataLayoutHash(ctx.facts.source.metadataHex),
    createdAt: now,
    expiresAt: now + NATIVE_SWAP_QUOTE_MS,
  };
  const plan = parseNativeSwapPlan({ ...body, id: planHash(body) });
  const balances = await checkBalance(send, ctx, plan);
  return { ctx, pool, plan, balances };
}
export function nativeSwapSigningRequest(ctx: NativeSwapContext, plan: NativeSwapPlan) {
  parseNativeSwapPlan(plan);
  requireThat(
    metadataLayoutHash(ctx.facts.source.metadataHex) === plan.layoutHash,
    "The runtime layout changed. Read a new quote.",
  );
  return buildSigningRequest(nativeSwapCall(ctx.facts, plan), ctx.facts, {
    signer: plan.signer,
    nonce: plan.nonce,
    mortalityBlocks: NATIVE_SWAP_MORTALITY,
    checkpoint: plan.block,
  });
}
export async function recheckNativeSwap(
  send: RpcSend,
  plan: NativeSwapPlan,
  now = Date.now(),
  signed?: Hex,
) {
  parseNativeSwapPlan(plan);
  requireThat(
    now >= plan.createdAt && now < plan.expiresAt,
    "This quote expired. Read a new quote and approve it again.",
  );
  const ctx = await readNativeSwapContext(send);
  nativeSwapSigningRequest(ctx, plan);
  const [nonce, best, checkpoint, pool] = await Promise.all([
    send("system_accountNextIndex", [plan.signer]),
    send("chain_getHeader", []),
    send("chain_getBlockHash", [plan.block.number]),
    readNativePool(send, ctx, plan.assetId),
  ]);
  requireThat(
    pool.decimals === plan.assetDecimals && pool.feePpm === plan.poolFeePpm,
    "The asset decimals or pool fee changed. Read a new quote.",
  );
  const currentInputReserve = BigInt(plan.reverse ? pool.assetReserve : pool.nativeReserve),
    inputAmount = BigInt(plan.amountIn);
  requireThat(
    inputAmount * 100n <= currentInputReserve * 2n &&
      (plan.reverse
        ? (inputAmount * BigInt(pool.nativeReserve)) / BigInt(pool.assetReserve)
        : inputAmount) <= NATIVE_SWAP_SCALE,
    "The current pool reserves exceed the approved test input limits. Read a smaller quote.",
  );
  requireThat(
    toSafeNumber(nonce) === plan.nonce &&
      checkpoint === plan.block.hash &&
      toSafeNumber((best as { number: unknown }).number) <
        plan.block.number + NATIVE_SWAP_MORTALITY - 2,
    "The nonce or signing window changed. Read a new quote.",
  );
  const quote = await conversion(
    send,
    ctx,
    "quote_price_exact_tokens_for_tokens",
    pair(plan),
    plan.amountIn,
  );
  requireThat(
    quote.isSome &&
      quote.unwrap().toBigInt() >= BigInt(plan.minOut) &&
      (plan.reverse || BigInt(plan.minOut) >= BigInt(pool.minBalance)),
    "The pool moved beyond your minimum output. Read a new quote.",
  );
  requireThat(
    BigInt(await estimateNativeSwapFee(send, ctx, plan, signed)) <= BigInt(plan.feeLimit),
    "The current fee estimate exceeds your review limit.",
  );
  await checkBalance(send, ctx, plan);
  return ctx;
}
export function verifyNativeSwapEvents(events: ChainEvent[], p: NativeSwapPlan) {
  const swaps = events.filter((e) => e.pallet === "AssetConversion" && e.name === "SwapExecuted");
  requireThat(swaps.length === 1, "Exactly one native swap event is required.");
  const e = swaps[0]!,
    expectedAccount = u8aToHex(decodeAddress(p.signer)).toLowerCase();
  requireThat(
    e.args[0]?.toLowerCase() === expectedAccount &&
      e.args[1]?.toLowerCase() === expectedAccount &&
      e.args[2] === p.amountIn &&
      uint(e.args[3]) &&
      BigInt(e.args[3]!) >= BigInt(p.minOut),
    "Swap event account, amount or minimum output does not match.",
  );
  const path: unknown = JSON.parse(e.args[4] ?? "null");
  requireThat(Array.isArray(path) && path.length === 2, "Swap event has an unexpected path.");
  const expected = pair(p).map((v) => ("Native" in v ? { native: null } : { withId: v.WithId }));
  for (let i = 0; i < 2; i++) {
    requireThat(
      Array.isArray(path[i]) &&
        path[i].length === 2 &&
        JSON.stringify(path[i][0]) === JSON.stringify(expected[i]) &&
        toBigInt(path[i][1]).toString() === (i === 0 ? p.amountIn : e.args[3]),
      "Swap event path does not match the plan.",
    );
  }
  return e.args[3]!;
}
export async function verifyNativeSwap(
  send: RpcSend,
  planInput: unknown,
  hash: Hex,
  knownBlock?: number,
): Promise<NativeSwapVerification> {
  try {
    const plan = parseNativeSwapPlan(planInput);
    asHash(hash, "transaction hash");
    const current = await readNativeSwapContext(send),
      end = Math.min(current.block.number, plan.block.number + NATIVE_SWAP_MORTALITY);
    const numbers =
      knownBlock === undefined
        ? Array.from(
            { length: Math.max(0, end - plan.block.number + 1) },
            (_, i) => plan.block.number + i,
          )
        : [knownBlock];
    for (const number of numbers) {
      requireThat(
        number >= plan.block.number && number <= end,
        "Receipt block is outside the finalized signing window.",
      );
      const blockHash = asHash(await send("chain_getBlockHash", [number]), "block hash");
      const body = (await send("chain_getBlock", [blockHash])) as {
        block: { header: { parentHash: Hex }; extrinsics: string[] };
      };
      requireThat(Array.isArray(body?.block?.extrinsics), "Finalized block body is missing.");
      const index = body.block.extrinsics.findIndex((x) => extrinsicHash(x) === hash);
      if (index < 0) continue;
      const parent = body.block.header.parentHash;
      const [metadata, version, rawEvents] = await Promise.all([
        send("state_getMetadata", [parent]),
        send("state_getRuntimeVersion", [parent]),
        send("state_getStorage", [SYSTEM_EVENTS_KEY, blockHash]),
      ]);
      const facts = factsFromChainInputs({
        genesisHash: current.facts.fingerprint.genesisHash,
        metadataHex: asHashMetadata(metadata),
        runtimeVersion: version as never,
        properties: { ss58Format: 42, tokenDecimals: 14, tokenSymbol: "tPOT" },
        head: { number: number - 1, hash: parent },
      });
      const ctx = { facts, block: plan.block },
        request = nativeSwapSigningRequest(ctx, plan);
      requireThat(
        (await send("chain_getBlockHash", [plan.block.number])) === plan.block.hash,
        "The quote checkpoint is not canonical.",
      );
      const [quotedPool, historicalQuote] = await Promise.all([
        readNativePool(send, ctx, plan.assetId),
        conversion(send, ctx, "quote_price_exact_tokens_for_tokens", pair(plan), plan.amountIn),
      ]);
      requireThat(
        quotedPool.decimals === plan.assetDecimals &&
          quotedPool.feePpm === plan.poolFeePpm &&
          historicalQuote.isSome &&
          historicalQuote.unwrap().toBigInt().toString() === plan.quotedOut,
        "Archived asset units, pool fee or quote do not match historical chain state.",
      );
      requireThat(
        verifySignedAgainstRequest(body.block.extrinsics[index]!, request, { facts }).ok,
        "Finalized transaction does not match the signed plan.",
      );
      requireThat(typeof rawEvents === "string", "Finalized events are missing.");
      const outcome = outcomeForExtrinsic(rawEvents, index, facts),
        block = { number, hash: blockHash };
      if (outcome.success === false)
        return {
          status: "reverted",
          message: outcome.dispatchError ?? "Execution failed; network fees may have been charged.",
          block,
        };
      requireThat(outcome.success === true, "Execution success is not proven.");
      const actualOut = verifyNativeSwapEvents(outcome.events, plan),
        fee = outcome.events.find(
          (e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid",
        );
      return {
        status: "verified",
        message: "Finalized call and native swap effect match the approved plan.",
        block,
        actualOut,
        ...(fee && uint(fee.args[1]) ? { actualFee: fee.args[1] } : {}),
      };
    }
    return current.block.number >= plan.block.number + NATIVE_SWAP_MORTALITY &&
      knownBlock === undefined
      ? {
          status: "expired",
          message:
            "The entire mortal signing window is finalized and the transaction was not found. Nothing was resubmitted.",
        }
      : {
          status: "pending",
          message: "Not found in a finalized block yet. Recovery only reads the chain.",
        };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
