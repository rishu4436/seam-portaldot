import { blake2AsHex } from '@polkadot/util-crypto';
import { stringToU8a, u8aConcat, hexToU8a } from '@polkadot/util';
import type { Hex } from './types.js';

export const DOMAIN = {
  fingerprint: 'seam/fingerprint/v1',
  manifest: 'seam/manifest/v1',
  plan: 'seam/plan/v1',
  abi: 'seam/abi/v1'
} as const;

export class NotCanonicalError extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
  }
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order, no whitespace,
 * keys with undefined values dropped. Only integers (safe range) are allowed as numbers,
 * so floats can never sneak into a digest.
 */
export function canonicalJson(value: unknown, path = '$'): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new NotCanonicalError(path, `number ${value} is not a safe integer; use a base-unit string`);
      }
      return String(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => canonicalJson(v === undefined ? null : v, `${path}[${i}]`)).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new NotCanonicalError(path, `${typeof value} cannot be canonicalised`);
  }
}

/** blake2b-256( utf8(domain) || 0x00 || data ). */
export function domainHash(domain: string, data: Uint8Array): Hex {
  return blake2AsHex(u8aConcat(stringToU8a(domain), new Uint8Array([0]), data), 256) as Hex;
}

export function digestJson(domain: string, value: unknown): Hex {
  return domainHash(domain, stringToU8a(canonicalJson(value)));
}

/** Plain blake2b-256 (no domain), used for metadataHash and typesBundleHash. */
export function blake2_256(data: Uint8Array): Hex {
  return blake2AsHex(data, 256) as Hex;
}

export function hexBytes(hex: string): Uint8Array {
  return hexToU8a(hex);
}

export function utf8Bytes(text: string): Uint8Array {
  return stringToU8a(text);
}
