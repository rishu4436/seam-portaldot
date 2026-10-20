import {
  computeFingerprintDigest,
  factsFromMetadata,
  needsPinnedTypes,
  NO_PINNED_TYPES,
  type AtomicRollbackProof,
  type BatchAllRollback,
  type Hex,
  type RuntimeFacts,
} from "@seam/compiler/facts";
import { SeamChainError } from "./errors.js";
import { metadataLayoutHash, pinMetadata } from "./metadata-layout.js";
import { quietly } from "./quiet.js";
import type { ChainInputs, ChainPropertiesJson, FreshFingerprint } from "./types.js";

/**
 * The pure part of discovery: chain inputs -> RuntimeFacts and fingerprint. No node builtins and no network, so the node
 * entry (discover.ts, which supplies the pinned types file from disk by default) and the browser entry share it.
 */

/** Options that shape the facts (everything except connection settings). */
export interface FactsOptions {
  /** Exact text of the pinned types file. Default: the compiler's Portaldot spec 1002 file. */
  typesBundle?: string;
  /** Behaviour metadata cannot show. Default 'unknown' (see @seam/compiler). */
  batchAllRollback?: BatchAllRollback;
  /** Evidence for batchAllRollback 'verified' (a rollback test run on this runtime). Without a matching proof the compiler will not plan atomic_verified. */
  batchAllRollbackProof?: AtomicRollbackProof;
  /**
   * Token symbol/decimals declared by the caller for a chain whose system_properties omit them
   * (e.g. substrate-contracts-node --dev returns {}). Used only when the node reports nothing;
   * if the node does report a value and it differs, discovery fails. Never filled in by SEAM itself.
   */
  declaredToken?: { tokenSymbol: string; tokenDecimals: number };
  /**
   * The metadata a plan/approval was prepared with (facts.source.metadataHex). When the node's metadata differs from
   * it ONLY in storage default values (see metadataLayoutHash), discovery keeps these pinned bytes, so the
   * fingerprint and its digest stay the same and the runtime lock does not trip on V3's state-dependent
   * Revive.EthBlockBuilderIR fallback. Any other difference keeps the live bytes, so the lock blocks as before.
   */
  pinnedMetadataHex?: Hex;
}

/**
 * The types bundle text to use. Metadata V14+ ignores it (the compiler records NO_PINNED_TYPES), so none is needed;
 * metadata V13 and older must be given the pinned file, never a guess.
 */
function typesBundleFor(metadataHex: string, given: string | undefined): string {
  if (given !== undefined) return given;
  let legacy: boolean;
  try {
    legacy = needsPinnedTypes(metadataHex);
  } catch (e) {
    throw new SeamChainError("FACTS_MISMATCH", (e as Error).message);
  }
  if (legacy)
    throw new SeamChainError(
      "NODE_MISSING_VALUE",
      "metadata V13 or older needs the pinned types file (typesBundle); SEAM will not guess it",
    );
  return NO_PINNED_TYPES;
}

