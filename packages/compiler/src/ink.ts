/**
 * ink! message encoding from a contract's own metadata (the "ABI").
 *
 * Uses @polkadot/api-contract's Abi class, which runs fully offline and understands ink! metadata V0-V5.
 * SEAM adds strict input checking on top: every argument is validated against the ABI's type info
 * before encoding (polkadot.js would otherwise coerce many wrong values silently), and the encoded
 * data is decoded again and compared, so the plan can never record args that differ from the bytes.
 */
import { Abi } from "@polkadot/api-contract";
import { U8aFixed } from "@polkadot/types";
import { TypeDefInfo, getTypeDef } from "@polkadot/types-create";
import type { TypeDef } from "@polkadot/types-create/types";
import {
  compactAddLength,
  compactStripLength,
  stringToU8a,
  u8aToHex,
  hexToU8a,
} from "@polkadot/util";
import { encodeAddress } from "@polkadot/util-crypto";
import { NotCanonicalError, canonicalJson, digestJson, DOMAIN } from "./canonical.js";
import { parseNativeAddress } from "./address.js";
import type { CompileIssue, Hex, InkArgValue } from "./types.js";

type Registry = Abi["registry"];

export interface InkMessageEncoding {
  /** blake2b-256("seam/abi/v1" || 0x00 || canonicalJSON(abi)). */
  abiHash: Hex;
  /** The message label exactly as in the ABI (e.g. "settle"). */
  message: string;
  /** 0x + 8 hex: the first 4 bytes of `data`. */
  selector: Hex;
  /** Normalised arguments keyed by ABI label (integers as strings, accounts as SS58, bytes as hex). */
  args: Record<string, InkArgValue>;
  /** selector + SCALE-encoded args (no length prefix): the Contracts.call `data` argument. */
  data: Hex;
}

const UINT_STR_RE = /^(0|[1-9][0-9]*)$/;
const INT_STR_RE = /^(0|-?[1-9][0-9]*)$/;
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function computeAbiHash(abiJson: unknown): Hex {
  return digestJson(DOMAIN.abi, abiJson);
}

/** Loads an ink! ABI (metadata.json or a .contract bundle). Throws with a readable message. */
export function loadInkAbi(abiJson: unknown): Abi {
  if (!isObj(abiJson)) throw new Error("the ABI must be a JSON object (ink! metadata.json)");
  const abi = new Abi(abiJson as Record<string, unknown>);
  if ((abi as unknown as { isRevive?: boolean }).isRevive) {
    throw new Error(
      "this ABI is for pallet-revive (H160 / Solidity-style); contracts.call needs an ink! pallet-contracts ABI",
    );
  }
  return abi;
}

interface Normalised {
  norm: InkArgValue;
  enc: unknown;
}

class ArgError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/** Classifies a named (Plain) ink! type by the polkadot.js codec it resolves to. */
type PlainKind =
  | { kind: "int"; signed: boolean; bits: number }
  | { kind: "account" }
  | { kind: "fixed"; len: number }
  | { kind: "bool" | "text" | "bytes" | "null" }
  | { kind: "other"; raw: string };

function plainKind(registry: Registry, type: string): PlainKind {
  const inst = registry.createType(type as any) as any;
  const raw: string = inst.toRawType();
  if (raw === "AccountId" || raw === "AccountId32") return { kind: "account" };
  if (
    typeof inst.isUnsigned === "boolean" &&
    typeof inst.toBigInt === "function" &&
    typeof inst.bitLength === "function"
  ) {
    return { kind: "int", signed: !inst.isUnsigned, bits: inst.bitLength() };
  }
  if (inst instanceof U8aFixed) return { kind: "fixed", len: inst.length };
  if (raw === "bool") return { kind: "bool" };
  if (raw === "Text" || raw === "String" || raw === "Str") return { kind: "text" };
  if (raw === "Bytes") return { kind: "bytes" };
  if (raw === "Null" || raw === "()") return { kind: "null" };
  return { kind: "other", raw };
}

