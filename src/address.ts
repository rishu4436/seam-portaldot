import { blake2b } from "@noble/hashes/blake2b";
import { utf8ToBytes, hexToBytes, bytesToHex } from "@noble/hashes/utils";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SS58_PRE = utf8ToBytes("SS58PRE");

function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = hex ? hexToBytes(hex) : new Uint8Array();
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  let n = BigInt("0x" + (bytesToHex(bytes) || "0"));
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}

function checksum(data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(SS58_PRE.length + data.length);
  buf.set(SS58_PRE);
  buf.set(data, SS58_PRE.length);
  return blake2b(buf, { dkLen: 64 }).slice(0, 2);
}

export interface Ss58Decoded { prefix: number; publicKey: Uint8Array }

/** Decodes a 32-byte-account SS58 address (1- or 2-byte prefix) and checks its checksum. */
export function decodeSs58(address: string): Ss58Decoded | { error: string } {
  const raw = base58Decode(address);
  if (!raw || raw.length < 3) return { error: "not valid base58" };
  let prefix: number;
  let prefixLen: number;
  if (raw[0] < 64) { prefix = raw[0]; prefixLen = 1; }
  else if (raw[0] < 128) {
    const lower = ((raw[0] & 0x3f) << 2) | (raw[1] >> 6);
    const upper = raw[1] & 0x3f;
    prefix = lower | (upper << 8);
    prefixLen = 2;
  } else return { error: "reserved SS58 prefix byte" };
  if (raw.length !== prefixLen + 32 + 2) return { error: `expected a 32-byte account, got ${raw.length - prefixLen - 2} bytes` };
  const sum = checksum(raw.slice(0, prefixLen + 32));
  if (sum[0] !== raw[prefixLen + 32] || sum[1] !== raw[prefixLen + 33]) return { error: "checksum does not match" };
  return { prefix, publicKey: raw.slice(prefixLen, prefixLen + 32) };
}

/** Encodes a 32-byte public key with a simple (< 64) prefix. */
export function encodeSs58(publicKey: Uint8Array, prefix: number): string {
  if (prefix >= 64) throw new RangeError("only simple prefixes (< 64) are supported");
  const data = new Uint8Array(33);
  data[0] = prefix;
  data.set(publicKey, 1);
  const out = new Uint8Array(35);
  out.set(data);
  out.set(checksum(data), 33);
  return base58Encode(out);
}

export type AddressCheck = { ok: true; accountId: string } | { ok: false; reason: string };

/**
 * Defense in depth on a plan's addresses (the compiler checks the Manifest first). Native calls take an
 * SS58 address on this chain's prefix or a 32-byte AccountId hex; revive.call takes only H160. Prefix 42 is the
 * generic Substrate prefix, so a correct prefix proves the encoding, not that the address belongs to Portaldot;
 * the recipient allowlist does that.
 */
export function checkAddressFor(value: string, h160: boolean, chainSs58Prefix: number): AddressCheck {
  if (h160) {
    return /^0x[0-9a-fA-F]{40}$/.test(value)
      ? { ok: true, accountId: value.toLowerCase() }
      : { ok: false, reason: `"${value}" is not a 20-byte H160 address, which revive.call needs` };
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return { ok: false, reason: `"${value}" is an H160 address, but native calls need an SS58 or AccountId32 address` };
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return { ok: true, accountId: value.toLowerCase() };
  const d = decodeSs58(value);
  if ("error" in d) return { ok: false, reason: `"${value}" is not a valid address: ${d.error}` };
  if (d.prefix !== chainSs58Prefix) return { ok: false, reason: `the address uses network prefix ${d.prefix}, but this chain uses ${chainSs58Prefix}` };
  return { ok: true, accountId: "0x" + bytesToHex(d.publicKey) };
}

/** Normalizes a plain address string from a plan step (SS58, AccountId32 hex or H160 hex) to a comparable id. */
export function normalizeAccount(value: string): string | null {
  if (/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  const d = decodeSs58(value);
  return "error" in d ? null : "0x" + bytesToHex(d.publicKey);
}