function first<T>(v: T | T[] | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Token symbol and decimals from system_properties. Missing values are an error, never guessed,
 * unless the caller explicitly declares them (declared values must agree with anything the node reports).
 */
export function tokenInfo(
  properties: ChainPropertiesJson,
  declared?: { tokenSymbol: string; tokenDecimals: number },
): { tokenSymbol: string; tokenDecimals: number } {
  const reportedSymbol = first(properties.tokenSymbol);
  const reportedDecimals = first(properties.tokenDecimals);
  if (declared) {
    if (reportedSymbol !== undefined && reportedSymbol !== declared.tokenSymbol) {
      throw new SeamChainError(
        "FACTS_MISMATCH",
        `declared tokenSymbol ${declared.tokenSymbol} but the node reports ${String(reportedSymbol)}`,
      );
    }
    if (reportedDecimals !== undefined && reportedDecimals !== declared.tokenDecimals) {
      throw new SeamChainError(
        "FACTS_MISMATCH",
        `declared tokenDecimals ${declared.tokenDecimals} but the node reports ${String(reportedDecimals)}`,
      );
    }
  }
  const tokenSymbol = reportedSymbol ?? declared?.tokenSymbol;
  const tokenDecimals = reportedDecimals ?? declared?.tokenDecimals;
  if (typeof tokenSymbol !== "string" || tokenSymbol.length === 0) {
    throw new SeamChainError(
      "NODE_MISSING_VALUE",
      "system_properties has no tokenSymbol; SEAM will not guess it",
    );
  }
  if (typeof tokenDecimals !== "number" || !Number.isSafeInteger(tokenDecimals)) {
    throw new SeamChainError(
      "NODE_MISSING_VALUE",
      "system_properties has no tokenDecimals; SEAM will not guess it",
    );
  }
  return { tokenSymbol, tokenDecimals };
}

/** Whether each token fact came from the node ('observed') or only from the caller's declaration. */
export function tokenProvenanceOf(properties: ChainPropertiesJson): {
  tokenSymbol: "declared" | "observed";
  tokenDecimals: "declared" | "observed";
} {
  return {
    tokenSymbol: first(properties.tokenSymbol) !== undefined ? "observed" : "declared",
    tokenDecimals: first(properties.tokenDecimals) !== undefined ? "observed" : "declared",
  };
}

/** Inputs with the pinned metadata bytes when the live ones differ only in storage defaults (see pinMetadata). */
export function pinnedInputs(inputs: ChainInputs, pinnedMetadataHex?: Hex): ChainInputs {
  if (!pinnedMetadataHex || inputs.metadataDrift) return inputs;
  const { metadataHex, drift } = pinMetadata(inputs.metadataHex, pinnedMetadataHex);
  return drift ? { ...inputs, metadataHex, metadataDrift: drift } : inputs;
}

/**
 * Pure: chain inputs -> the compiler's RuntimeFacts. specName/specVersion/transactionVersion/ss58Prefix
 * from the node are passed to factsFromMetadata, which throws if they disagree with the metadata itself.
 */
export function factsFromChainInputs(inputs: ChainInputs, opts: FactsOptions = {}): RuntimeFacts {
  inputs = pinnedInputs(inputs, opts.pinnedMetadataHex);
  const { tokenSymbol, tokenDecimals } = tokenInfo(inputs.properties, opts.declaredToken);
  const input: Parameters<typeof factsFromMetadata>[0] = {
    metadataHex: inputs.metadataHex,
    typesBundle: typesBundleFor(inputs.metadataHex, opts.typesBundle),
    genesisHash: inputs.genesisHash,
    tokenSymbol,
    tokenDecimals,
    specName: inputs.runtimeVersion.specName,
    specVersion: inputs.runtimeVersion.specVersion,
    transactionVersion: inputs.runtimeVersion.transactionVersion,
    blockNumber: inputs.head.number,
    // Recorded so the compiler's audit checks can see how each fact was learned. Substrate-style chains sign with AccountId32.
    tokenProvenance: tokenProvenanceOf(inputs.properties),
    signingAccountBytes: 32,
  };
  const sv = (inputs.runtimeVersion as { stateVersion?: unknown }).stateVersion;
  if (typeof sv === "number" && Number.isInteger(sv) && sv >= 0) input.stateVersion = sv;
  if (typeof inputs.properties.ss58Format === "number")
    input.ss58Prefix = inputs.properties.ss58Format;
  if (opts.batchAllRollback) input.batchAllRollback = opts.batchAllRollback;
  if (opts.batchAllRollbackProof) input.batchAllRollbackProof = opts.batchAllRollbackProof;
  if (inputs.endpoint) input.endpoint = inputs.endpoint;
  try {
    return quietly(() => factsFromMetadata(input));
  } catch (e) {
    throw new SeamChainError("FACTS_MISMATCH", (e as Error).message);
  }
}

/** Pure: chain inputs -> the nine-field fingerprint, via the compiler (so digests match byte for byte). */
export function fingerprintFromChainInputs(
  inputs: ChainInputs,
  typesBundleOrOpts?: string | FactsOptions,
): FreshFingerprint {
  const opts: FactsOptions =
    typeof typesBundleOrOpts === "string"
      ? { typesBundle: typesBundleOrOpts }
      : (typesBundleOrOpts ?? {});
  const pinned = pinnedInputs(inputs, opts.pinnedMetadataHex);
  const facts = factsFromChainInputs(pinned, opts);
  const out: FreshFingerprint = {
    fingerprint: facts.fingerprint,
    fingerprintDigest: computeFingerprintDigest(facts.fingerprint),
    atBlock: inputs.head,
    metadataLayoutHash: metadataLayoutHash(pinned.metadataHex),
  };
  if (pinned.metadataDrift) out.metadataDrift = pinned.metadataDrift;
  return out;
}