function normInt(
  v: unknown,
  signed: boolean,
  bits: number,
  path: string,
  typeName: string,
): Normalised {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v))
      throw new ArgError(
        path,
        `${typeName} needs a whole number; use a string of digits for large values (got ${v})`,
      );
    s = String(v);
  } else if (typeof v === "string" && (signed ? INT_STR_RE : UINT_STR_RE).test(v)) {
    s = v;
  } else {
    throw new ArgError(
      path,
      `${typeName} needs ${signed ? "an integer" : "a non-negative integer"} as a string of digits (no decimals, no leading zeros)`,
    );
  }
  const n = BigInt(s);
  const [min, max] = signed
    ? [-(1n << BigInt(bits - 1)), (1n << BigInt(bits - 1)) - 1n]
    : [0n, (1n << BigInt(bits)) - 1n];
  if (n < min || n > max)
    throw new ArgError(path, `${s} does not fit ${typeName} (${signed ? "i" : "u"}${bits})`);
  return { norm: s, enc: s };
}

function normHexBytes(v: unknown, path: string, typeName: string, len?: number): Normalised {
  if (typeof v !== "string" || !HEX_RE.test(v))
    throw new ArgError(path, `${typeName} needs 0x-prefixed hex bytes`);
  const bytes = (v.length - 2) / 2;
  if (len !== undefined && bytes !== len)
    throw new ArgError(path, `${typeName} needs exactly ${len} bytes, got ${bytes}`);
  const h = v.toLowerCase();
  return { norm: h, enc: h };
}

function isU8(def: TypeDef | undefined): boolean {
  return !!def && def.info === TypeDefInfo.Plain && def.type === "u8";
}

