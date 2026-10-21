import { hexToU8a } from "@polkadot/util";
import { keccakAsHex } from "@polkadot/util-crypto";
import type { Hex } from "@seam/compiler";

/**
 * Pure helpers for the P1-02 escrow deploy estimate (read-only; no RPC, no keys).
 *
 * pallet-revive's code hash is keccak256 of the code exactly as uploaded: the PolkaVM blob from resolc, or the EVM
 * init code when the runtime allows EVM bytecode. Checked on V3 spec 3002: ReviveApi_upload_code returns
 * keccak256(blob) for both (evidence/testnet-v3/escrow-dryrun-*.json).
 */
export function reviveCodeHash(code: Hex | Uint8Array): Hex {
  const b = typeof code === "string" ? hexToU8a(code) : code;
  if (b.length === 0) throw new Error("empty code");
  return keccakAsHex(b) as Hex;
}

/** resolc output starts with the PolkaVM magic "PVM\0". */
export function isPolkaVmBlob(code: Hex | Uint8Array): boolean {
  const b = typeof code === "string" ? hexToU8a(code) : code;
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x56 && b[2] === 0x4d && b[3] === 0x00;
}

/** Upper bound of a code upload's deposit from the runtime constants: one item plus every code byte. */
export function codeDepositUpperBound(codeBytes: number, perByte: bigint, perItem: bigint): bigint {
  if (!Number.isInteger(codeBytes) || codeBytes < 0)
    throw new Error("codeBytes must be a non-negative integer");
  return perItem + perByte * BigInt(codeBytes);
}

export interface DeployCost {
  /** partialFee of the deploy extrinsic (payment query_info). */
  fee: bigint;
  /** storage deposit the dry run charged (code + contract), held, not spent as fee. */
  storageDeposit: bigint;
  /** Extra fees and deposits (e.g. Revive.map_account) when the origin is not mapped; 0 otherwise. */
  mappingFee?: bigint;
  mappingDeposit?: bigint;
}

export interface BudgetFit {
  total: bigint;
  budgetLeft: bigint;
  fits: boolean;
  /** budgetLeft - total; negative when it does not fit. */
  margin: bigint;
  /** Balance the origin needs on top of its existential deposit. */
  originBalance?: bigint;
  originCovers?: boolean;
}

/** Total tPOT a deploy needs (fee + deposits) and whether it fits the remaining budget and the origin's balance. */
export function deployBudgetFit(
  cost: DeployCost,
  budgetLeft: bigint,
  originFree?: bigint,
  ed = 0n,
): BudgetFit {
  for (const v of [
    cost.fee,
    cost.storageDeposit,
    cost.mappingFee ?? 0n,
    cost.mappingDeposit ?? 0n,
    budgetLeft,
  ])
    if (v < 0n) throw new Error("amounts must be non-negative");
  const total =
    cost.fee + cost.storageDeposit + (cost.mappingFee ?? 0n) + (cost.mappingDeposit ?? 0n);
  const fit: BudgetFit = {
    total,
    budgetLeft,
    fits: total <= budgetLeft,
    margin: budgetLeft - total,
  };
  if (originFree !== undefined) {
    fit.originBalance = originFree;
    fit.originCovers = originFree >= total + ed;
  }
  return fit;
}
