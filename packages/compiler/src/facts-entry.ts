/**
 * `@seam/compiler/facts`: the pure facts path (metadata in, RuntimeFacts and fingerprint digest out) with no node builtins,
 * so a browser bundle can build exactly the facts the node entry builds. Same function objects as the main entry.
 * The pinned types file is not read here; pass its text (needed only for metadata V13 and older).
 */
export * from "./types.js";
export {
  factsFromMetadata,
  computeFingerprintDigest,
  readCapabilities,
  SEAM_CAPABILITIES,
  type FactsFromMetadataInput,
} from "./facts.js";
export {
  metadataVersionOf,
  needsPinnedTypes,
  NO_PINNED_TYPES,
  parsePinnedTypes,
  type PinnedTypes,
} from "./runtime.js";
export { metadataLayoutHash, BLANKED_STORAGE_DEFAULTS } from "./layout.js";