function normalise(
  registry: Registry,
  def: TypeDef,
  v: unknown,
  path: string,
  ss58Prefix: number,
): Normalised {
  switch (def.info) {
    case TypeDefInfo.Plain:
    case TypeDefInfo.Si: {
      const name = def.lookupName ?? def.type;
      const k = plainKind(registry, name);
      switch (k.kind) {
        case "int":
          return normInt(v, k.signed, k.bits, path, name);
        case "fixed":
          return normHexBytes(v, path, name, k.len);
        case "bytes":
          return normHexBytes(v, path, name);
        case "bool":
          if (typeof v !== "boolean") throw new ArgError(path, `${name} needs true or false`);
          return { norm: v, enc: v };
        case "text":
          if (typeof v !== "string") throw new ArgError(path, `${name} needs a string`);
          // Pass SCALE bytes: polkadot.js would read a "0x..." string as hex instead of text.
          return { norm: v, enc: compactAddLength(stringToU8a(v)) };
        case "account": {
          const issues: CompileIssue[] = [];
          const a = parseNativeAddress(v, ss58Prefix, path, issues);
          if (!a) throw new ArgError(path, `${name}: ${issues[0]?.message ?? "invalid address"}`);
          return { norm: a.ss58, enc: a.accountId };
        }
        case "null":
          if (v !== null) throw new ArgError(path, `${name} takes no value; use null`);
          return { norm: null, enc: null };
        case "other": {
          if (k.raw !== name && k.raw.length > 0) {
            // A named alias of a composite type: describe it and recurse.
            const inner = getTypeDef(k.raw);
            if (!(inner.info === TypeDefInfo.Plain && inner.type === name))
              return normalise(registry, inner, v, path, ss58Prefix);
          }
          throw new ArgError(path, `SEAM cannot encode ink! type ${name} (${k.raw}) yet`);
        }
      }
    }
    case TypeDefInfo.Compact: {
      const sub = def.sub as TypeDef;
      const k = plainKind(registry, sub.lookupName ?? sub.type);
      if (k.kind !== "int") throw new ArgError(path, `SEAM cannot encode Compact<${sub.type}> yet`);
      return normInt(v, k.signed, k.bits, path, `Compact<${sub.type}>`);
    }
    case TypeDefInfo.Option: {
      if (v === null) return { norm: null, enc: null };
      const inner = normalise(registry, def.sub as TypeDef, v, path, ss58Prefix);
      return inner;
    }
    case TypeDefInfo.Struct: {
      const subs = def.sub as TypeDef[];
      if (!isObj(v))
        throw new ArgError(
          path,
          `${def.lookupName ?? "struct"} needs an object with fields ${subs.map((s) => s.name).join(", ")}`,
        );
      const names = subs.map((s) => s.name!);
      for (const k of Object.keys(v))
        if (!names.includes(k))
          throw new ArgError(`${path}.${k}`, `unknown field "${k}"; expected ${names.join(", ")}`);
      const norm: Record<string, InkArgValue> = {};
      const enc: unknown[] = [];
      for (const s of subs) {
        if (!(s.name! in v)) throw new ArgError(`${path}.${s.name}`, `missing field "${s.name}"`);
        const r = normalise(registry, s, v[s.name!], `${path}.${s.name}`, ss58Prefix);
        norm[s.name!] = r.norm;
        enc.push(r.enc);
      }
      return { norm, enc };
    }
    case TypeDefInfo.Tuple: {
      const subs = def.sub as TypeDef[];
      if (!Array.isArray(v) || v.length !== subs.length)
        throw new ArgError(path, `tuple ${def.type} needs an array of ${subs.length} items`);
      const rs = subs.map((s, i) => normalise(registry, s, v[i], `${path}[${i}]`, ss58Prefix));
      return { norm: rs.map((r) => r.norm), enc: rs.map((r) => r.enc) };
    }
    case TypeDefInfo.Vec:
    case TypeDefInfo.VecFixed: {
      const sub = def.sub as TypeDef;
      const len = def.info === TypeDefInfo.VecFixed ? def.length : undefined;
      if (isU8(sub)) return normHexBytes(v, path, def.type, len);
      if (!Array.isArray(v)) throw new ArgError(path, `${def.type} needs an array`);
      if (len !== undefined && v.length !== len)
        throw new ArgError(path, `${def.type} needs exactly ${len} items, got ${v.length}`);
      const rs = v.map((x, i) => normalise(registry, sub, x, `${path}[${i}]`, ss58Prefix));
      return { norm: rs.map((r) => r.norm), enc: rs.map((r) => r.enc) };
    }
    case TypeDefInfo.Enum: {
      const subs = def.sub as TypeDef[];
      const names = subs.map((s) => s.name!);
      let variant: string;
      let inner: unknown = null;
      if (typeof v === "string") variant = v;
      else if (isObj(v) && Object.keys(v).length === 1) [variant, inner] = Object.entries(v)[0]!;
      else
        throw new ArgError(
          path,
          `${def.lookupName ?? "enum"} needs a variant name or { Variant: value }; variants: ${names.join(", ")}`,
        );
      const sub = subs.find((s) => s.name === variant);
      if (!sub)
        throw new ArgError(
          path,
          `unknown variant "${variant}"; expected one of ${names.join(", ")}`,
        );
      if (sub.type === "Null") {
        if (inner !== null) throw new ArgError(path, `variant ${variant} takes no value`);
        return { norm: variant, enc: { [variant]: null } };
      }
      const r = normalise(registry, sub, inner, `${path}.${variant}`, ss58Prefix);
      return { norm: { [variant]: r.norm }, enc: { [variant]: r.enc } };
    }
    default:
      throw new ArgError(
        path,
        `SEAM cannot encode ink! type ${def.type} (${TypeDefInfo[def.info]}) yet`,
      );
  }
}

