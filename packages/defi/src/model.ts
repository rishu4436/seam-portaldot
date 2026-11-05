import { getAddress, isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import type { Review } from "./review.js";
export type Action = "swap" | "deposit" | "redeem";
export type Pin = { address: Address; codeHash: Hex };
export type Token = Pin & { symbol: string; decimals: number };
export type Registry = {
  version: 1;
  mode: "local" | "v3-testnet";
  chainId: number;
  rpcUrl: string;
  genesisHash: Hex;
  deploymentId: Hex;
  guard: Pin;
  tokens: [Token, Token];
  pool: Pin;
  vault: Token;
  createdAt: string;
  review?: Review;
};
export type Plan = {
  version: 1;
  id: Hex;
  registryHash: Hex;
  action: Action;
  account: Address;
  recipient: Address;
  target: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  quotedOut: string;
  minAmountOut: string;
  slippageBps: number;
  quoteBlock: string;
  quoteBlockHash: Hex;
  deadline: number;
  maxGasPrice: string;
  maxTotalFee: string;
  salt: Hex;
};
export class DeFiInvariantError extends Error {}
export function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new DeFiInvariantError(message);
}
export function object(value: unknown): Record<string, unknown> {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected an object",
  );
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, keys: string[]) {
  invariant(
    Object.keys(value).sort().join() === [...keys].sort().join(),
    "Unexpected or missing fields",
  );
}
export function address(value: unknown): Address {
  invariant(
    typeof value === "string" && isAddress(value, { strict: true }) && !/^0x0{40}$/i.test(value),
    "Invalid or zero EVM address",
  );
  return getAddress(value);
}
export function hash(value: unknown): Hex {
  invariant(typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value), "Invalid 32-byte hash");
  return value.toLowerCase() as Hex;
}
export function uint(value: unknown, positive = true): bigint {
  invariant(
    typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value),
    "Expected canonical unsigned integer",
  );
  const n = BigInt(value);
  invariant(n < 2n ** 256n && (!positive || n > 0n), "Integer outside allowed range");
  return n;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  invariant(value !== undefined && typeof value !== "bigint", "Nonportable value");
  return JSON.stringify(value);
}
export const digest = (value: unknown): Hex => keccak256(stringToHex(canonical(value)));
function pin(value: unknown): Pin {
  const v = object(value);
  exactKeys(v, ["address", "codeHash"]);
  return { address: address(v.address), codeHash: hash(v.codeHash) };
}
function token(value: unknown): Token {
  const v = object(value);
  exactKeys(v, ["address", "codeHash", "symbol", "decimals"]);
  invariant(
    typeof v.symbol === "string" && /^[A-Za-z0-9 ._-]{1,20}$/.test(v.symbol),
    "Invalid token symbol",
  );
  invariant(
    Number.isInteger(v.decimals) && Number(v.decimals) >= 0 && Number(v.decimals) <= 36,
    "Unsupported token precision",
  );
  return {
    ...pin({ address: v.address, codeHash: v.codeHash }),
    symbol: v.symbol,
    decimals: Number(v.decimals),
  };
}
export function parseRegistry(input: unknown): Registry {
  const v = object(input);
  exactKeys(v, [
    "version",
    "mode",
    "chainId",
    "rpcUrl",
    "genesisHash",
    "deploymentId",
    "guard",
    "tokens",
    "pool",
    "vault",
    "createdAt",
    ...(v.review !== undefined ? ["review"] : []),
  ]);
  invariant(
    v.version === 1 && (v.mode === "local" || v.mode === "v3-testnet"),
    "Unsupported market profile",
  );
  invariant(typeof v.rpcUrl === "string" && v.rpcUrl.length < 256, "Invalid RPC URL");
  let url: URL;
  try {
    url = new URL(v.rpcUrl);
  } catch {
    throw new DeFiInvariantError("Invalid RPC URL");
  }
  invariant(
    !url.username && !url.password && !url.search && !url.hash,
    "RPC URL must not contain credentials or query parameters",
  );
  if (v.mode === "local")
    invariant(
      v.chainId === 31337 &&
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      "Local market requires a loopback RPC and chain 31337",
    );
  else
    invariant(
      v.chainId === 420420777 && url.href === "https://test-evm-rpc-v3.portaldot.dev/",
      "Only the official V3 testnet endpoint is allowed",
    );
  invariant(Array.isArray(v.tokens) && v.tokens.length === 2, "Exactly two market tokens required");
  const tokens = v.tokens.map(token) as [Token, Token],
    vault = token(v.vault),
    guard = pin(v.guard),
    pool = pin(v.pool);
  invariant(
    new Set([
      ...tokens.map((t) => t.address.toLowerCase()),
      vault.address.toLowerCase(),
      guard.address.toLowerCase(),
      pool.address.toLowerCase(),
    ]).size === 5,
    "Market addresses must be distinct",
  );
  invariant(
    typeof v.createdAt === "string" && Number.isFinite(Date.parse(v.createdAt)),
    "Invalid creation time",
  );
  let review: Review | undefined;
  if (v.review !== undefined) {
    const input = object(v.review);
    exactKeys(input, ["id", "factory", "deployer", "deploymentTransaction"]);
    review = {
      id: hash(input.id),
      factory: pin(input.factory),
      deployer: address(input.deployer),
      deploymentTransaction: hash(input.deploymentTransaction),
    };
    invariant(
      ![guard.address, pool.address, vault.address, ...tokens.map((t) => t.address)].some(
        (a) => a.toLowerCase() === review!.factory.address.toLowerCase(),
      ),
      "Factory must be distinct from market contracts",
    );
  }
  return {
    version: 1,
    mode: v.mode,
    chainId: Number(v.chainId),
    rpcUrl: url.href,
    genesisHash: hash(v.genesisHash),
    deploymentId: hash(v.deploymentId),
    guard,
    pool,
    tokens,
    vault,
    createdAt: v.createdAt,
    ...(review ? { review } : {}),
  };
}
export function planId(plan: Omit<Plan, "id">): Hex {
  return digest(plan);
}
export function parsePlan(input: unknown, registry: Registry): Plan {
  const v = object(input);
  exactKeys(v, [
    "version",
    "id",
    "registryHash",
    "action",
    "account",
    "recipient",
    "target",
    "tokenIn",
    "tokenOut",
    "amountIn",
    "quotedOut",
    "minAmountOut",
    "slippageBps",
    "quoteBlock",
    "quoteBlockHash",
    "deadline",
    "maxGasPrice",
    "maxTotalFee",
    "salt",
  ]);
  invariant(
    v.version === 1 && ["swap", "deposit", "redeem"].includes(String(v.action)),
    "Unsupported action",
  );
  const p = v as unknown as Plan;
  for (const field of [p.account, p.recipient, p.target, p.tokenIn, p.tokenOut]) address(field);
  for (const field of [p.id, p.registryHash, p.quoteBlockHash, p.salt]) hash(field);
  invariant(p.registryHash === digest(registry), "Market configuration changed");
  const a = uint(p.amountIn),
    q = uint(p.quotedOut),
    m = uint(p.minAmountOut);
  uint(p.quoteBlock, false);
  uint(p.maxGasPrice);
  uint(p.maxTotalFee);
  invariant(
    a > 0n &&
      m <= q &&
      Number.isInteger(p.slippageBps) &&
      p.slippageBps >= 1 &&
      p.slippageBps <= 500 &&
      m === (q * BigInt(10000 - p.slippageBps)) / 10000n,
    "Invalid slippage bounds",
  );
  invariant(Number.isSafeInteger(p.deadline) && p.deadline > 0, "Invalid deadline");
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (p.action === "swap")
    invariant(
      same(p.target, registry.pool.address) &&
        registry.tokens.some((t) => same(t.address, p.tokenIn)) &&
        registry.tokens.some((t) => same(t.address, p.tokenOut)) &&
        !same(p.tokenIn, p.tokenOut),
      "Invalid swap path",
    );
  else
    invariant(
      same(p.target, registry.vault.address) &&
        same(
          p.tokenIn,
          p.action === "deposit" ? registry.tokens[0].address : registry.vault.address,
        ) &&
        same(
          p.tokenOut,
          p.action === "deposit" ? registry.vault.address : registry.tokens[0].address,
        ),
      "Invalid vault path",
    );
  invariant(
    !same(p.recipient, registry.guard.address) && !same(p.recipient, p.target),
    "Invalid recipient",
  );
  const { id, ...body } = p;
  invariant(id === planId(body), "Plan integrity mismatch");
  return p;
}
