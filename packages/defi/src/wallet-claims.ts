import {
  address,
  exactKeys,
  hash,
  invariant,
  object,
  uint,
  parseRegistry,
  type Registry,
} from "./model.js";
import { factoryCreationData, REVIEW_ID, V3_EVM_GENESIS } from "./review.js";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { marketAbi } from "./abi.js";
import type { StorageLike } from "./store.js";
export const WALLET_CLAIMS_KEY = "seam.defi.wallet-claims.v1";
export type WalletClaim = {
  version: 1;
  id: Hex;
  kind: "deploy-market" | "claim-test-assets";
  chainId: 31337 | 420420777;
  rpcUrl: string;
  genesisHash: Hex;
  account: Address;
  to: Address | null;
  data: Hex;
  deploymentId: Hex;
  reviewId: Hex;
  nonce: number;
  fromBlock: string;
  gas: string;
  gasPrice: string;
  maxCost: string;
  state: "requesting" | "submitted" | "confirmed" | "reverted" | "rejected" | "uncertain";
  hash?: Hex;
  createdAt: string;
  registry?: Registry;
};
export class WalletClaimStore {
  constructor(private readonly storage: StorageLike) {}
  list(): WalletClaim[] {
    const text = this.storage.getItem(WALLET_CLAIMS_KEY);
    if (!text) return [];
    invariant(text.length <= 2_000_000, "Wallet request journal exceeds size limit");
    const rows: unknown = JSON.parse(text);
    invariant(Array.isArray(rows) && rows.length <= 30, "Invalid wallet request journal");
    return rows.map(validate);
  }
  pending(account: Address, chainId: number) {
    return this.list().filter(
      (row) =>
        row.account.toLowerCase() === account.toLowerCase() &&
        row.chainId === chainId &&
        ["requesting", "submitted", "uncertain"].includes(row.state),
    );
  }
  save(input: WalletClaim) {
    const row = validate(input),
      rows = this.list(),
      at = rows.findIndex((item) => item.id === row.id);
    if (at < 0) {
      invariant(
        rows.length < 30,
        "Wallet request journal is full. Remove a settled request first.",
      );
      rows.unshift(row);
    } else rows[at] = row;
    const text = JSON.stringify(rows);
    invariant(text.length <= 2_000_000, "Wallet request journal is full");
    this.storage.setItem(WALLET_CLAIMS_KEY, text);
  }
  remove(id: Hex) {
    const rows = this.list(),
      row = rows.find((item) => item.id === id);
    invariant(
      !row || !["requesting", "submitted", "uncertain"].includes(row.state),
      "Unresolved wallet requests cannot be removed",
    );
    this.storage.setItem(WALLET_CLAIMS_KEY, JSON.stringify(rows.filter((item) => item.id !== id)));
  }
}
function validate(value: unknown): WalletClaim {
  const v = object(value);
  exactKeys(v, [
    "version",
    "id",
    "kind",
    "chainId",
    "rpcUrl",
    "genesisHash",
    "account",
    "to",
    "data",
    "deploymentId",
    "reviewId",
    "nonce",
    "fromBlock",
    "gas",
    "gasPrice",
    "maxCost",
    "state",
    "createdAt",
    ...(v.hash !== undefined ? ["hash"] : []),
    ...(v.registry !== undefined ? ["registry"] : []),
  ]);
  invariant(
    v.version === 1 && ["deploy-market", "claim-test-assets"].includes(String(v.kind)),
    "Invalid wallet request kind",
  );
  invariant(
    v.chainId === 31337 || v.chainId === 420420777,
    "Wallet request is not on an allowed test network",
  );
  invariant(
    typeof v.rpcUrl === "string" && v.rpcUrl.length < 256,
    "Invalid wallet request endpoint",
  );
  const endpoint = new URL(v.rpcUrl);
  invariant(
    !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    "Credentials are not allowed in a wallet request endpoint",
  );
  invariant(
    v.chainId === 420420777
      ? endpoint.href === "https://test-evm-rpc-v3.portaldot.dev/"
      : endpoint.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname),
    "Invalid wallet request endpoint",
  );
  for (const field of [v.id, v.genesisHash, v.deploymentId, v.reviewId]) hash(field);
  invariant(v.chainId !== 420420777 || v.genesisHash === V3_EVM_GENESIS, "Unrecognized V3 genesis");
  address(v.account);
  if (v.to !== null) address(v.to);
  invariant(v.reviewId === REVIEW_ID, "Wallet request uses a different reviewed program");
  invariant(Number.isSafeInteger(v.nonce) && Number(v.nonce) >= 0, "Invalid wallet request nonce");
  for (const field of [v.fromBlock, v.gas, v.gasPrice, v.maxCost]) uint(field, false);
  invariant(
    ["requesting", "submitted", "confirmed", "reverted", "rejected", "uncertain"].includes(
      String(v.state),
    ),
    "Invalid wallet request state",
  );
  if (v.hash !== undefined) hash(v.hash);
  invariant(
    !["submitted", "confirmed", "reverted"].includes(String(v.state)) || v.hash !== undefined,
    "Settled or submitted wallet request needs a hash",
  );
  invariant(
    BigInt(v.gas as string) > 0n &&
      BigInt(v.gasPrice as string) > 0n &&
      BigInt(v.maxCost as string) >= BigInt(v.gas as string) * BigInt(v.gasPrice as string),
    "Invalid wallet request budget",
  );
  if (v.registry !== undefined) {
    const r = parseRegistry(v.registry);
    invariant(
      v.kind === "deploy-market" &&
        r.review?.deploymentTransaction === v.hash &&
        r.deploymentId === v.deploymentId &&
        r.chainId === v.chainId &&
        r.rpcUrl === v.rpcUrl &&
        r.genesisHash === v.genesisHash,
      "Wallet request profile mismatch",
    );
    v.registry = r;
  }
  invariant(
    typeof v.createdAt === "string" &&
      v.createdAt.length < 40 &&
      Number.isFinite(Date.parse(v.createdAt)),
    "Invalid wallet request time",
  );
  invariant(
    v.kind === "deploy-market"
      ? v.to === null && v.data === factoryCreationData(v.deploymentId as Hex)
      : v.to !== null &&
          v.data === encodeFunctionData({ abi: marketAbi, functionName: "claimTestAssets" }),
    "Wallet request payload differs from its reviewed operation",
  );
  return v as unknown as WalletClaim;
}