/** Codec -> the same normalised form as `normalise`, used to prove the bytes say what the plan says. */
function fromCodec(registry: Registry, def: TypeDef, c: any, ss58Prefix: number): InkArgValue {
  switch (def.info) {
    case TypeDefInfo.Plain:
    case TypeDefInfo.Si: {
      const k = plainKind(registry, def.lookupName ?? def.type);
      switch (k.kind) {
        case "int":
          return c.toBigInt().toString();
        case "fixed":
        case "bytes":
          return u8aToHex(c.toU8a(true));
        case "bool":
          return c.isTrue;
        case "text":
          return c.toString();
        case "account":
          return encodeAddress(c.toU8a(), ss58Prefix);
        case "null":
          return null;
        case "other":
          return fromCodec(registry, getTypeDef(k.raw), c, ss58Prefix);
      }
    }
    case TypeDefInfo.Compact:
      return c.unwrap().toBigInt().toString();
    case TypeDefInfo.Option:
      return c.isNone ? null : fromCodec(registry, def.sub as TypeDef, c.unwrap(), ss58Prefix);
    case TypeDefInfo.Struct: {
      const subs = def.sub as TypeDef[];
      const vals = [...c.values()];
      return Object.fromEntries(
        subs.map((s, i) => [s.name!, fromCodec(registry, s, vals[i], ss58Prefix)]),
      );
    }
    case TypeDefInfo.Tuple:
      return (def.sub as TypeDef[]).map((s, i) => fromCodec(registry, s, c[i], ss58Prefix));
    case TypeDefInfo.Vec:
    case TypeDefInfo.VecFixed: {
      const sub = def.sub as TypeDef;
      if (isU8(sub)) return u8aToHex(c.toU8a(true));
      return [...c].map((x: unknown) => fromCodec(registry, sub, x, ss58Prefix));
    }
    case TypeDefInfo.Enum: {
      const sub = (def.sub as TypeDef[]).find((s, i) => (s.index ?? i) === c.index)!;
      return sub.type === "Null"
        ? sub.name!
        : { [sub.name!]: fromCodec(registry, sub, c.value, ss58Prefix) };
    }
    default:
      throw new Error(`cannot decode ink! type ${def.type}`);
  }
}

function messageSpecs(abi: Abi): { label: string; args: string[] }[] {
  return (abi.metadata.spec.messages as any).map((m: any) => ({
    label: m.label.toString(),
    args: m.args.map((a: any) => a.label.toString()),
  }));
}

/**
 * Encodes one ink! message call. Pushes coded issues (with paths under `base`) and returns undefined on error.
 * `base` is e.g. "actions[1].args".
 */
