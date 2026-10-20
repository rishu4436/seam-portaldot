import type { Hex, RuntimeFingerprint } from "./types.js";
import { digest } from "./digest.js";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { metadataLayoutHash } from "@seam/compiler/browser";

/** The nine fingerprint fields, in the same object shape Bot 2's compiler hashes. */
export const LOCKED_FIELDS = [
  "genesisHash",
  "specName",
  "specVersion",
  "transactionVersion",
  "metadataHash",
  "ss58Prefix",
  "tokenSymbol",
  "tokenDecimals",
  "typesBundleHash",
] as const satisfies readonly (keyof RuntimeFingerprint)[];

/** Same value as the compiler's computeFingerprintDigest. */
export function fingerprintDigest(fp: RuntimeFingerprint): Hex {
  return digest("seam/fingerprint/v1", Object.fromEntries(LOCKED_FIELDS.map((k) => [k, fp[k]])));
}

export interface LockResult {
  ok: boolean;
  changed: string[];
  reason: string;
  /** How ok was decided: "raw" (every field identical) or "layout_hash" (only metadataHash drifted, layout recomputed equal). */
  lockBasis?: "raw" | "layout_hash";
  /** Present when the layout path ran: raw hashes of the two blobs and their recomputed layout hashes. */
  preparedMetadataHash?: Hex;
  currentMetadataHash?: Hex;
  preparedLayoutHash?: Hex;
  currentLayoutHash?: Hex;
  /** Stable code: runtime_unchanged | runtime_layout_unchanged | runtime_changed. */
  code?: "runtime_unchanged" | "runtime_layout_unchanged" | "runtime_changed";
}

export interface RuntimeLockOptions {
  /** Raw metadata the plan was prepared with (the plan facts' source.metadataHex). */
  preparedMetadataHex?: string;
  /** Raw metadata just read from the node. */
  currentMetadataHex?: string;
  /**
   * Whether every signed extrinsic was decoded with CheckMetadataHash mode disabled (0). The layout path is only
   * taken when this is exactly true: with mode 1 the signature commits to the raw metadata hash, and if it is
   * unknown we can't rule that out. Omitted (direct callers) means not established, so the layout path is refused.
   */
  metadataHashModeOff?: boolean;
}

/** blake2b-256 of the raw bytes, the same hash the compiler puts in fingerprint.metadataHash. */
export function rawMetadataHash(hex: string): Hex {
  const h = hex.trim().toLowerCase();
  if (!/^0x([0-9a-f]{2})+$/.test(h)) throw new Error("metadata is not 0x hex");
  return ("0x" + bytesToHex(blake2b(hexToBytes(h.slice(2)), { dkLen: 32 }))) as Hex;
}
const LABELS: Record<string, string> = {
  genesisHash: "the chain itself (genesis hash)",
  specName: "the runtime name",
  specVersion: "the runtime version (a runtime upgrade)",
  transactionVersion: "the transaction format version",
  metadataHash: "the runtime metadata",
  ss58Prefix: "the address prefix",
  tokenSymbol: "the token symbol",
  tokenDecimals: "the token decimals",
  typesBundleHash: "the pinned type definitions file",
};

/**
 * Runtime lock: compares the fingerprint a plan was prepared against with the one read from the node now.
 * Any difference blocks; the app must rediscover, recompile, rerun preflight and get a new approval.
 * Portaldot's signed extensions have no CheckMetadataHash, so this is the only guard against a metadata
 * change that keeps the same spec version.
 */
export function checkRuntimeLock(
  prepared: RuntimeFingerprint,
  current: RuntimeFingerprint,
  opts: RuntimeLockOptions = {},
): LockResult {
  const changed: string[] = LOCKED_FIELDS.filter(
    (k) => String(prepared[k]).toLowerCase() !== String(current[k]).toLowerCase(),
  );
  if (changed.length === 0)
    return {
      ok: true,
      changed,
      reason: "runtime unchanged since the plan was prepared",
      lockBasis: "raw",
      code: "runtime_unchanged",
    };
  const blocked = (reason: string, extra: Partial<LockResult> = {}): LockResult => ({
    ok: false,
    changed,
    reason,
    code: "runtime_changed",
    ...extra,
  });
  // Layout path: ONLY metadataHash differs, both blobs given, CheckMetadataHash established off.
  if (
    changed.length === 1 &&
    changed[0] === "metadataHash" &&
    (opts.preparedMetadataHex !== undefined || opts.currentMetadataHex !== undefined)
  ) {
    const tail = " Rediscover the runtime, recompile, run preflight again and get a new approval.";
    if (!opts.preparedMetadataHex || !opts.currentMetadataHex)
      return blocked(
        "Blocked: the runtime metadata changed and both metadata blobs are needed to check its layout." +
          tail,
      );
    if (opts.metadataHashModeOff !== true)
      return blocked(
        "Blocked: the runtime metadata changed, and SEAM couldn't confirm every signed transaction has CheckMetadataHash off, so the raw metadata must match." +
          tail,
      );
    let ph: Hex, ch: Hex, pl: Hex, cl: Hex;
    try {
      ph = rawMetadataHash(opts.preparedMetadataHex);
      ch = rawMetadataHash(opts.currentMetadataHex);
    } catch (e) {
      return blocked(
        `Blocked: a metadata blob could not be read (${(e as Error).message}).` + tail,
      );
    }
    const hashes = { preparedMetadataHash: ph, currentMetadataHash: ch };
    if (
      ph !== String(prepared.metadataHash).toLowerCase() ||
      ch !== String(current.metadataHash).toLowerCase()
    )
      return blocked(
        "Blocked: a metadata blob doesn't hash to its fingerprint's metadataHash." + tail,
        hashes,
      );
    try {
      pl = metadataLayoutHash(opts.preparedMetadataHex);
      cl = metadataLayoutHash(opts.currentMetadataHex);
    } catch (e) {
      return blocked(
        `Blocked: the metadata layout could not be computed (${(e as Error).message}).` + tail,
        hashes,
      );
    }
    const all = { ...hashes, preparedLayoutHash: pl, currentLayoutHash: cl };
    if (pl !== cl)
      return blocked(`Blocked: the runtime metadata layout changed (${pl} -> ${cl}).` + tail, all);
    return {
      ok: true,
      changed,
      reason: `runtime layout unchanged: only allow-listed storage defaults drifted (metadata ${ph} -> ${ch}, layout ${pl})`,
      lockBasis: "layout_hash",
      code: "runtime_layout_unchanged",
      ...all,
    };
  }
  return {
    ok: false,
    changed,
    code: "runtime_changed",
    reason:
      `Blocked: ${changed.map((k) => LABELS[k] ?? k).join(", ")} changed since this plan was prepared. ` +
      "Rediscover the runtime, recompile, run preflight again and get a new approval.",
  };
}
