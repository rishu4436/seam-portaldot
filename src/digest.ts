import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Hex } from "./types.js";

/** Canonical JSON: object keys sorted, undefined dropped, bigint as a decimal string. Same input, same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

/** blake2b-256 over "<domain>\n<canonical json>". The domain keeps digests of different things from colliding. */
export function digest(domain: string, value: unknown): Hex {
  const bytes = utf8ToBytes(domain + "\n" + canonicalJson(value));
  return ("0x" + bytesToHex(blake2b(bytes, { dkLen: 32 }))) as Hex;
}
