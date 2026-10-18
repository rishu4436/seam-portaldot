import { checkAddress, decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import type { CompileIssue, Hex } from "./types.js";

export interface NativeAddress {
  /** SS58 form using the chain's prefix. */
  ss58: string;
  /** 0x-prefixed 32-byte AccountId. */
  accountId: Hex;
}

const H160_RE = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT32_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Accepts an SS58 address (must use the chain prefix) or a 0x 32-byte AccountId.
 * Rejects H160 addresses: native pallets (Assets, Balances, Contracts) take AccountId32.
 */
export function parseNativeAddress(
  value: unknown,
  ss58Prefix: number,
  path: string,
  issues: CompileIssue[],
): NativeAddress | undefined {
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ code: "ADDRESS_INVALID", path, message: "address must be a non-empty string" });
    return undefined;
  }
  if (H160_RE.test(value)) {
    issues.push({
      code: "ADDRESS_TYPE",
      path,
      message:
        "this is a 20-byte H160 address; native calls need an AccountId32 (SS58 or 0x + 64 hex). H160 is only valid for revive.call",
    });
    return undefined;
  }
  if (ACCOUNT32_RE.test(value)) {
    const bytes = hexToU8a(value);
    return { ss58: encodeAddress(bytes, ss58Prefix), accountId: u8aToHex(bytes) as Hex };
  }
  if (value.startsWith("0x")) {
    issues.push({
      code: "ADDRESS_INVALID",
      path,
      message: "hex address must be 0x + 64 hex chars (AccountId32)",
    });
    return undefined;
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeAddress(value);
  } catch (e) {
    issues.push({
      code: "ADDRESS_INVALID",
      path,
      message: `not a valid SS58 address (${(e as Error).message})`,
    });
    return undefined;
  }
  if (bytes.length !== 32) {
    issues.push({
      code: "ADDRESS_TYPE",
      path,
      message: `SS58 address decodes to ${bytes.length} bytes; an AccountId32 is required`,
    });
    return undefined;
  }
  const [ok, err] = checkAddress(value, ss58Prefix);
  if (!ok) {
    issues.push({
      code: "SS58_PREFIX",
      path,
      message: `wrong SS58 prefix for this chain (expected ${ss58Prefix}): ${err ?? "mismatch"}`,
    });
    return undefined;
  }
  return { ss58: value, accountId: u8aToHex(bytes) as Hex };
}

/** Accepts only a 0x 20-byte H160 address (revive.call targets). Returns it lowercased. */
export function parseH160(value: unknown, path: string, issues: CompileIssue[]): Hex | undefined {
  if (typeof value === "string" && H160_RE.test(value)) return value.toLowerCase() as Hex;
  issues.push({
    code: "ADDRESS_TYPE",
    path,
    message: "revive.call needs a 20-byte H160 contract address (0x + 40 hex chars)",
  });
  return undefined;
}
