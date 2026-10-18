import type { Hex, RuntimeFingerprint } from "./types.js";
import { digest } from "./digest.js";

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
): LockResult {
  const changed: string[] = LOCKED_FIELDS.filter(
    (k) => String(prepared[k]).toLowerCase() !== String(current[k]).toLowerCase(),
  );
  if (changed.length === 0)
    return { ok: true, changed, reason: "runtime unchanged since the plan was prepared" };
  return {
    ok: false,
    changed,
    reason:
      `Blocked: ${changed.map((k) => LABELS[k] ?? k).join(", ")} changed since this plan was prepared. ` +
      "Rediscover the runtime, recompile, run preflight again and get a new approval.",
  };
}
