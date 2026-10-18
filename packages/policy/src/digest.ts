import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Hex } from "./types.js";

/**
 * Canonical JSON, the same rules as Bot 2's compiler: keys sorted, no whitespace, undefined keys dropped,
 * undefined array items become null, and only safe integers allowed as numbers (amounts are strings).
 */
export function canonicalJson(value: unknown, path = "$"): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value))
        throw new TypeError(
          `${path}: number ${value} is not a safe integer; use a base-unit string`,
        );
      return String(value);
    case "object": {
      if (Array.isArray(value))
        return (
          "[" +
          value
            .map((v, i) => canonicalJson(v === undefined ? null : v, `${path}[${i}]`))
            .join(",") +
          "]"
        );
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return (
        "{" +
        keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k], `${path}.${k}`)).join(",") +
        "}"
      );
    }
    default:
      throw new TypeError(`${path}: ${typeof value} cannot be canonicalised`);
  }
}

/** blake2b-256( utf8(domain) || 0x00 || utf8(canonical json) ), the team-wide hashing rule. */
export function digest(domain: string, value: unknown): Hex {
  const d = utf8ToBytes(domain);
  const body = utf8ToBytes(canonicalJson(value));
  const buf = new Uint8Array(d.length + 1 + body.length);
  buf.set(d);
  buf.set(body, d.length + 1);
  return ("0x" + bytesToHex(blake2b(buf, { dkLen: 32 }))) as Hex;
}