export function encodeInkMessage(
  abiJson: unknown,
  message: unknown,
  args: unknown,
  value: string | undefined,
  ss58Prefix: number,
  base: string,
  issues: CompileIssue[],
  abiPath = `${base}.abi`,
): InkMessageEncoding | undefined {
  let abiHash: Hex;
  try {
    abiHash = computeAbiHash(abiJson);
  } catch (e) {
    const msg =
      e instanceof NotCanonicalError
        ? `ABI JSON is not canonicalisable at ${e.path}: ${e.message}`
        : (e as Error).message;
    issues.push({ code: "ABI_INVALID", path: abiPath, message: msg });
    return undefined;
  }
  let abi: Abi;
  try {
    abi = loadInkAbi(abiJson);
  } catch (e) {
    issues.push({
      code: "ABI_INVALID",
      path: abiPath,
      message: `not a usable ink! ABI: ${(e as Error).message}`,
    });
    return undefined;
  }
  if (typeof message !== "string" || message.length === 0) {
    issues.push({
      code: "ABI_MESSAGE_UNKNOWN",
      path: `${base}.message`,
      message: 'message must be the ink! message label, e.g. "settle"',
    });
    return undefined;
  }
  const specs = messageSpecs(abi);
  const idx = specs.findIndex((s) => s.label === message);
  if (idx < 0) {
    const isCtor = (abi.metadata.spec.constructors as any).some(
      (c: any) => c.label.toString() === message,
    );
    issues.push({
      code: "ABI_MESSAGE_UNKNOWN",
      path: `${base}.message`,
      message: `${isCtor ? `"${message}" is a constructor, not a message` : `the ABI has no message "${message}"`}; messages: ${specs.map((s) => s.label).join(", ") || "(none)"}`,
    });
    return undefined;
  }
  const spec = specs[idx]!;
  const msg = abi.messages[idx]!;
  if (value !== undefined && value !== "0" && !msg.isPayable) {
    issues.push({
      code: "ABI_ARGS_INVALID",
      path: `${base}.value`,
      message: `message "${message}" is not payable, so value must be "0" (the contract would reject it)`,
    });
    return undefined;
  }

  // Positional array or object keyed by ABI label.
  const argsPath = `${base}.args`;
  let ordered: unknown[];
  if (args === undefined) ordered = [];
  else if (Array.isArray(args)) ordered = args;
  else if (isObj(args)) {
    const extra = Object.keys(args).filter((k) => !spec.args.includes(k));
    if (extra.length) {
      issues.push({
        code: "ABI_ARGS_INVALID",
        path: `${argsPath}.${extra[0]}`,
        message: `message "${message}" has no argument "${extra[0]}"; it takes (${spec.args.join(", ") || "nothing"})`,
      });
      return undefined;
    }
    const missing = spec.args.filter((k) => !(k in args));
    if (missing.length) {
      issues.push({
        code: "ABI_ARGS_INVALID",
        path: `${argsPath}.${missing[0]}`,
        message: `missing argument "${missing[0]}" for message "${message}" (${spec.args.join(", ")})`,
      });
      return undefined;
    }
    ordered = spec.args.map((k) => args[k]);
  } else {
    issues.push({
      code: "ABI_ARGS_INVALID",
      path: argsPath,
      message: "args must be an object keyed by argument name, or an array in ABI order",
    });
    return undefined;
  }
  if (ordered.length !== spec.args.length) {
    issues.push({
      code: "ABI_ARGS_INVALID",
      path: argsPath,
      message: `message "${message}" takes ${spec.args.length} argument(s) (${spec.args.join(", ") || "none"}), got ${ordered.length}`,
    });
    return undefined;
  }

  const norm: Record<string, InkArgValue> = {};
  const enc: unknown[] = [];
  try {
    msg.args.forEach((a, i) => {
      const label = spec.args[i]!;
      const p = Array.isArray(args) ? `${argsPath}[${i}]` : `${argsPath}.${label}`;
      const r = normalise(abi.registry, a.type, ordered[i], p, ss58Prefix);
      norm[label] = r.norm;
      enc.push(r.enc);
    });
  } catch (e) {
    if (e instanceof ArgError) {
      issues.push({ code: "ABI_ARGS_INVALID", path: e.path, message: e.message });
      return undefined;
    }
    throw e;
  }

  let data: Hex;
  try {
    const withLen = msg.toU8a(enc as any);
    data = u8aToHex(compactStripLength(withLen)[1]) as Hex;
    // Round trip: the bytes must decode to the same message and the same normalised args.
    const d = abi.decodeMessage(withLen);
    if (d.message.identifier !== msg.identifier)
      throw new Error("round-trip decoded a different message");
    const back: Record<string, InkArgValue> = {};
    d.args.forEach(
      (c, i) => (back[spec.args[i]!] = fromCodec(abi.registry, msg.args[i]!.type, c, ss58Prefix)),
    );
    if (canonicalJson(back) !== canonicalJson(norm))
      throw new Error(`round-trip mismatch: ${canonicalJson(back)} != ${canonicalJson(norm)}`);
  } catch (e) {
    issues.push({
      code: "ENCODE_FAILED",
      path: argsPath,
      message: `could not encode ink! message "${message}": ${(e as Error).message}`,
    });
    return undefined;
  }
  return { abiHash, message, selector: msg.selector.toHex() as Hex, args: norm, data };
}

/**
 * Decodes Contracts.call `data` (selector + SCALE args, no length prefix) with an ABI, into the same
 * normalised form the plan records. Useful for explainers, receipts and policy checks.
 */
export function decodeInkMessage(
  abiJson: unknown,
  data: Hex,
  ss58Prefix: number,
): { message: string; selector: Hex; args: Record<string, InkArgValue> } {
  const abi = loadInkAbi(abiJson);
  const d = abi.decodeMessage(compactAddLength(hexToU8a(data)));
  const idx = abi.messages.findIndex((m) => m.identifier === d.message.identifier);
  const spec = messageSpecs(abi)[idx]!;
  const args: Record<string, InkArgValue> = {};
  d.args.forEach(
    (c, i) =>
      (args[spec.args[i]!] = fromCodec(abi.registry, d.message.args[i]!.type, c, ss58Prefix)),
  );
  return { message: spec.label, selector: d.message.selector.toHex() as Hex, args };
}
