import type { Fingerprint } from "./types.js";

/** Fingerprint fields the lock compares one by one, so a block can name exactly what changed. */
export const LOCKED_FIELDS = [
  "genesisHash", "specName", "specVersion", "transactionVersion", "metadataHash",
  "metadataVersion", "typesFileHash", "ss58Prefix", "tokenSymbol", "tokenDecimals",
] as const satisfies readonly (keyof Fingerprint)[];

export interface LockResult { ok: boolean; changed: string[]; reason: string }

const LABELS: Record<string, string> = {
  genesisHash: "the chain itself (genesis hash)",
  specName: "the runtime name",
  specVersion: "the runtime version (a runtime upgrade)",
  transactionVersion: "the transaction format version",
  metadataHash: "the runtime metadata",
  metadataVersion: "the metadata format version",
  typesFileHash: "the pinned type definitions file",
  ss58Prefix: "the address prefix",
  tokenSymbol: "the token symbol",
  tokenDecimals: "the token decimals",
  digest: "the fingerprint digest",
};

/**
 * Runtime lock: compares the fingerprint a plan was prepared against with the one read from the node now.
 * Any difference blocks; the app must rediscover, recompile, re-run preflight and get a new approval.
 * Signed extensions on Portaldot don't include CheckMetadataHash, so this is the only guard against a
 * metadata change that keeps the same spec version.
 */
export function checkRuntimeLock(prepared: Fingerprint, current: Fingerprint): LockResult {
  const changed: string[] = LOCKED_FIELDS.filter((k) => prepared[k] !== current[k]);
  if (changed.length === 0 && prepared.digest !== current.digest) changed.push("digest");
  if (changed.length === 0) return { ok: true, changed, reason: "runtime unchanged since the plan was prepared" };
  return {
    ok: false,
    changed,
    reason: `Blocked: ${changed.map((k) => LABELS[k] ?? k).join(", ")} changed since this plan was prepared. ` +
      "Rediscover the runtime, recompile, run preflight again and get a new approval.",
  };
}
